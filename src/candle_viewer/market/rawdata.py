"""Discovery and loading of raw downloaded bar files.

Raw files are CSV with the header ``timestamp,open,high,low,close`` and an
optional ``volume`` column. ``timestamp`` is the bar open time in UTC epoch
milliseconds. File names look like ``audusd-m1-bid_full.csv``.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd

from . import timeframes

PRICE_COLUMNS = ("open", "high", "low", "close")
COLUMNS = ("timestamp", *PRICE_COLUMNS)
VOLUME = "volume"
PATCHED = "patched"   # marks rows that were taken from a patch file

_NAME = re.compile(r"^(?P<symbol>[a-z0-9]+)-(?P<tf>[a-z0-9]+)-(?P<side>bid|ask)(?:[_-][^.]*)?\.csv$", re.IGNORECASE)


class RawDataError(ValueError):
    """A raw file does not have the expected layout."""


@dataclass(frozen=True)
class RawFile:
    symbol: str
    timeframe: str
    side: str
    path: Path


def discover(source_dir: Path) -> dict[str, dict[str, RawFile]]:
    """Find raw files below ``source_dir``; returns ``{symbol: {timeframe: RawFile}}``."""
    found: dict[str, dict[str, RawFile]] = {}
    for path in sorted(Path(source_dir).glob("*.csv")):
        match = _NAME.match(path.name)
        if not match or match["tf"].lower() not in timeframes.BY_NAME:
            continue
        symbol, tf = match["symbol"].lower(), match["tf"].lower()
        per_symbol = found.setdefault(symbol, {})
        if tf in per_symbol:
            raise RawDataError(f"two files for {symbol} {tf}: {per_symbol[tf].path.name} and {path.name}")
        per_symbol[tf] = RawFile(symbol, tf, match["side"].lower(), path)
    return found


def read_bars(path: Path) -> pd.DataFrame:
    """Load one raw file as a frame sorted by time with unique timestamps."""
    header = pd.read_csv(path, nrows=0).columns.tolist()
    missing = [c for c in COLUMNS if c not in header]
    if missing:
        raise RawDataError(f"{path.name}: missing columns {missing}; found {header}")
    columns = [*COLUMNS, VOLUME] if VOLUME in header else list(COLUMNS)
    numbers = dict.fromkeys(columns[1:], "float64")
    frame = pd.read_csv(path, usecols=columns, dtype={"timestamp": "int64", **numbers})[columns]
    if frame.isna().any().any():
        raise RawDataError(f"{path.name}: empty cells")
    ts = frame["timestamp"].to_numpy()
    if len(ts) and not (np.diff(ts) > 0).all():
        frame = frame.sort_values("timestamp", kind="stable").drop_duplicates("timestamp", keep="last")
    return frame.reset_index(drop=True)


def apply_patch(base: pd.DataFrame, patch: pd.DataFrame | None) -> pd.DataFrame:
    """Add the rows of ``patch`` whose minute is absent from ``base``.

    A patch holds bars obtained another way, for periods the main file lacks.
    Where both have a bar the main file wins. The result carries the boolean
    column ``patched``.
    """
    base = base.assign(**{PATCHED: False})
    if patch is None or patch.empty:
        return base
    if (VOLUME in base) != (VOLUME in patch):
        raise RawDataError("main file and patch must both have volumes or both lack them")
    extra = patch[~patch["timestamp"].isin(base["timestamp"])].assign(**{PATCHED: True})
    if extra.empty:
        return base
    return pd.concat([base, extra[base.columns]], ignore_index=True).sort_values("timestamp", kind="stable").reset_index(drop=True)


def pip_size(prices: np.ndarray) -> float:
    """Size of one pip, judged from the price level (yen pairs quote two decimals fewer)."""
    return 0.01 if float(np.median(prices)) > 20 else 0.0001
