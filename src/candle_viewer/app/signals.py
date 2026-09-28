"""Signals, their touches, and the strategies thought of at a touch.

Three things are kept apart:

* A **signal** is something the market showed: a peak, a level, a line, a box.
  What is known about it changes, so it has versions; the earlier ones stay.
* A **touch** is one occasion on which price came to the signal. It points to
  the version of the signal that was valid then.
* A **strategy** is what to do at a touch: what was done at the time, what
  seems right now, what another model would say. A touch can have several.

On disk::

    <workspace>/signals/<symbol>/<signal id>/
        signal.json
        study.json, notes.md, screenshot.png, history/     the study of the signal
        touches/<touch id>/
            touch.json
            strategies.json
            study.json, notes.md, screenshot.png, history/ the study of the touch
"""

from __future__ import annotations

import json
import re
import secrets
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from pydantic import ConfigDict, Field, model_validator

from ..market import timeframes
from .studies import Model, Study, StudyContent, StudyFolder, Subject, now, stamp, trash, write_json

SIGNAL_FILE, TOUCH_FILE, STRATEGY_FILE, TOUCHES = "signal.json", "touch.json", "strategies.json", "touches"
_SYMBOL = re.compile(r"^[a-z0-9]+$")
_SIGNAL_ID = re.compile(r"^s[0-9]{12}-[0-9a-f]{4}$")
_TOUCH_ID = re.compile(r"^t[0-9]{12}-[0-9a-f]{4}$")
ANCHORS = {"point": 1, "level": 1, "segment": 2, "box": 2}
MAX_COMMENT = 4000

Shape = Literal["point", "level", "segment", "box"]
Reason = Literal["initial", "market", "review"]


class SignalNotFound(LookupError):
    pass


class InvalidSignal(ValueError):
    pass


class Anchor(Model):
    timestamp: int
    value: float


class Definition(Model):
    """What a signal looks like on the chart."""

    shape: Shape
    anchors: list[Anchor]
    timeframe: str
    known_at: int | None = None    # when the signal could first be known; often later than its anchors

    @model_validator(mode="after")
    def _consistent(self) -> "Definition":
        if len(self.anchors) != ANCHORS[self.shape]:
            raise ValueError(f"a {self.shape} has {ANCHORS[self.shape]} anchors, not {len(self.anchors)}")
        if self.timeframe not in timeframes.BY_NAME:
            raise ValueError(f"unknown timeframe {self.timeframe}")
        return self


class Version(Definition):
    version: int
    reason: Reason                 # "market": the market moved on; "review": the record was corrected
    note: str = ""
    created: str


class Relation(Model):
    kind: Literal["continues", "replaces", "related"]
    target: str


class NewSignal(Definition):
    symbol: str
    models: list[str] = Field(default_factory=list)
    basis: Literal["model", "partial", "feeling", "unset"] = "unset"
    origin: str = "manual"
    status: Literal["confirmed", "candidate", "rejected"] = "confirmed"


class NewVersion(Definition):
    reason: Literal["market", "review"]
    note: str = ""


class Changes(Model):
    """Facts about a signal that can be corrected without a new version."""

    models: list[str] | None = None
    basis: Literal["model", "partial", "feeling", "unset"] | None = None
    status: Literal["confirmed", "candidate", "rejected"] | None = None
    relations: list[Relation] | None = None
    known_at: int | None = None
    clear_known_at: bool = False


class Signal(Model):
    id: str
    symbol: str
    status: Literal["confirmed", "candidate", "rejected"]
    origin: str
    models: list[str]
    basis: Literal["model", "partial", "feeling", "unset"]    # how well the user can say why
    versions: list[Version]
    relations: list[Relation] = Field(default_factory=list)
    created: str
    updated: str

    @property
    def current(self) -> Version:
        return self.versions[-1]


class NewTouch(Model):
    timestamp: int
    value: float
    timeframe: str
    rule: str = ""
    origin: str = "manual"
    signal_version: int | None = None    # the version valid at the touch; the current one if not given


class Touch(Model):
    id: str
    signal_id: str
    signal_version: int
    symbol: str
    timestamp: int
    value: float
    timeframe: str
    rule: str = ""
    origin: str = "manual"
    created: str
    updated: str


class Strategy(Model):
    id: str
    label: str
    text: str
    created: str
    updated: str


class StrategyText(Model):
    """A strategy as the application sends it; one without an id is new."""

    model_config = ConfigDict(extra="ignore")    # what was read may be sent back as it is

    id: str | None = None
    label: str = ""
    text: str = ""


