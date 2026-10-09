"""Running screens against a dataset, keeping what they find, and checking them for looking ahead."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from ..app.signals import Anchor, NewSignal, SignalStore
from ..market import store
from .market import Market
from .model import Found
from .scripts import Screen


@dataclass
class Outcome:
    """What a run of a screen did to the signals of a symbol."""

    found: int
    created: list[str] = field(default_factory=list)
    known: int = 0


def publish(found: list[Found], signals: SignalStore, screen: Screen, symbol: str) -> Outcome:
    """Keeps what a screen found as candidate signals; findings known already are left as they are."""
    known = signals.keys(symbol, screen.name)
    outcome = Outcome(found=len(found), known=0)
    for item in found:
        if item.key in known:
            outcome.known += 1
            continue
        signal = signals.create(NewSignal(
            symbol=symbol,
            shape=item.shape,
            anchors=[Anchor(timestamp=int(ts), value=float(value)) for ts, value in item.anchors],
            timeframe=item.timeframe,
            known_at=int(item.known_at),
            models=list(item.models),
            basis="model",
            origin=screen.name,
            status="candidate",
            key=item.key,
            note=item.note,
        ))
        outcome.created.append(signal.id)
    return outcome


def run(screen: Screen, dataset: Path, symbol: str, params: dict | None = None, as_of: int | None = None) -> list[Found]:
    return screen.run(Market(dataset, as_of=as_of), symbol, params)


@dataclass
class Difference:
    cutoff: int
    kind: str          # "early": claimed knowable by the cutoff but not found on cut data; "late": found on cut data though claimed later or never; "moved": found with other anchors
    key: str
    detail: str = ""


@dataclass
class Report:
    screen: str
    symbol: str
    found: int
    cutoffs: int
    differences: list[Difference]

    @property
    def passed(self) -> bool:
        return not any(item.kind in ("early", "moved") for item in self.differences)


def _cutoffs(found: list[Found], first: int, last: int, spaced: int, sample: int) -> list[int]:
    cutoffs = {int(value) for value in np.linspace(first, last, spaced + 2)[1:-1]}
    # Around the moment a finding claims to become knowable: just before it must be absent, at it present.
    step = max(1, len(found) // sample) if found else 1
    for item in found[::step][:sample]:
        cutoffs.add(item.known_at - 1)
        cutoffs.add(item.known_at)
    return sorted(cutoffs)


def check(screen: Screen, dataset: Path, symbol: str, params: dict | None = None, spaced: int = 6, sample: int = 12) -> Report:
    """Runs the screen on cut data and compares with the full run.

    A finding the full run claims knowable by a cutoff has to be found, with
    the same anchors, when the data ends at that cutoff. Otherwise the screen
    used bars after the moment it names, which is looking ahead.
    """
    full = run(screen, dataset, symbol, params)
    by_key = {item.key: item for item in full}
    bars = Market(dataset).bars(symbol, "d1")
    first, last = int(bars.timestamp[0]), int(bars.timestamp[-1])
    differences: list[Difference] = []
    cutoffs = _cutoffs(full, first, last, spaced, sample)
    for cutoff in cutoffs:
        cut = {item.key: item for item in run(screen, dataset, symbol, params, as_of=cutoff)}
        expected = {key for key, item in by_key.items() if item.known_at <= cutoff}
        for key in sorted(expected - set(cut)):
            differences.append(Difference(cutoff, "early", key, f"claims to be knowable at {by_key[key].known_at}, not found with data up to {cutoff}"))
        for key in sorted(set(cut) - expected):
            claimed = by_key[key].known_at if key in by_key else None
            differences.append(Difference(cutoff, "late", key, "not found on the full data" if claimed is None else f"found with data up to {cutoff} but claims to be knowable only at {claimed}"))
        for key in sorted(expected & set(cut)):
            if cut[key].anchors != by_key[key].anchors:
                differences.append(Difference(cutoff, "moved", key, f"anchors {cut[key].anchors} with data up to {cutoff}, {by_key[key].anchors} on the full data"))
    return Report(screen.name, symbol, len(full), len(cutoffs), differences)


def dataset_of(workspace: Path, convention: str = "utc") -> Path:
    return store.dataset_dir(Path(workspace), convention)