class Noted(Model):
    """What the study of a signal or a touch says, for lists and markers."""

    tag: str = ""
    comment: str = ""
    studied: bool = False
    updated: str | None = None


class TouchSummary(Touch):
    note: Noted
    strategies: int


class SignalSummary(Signal):
    note: Noted
    touches: list[TouchSummary]


def _time_id(prefix: str, timestamp: int) -> str:
    moment = datetime.fromtimestamp(timestamp / 1000, timezone.utc)
    return f"{prefix}{moment:%Y%m%d%H%M}-{secrets.token_hex(2)}"


def _hidden(path: Path, root: Path) -> bool:
    """Whether the path lies in a folder such as the trash."""
    return any(part.startswith(".") for part in path.relative_to(root).parts)


def _read(path: Path, model):
    return model.model_validate(json.loads(path.read_text(encoding="utf-8")))


def _noted(folder: Path) -> Noted:
    study = StudyFolder(folder)
    if not study.exists():
        return Noted()
    read = study.read()
    return Noted(tag=read.tag, comment=read.comment[:MAX_COMMENT], studied=True, updated=read.updated)


class SignalStore:
    def __init__(self, root: Path) -> None:
        self.root = Path(root)

    # -- finding -----------------------------------------------------------

    def _signal_folder(self, signal_id: str) -> Path:
        if _SIGNAL_ID.match(signal_id) and self.root.is_dir():
            for symbol in self.root.iterdir():
                folder = symbol / signal_id
                if not _hidden(folder, self.root) and (folder / SIGNAL_FILE).is_file():
                    return folder
        raise SignalNotFound(signal_id)

    def _touch_folder(self, touch_id: str) -> Path:
        if _TOUCH_ID.match(touch_id) and self.root.is_dir():
            for folder in self.root.glob(f"*/*/{TOUCHES}/{touch_id}"):
                if not _hidden(folder, self.root) and (folder / TOUCH_FILE).is_file():
                    return folder
        raise SignalNotFound(touch_id)

    # -- signals -----------------------------------------------------------

    def create(self, new: NewSignal) -> Signal:
        if not _SYMBOL.match(new.symbol):
            raise InvalidSignal(f"not a symbol: {new.symbol}")
        moment = stamp(now())
        definition = new.model_dump(include={"shape", "anchors", "timeframe", "known_at"})
        signal_id = _time_id("s", min(anchor.timestamp for anchor in new.anchors))
        signal = Signal(
            id=signal_id,
            symbol=new.symbol,
            status=new.status,
            origin=new.origin,
            models=new.models,
            basis=new.basis,
            versions=[Version(version=1, reason="initial", created=moment, **definition)],
            created=moment,
            updated=moment,
        )
        folder = self.root / new.symbol / signal_id
        folder.mkdir(parents=True)
        self._write(folder, signal)
        return signal

    def _write(self, folder: Path, signal: Signal) -> None:
        write_json(folder / SIGNAL_FILE, signal.model_dump(by_alias=True))

    def get(self, signal_id: str) -> SignalSummary:
        return self._summary(self._signal_folder(signal_id))

    def _summary(self, folder: Path) -> SignalSummary:
        signal = _read(folder / SIGNAL_FILE, Signal)
        touches = [self._touch_summary(path.parent) for path in (folder / TOUCHES).glob(f"*/{TOUCH_FILE}") if not _hidden(path, folder)]
        touches.sort(key=lambda touch: (touch.timestamp, touch.id))
        return SignalSummary(**signal.model_dump(), note=_noted(folder), touches=touches)

    def list(self, symbol: str | None = None) -> list[SignalSummary]:
        """Signals in the order of their first anchor."""
        if symbol is not None and not _SYMBOL.match(symbol):
            return []
        pattern = f"{symbol or '*'}/*/{SIGNAL_FILE}"
        found = [self._summary(path.parent) for path in self.root.glob(pattern) if not _hidden(path, self.root)] if self.root.is_dir() else []
        return sorted(found, key=lambda signal: (min(anchor.timestamp for anchor in signal.current.anchors), signal.id))

    def change(self, signal_id: str, changes: Changes) -> SignalSummary:
        folder = self._signal_folder(signal_id)
        signal = _read(folder / SIGNAL_FILE, Signal)
        for name in ("models", "basis", "status", "relations"):
            value = getattr(changes, name)
            if value is not None:
                setattr(signal, name, value)
        if changes.clear_known_at:
            signal.versions[-1].known_at = None
        elif changes.known_at is not None:
            signal.versions[-1].known_at = changes.known_at
        for relation in signal.relations:
            if relation.target == signal_id:
                raise InvalidSignal("a signal cannot be related to itself")
            self._signal_folder(relation.target)
        signal.updated = stamp(now())
        self._write(folder, signal)
        return self._summary(folder)

    def add_version(self, signal_id: str, new: NewVersion) -> SignalSummary:
        """Give the signal a new shape; touches keep pointing to the version they met."""
        folder = self._signal_folder(signal_id)
        signal = _read(folder / SIGNAL_FILE, Signal)
        moment = stamp(now())
        signal.versions.append(Version(version=signal.current.version + 1, created=moment, **new.model_dump()))
        signal.updated = moment
        self._write(folder, signal)
        return self._summary(folder)

    def delete(self, signal_id: str) -> None:
        trash(self._signal_folder(signal_id), self.root)

    # -- touches -----------------------------------------------------------

    def add_touch(self, signal_id: str, new: NewTouch) -> TouchSummary:
        folder = self._signal_folder(signal_id)
        signal = _read(folder / SIGNAL_FILE, Signal)
        if new.timeframe not in timeframes.BY_NAME:
            raise InvalidSignal(f"unknown timeframe {new.timeframe}")
        version = new.signal_version or signal.current.version
        if not any(known.version == version for known in signal.versions):
            raise InvalidSignal(f"signal {signal_id} has no version {version}")
        moment = stamp(now())
        touch = Touch(
            id=_time_id("t", new.timestamp),
            signal_id=signal_id,
            signal_version=version,
            symbol=signal.symbol,
            created=moment,
            updated=moment,
            **new.model_dump(exclude={"signal_version"}),
        )
        target = folder / TOUCHES / touch.id
        target.mkdir(parents=True)
        write_json(target / TOUCH_FILE, touch.model_dump(by_alias=True))
        return self._touch_summary(target)

    def _touch_summary(self, folder: Path) -> TouchSummary:
        touch = _read(folder / TOUCH_FILE, Touch)
        return TouchSummary(**touch.model_dump(), note=_noted(folder), strategies=len(self._strategies(folder)))

    def touch(self, touch_id: str) -> TouchSummary:
        return self._touch_summary(self._touch_folder(touch_id))

    def delete_touch(self, touch_id: str) -> None:
        folder = self._touch_folder(touch_id)
        trash(folder, folder.parent)

    # -- strategies --------------------------------------------------------

    def _strategies(self, folder: Path) -> list[Strategy]:
        path = folder / STRATEGY_FILE
        if not path.is_file():
            return []
        return [Strategy.model_validate(item) for item in json.loads(path.read_text(encoding="utf-8"))]

    def strategies(self, touch_id: str) -> list[Strategy]:
        return self._strategies(self._touch_folder(touch_id))

    def save_strategies(self, touch_id: str, texts: list[StrategyText]) -> list[Strategy]:
        """Replace the strategies of a touch; ones without an id are new."""
        folder = self._touch_folder(touch_id)
        known = {strategy.id: strategy for strategy in self._strategies(folder)}
        moment = stamp(now())
        saved = []
        for text in texts:
            before = known.get(text.id) if text.id else None
            if before is None:
                saved.append(Strategy(id=f"p{secrets.token_hex(3)}", label=text.label, text=text.text, created=moment, updated=moment))
            else:
                changed = (before.label, before.text) != (text.label, text.text)
                saved.append(Strategy(id=before.id, label=text.label, text=text.text, created=before.created, updated=moment if changed else before.updated))
        write_json(folder / STRATEGY_FILE, [strategy.model_dump(by_alias=True) for strategy in saved])
        return saved

    # -- studies -----------------------------------------------------------

    def _subject(self, kind: str, subject_id: str) -> tuple[StudyFolder, Subject]:
        folder = self._signal_folder(subject_id) if kind == "signal" else self._touch_folder(subject_id)
        return StudyFolder(folder), Subject(kind=kind, id=subject_id)

    def study(self, kind: str, subject_id: str) -> Study | None:
        """The study of a signal or a touch; None while nothing has been saved."""
        folder, _ = self._subject(kind, subject_id)
        return folder.read() if folder.exists() else None

    def save_study(self, kind: str, subject_id: str, content: StudyContent) -> Study:
        folder, subject = self._subject(kind, subject_id)
        return folder.save(subject_id, content, subject)

    def screenshot(self, kind: str, subject_id: str) -> Path:
        folder, _ = self._subject(kind, subject_id)
        if not folder.exists():
            raise SignalNotFound(f"{subject_id} has no study")
        return folder.screenshot()

