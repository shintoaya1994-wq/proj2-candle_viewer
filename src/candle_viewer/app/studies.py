"""Research records ("studies") kept as plain files.

A study is a folder::

    study.json       chart state: panes, drawings, tag
    notes.md         the comment, readable and editable outside the application
    screenshot.png   the charts as they looked when the study was saved
    history/<time>/  what the three files held before each later save

Studies on their own live below ``<workspace>/studies/<id>``. The study of a
signal or of a touch lives in the folder of that signal or touch.

The files are the record. Nothing else needs to be kept in step with them.
"""

from __future__ import annotations

import base64
import binascii
import json
import os
import re
import secrets
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

SCHEMA = 2
STUDY_FILE, NOTES_FILE, SCREENSHOT_FILE, HISTORY = "study.json", "notes.md", "screenshot.png", "history"
_ID = re.compile(r"^[0-9]{8}-[0-9]{6}-[0-9a-f]{4}$")
_PNG = b"\x89PNG\r\n\x1a\n"
_DATA_URL = "data:image/png;base64,"
MAX_SCREENSHOT_BYTES = 30 * 1024 * 1024
MAX_PANES = 12


class StudyNotFound(LookupError):
    pass


class InvalidStudy(ValueError):
    pass


class Model(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")


class Point(Model):
    """An anchor of a drawing in chart coordinates: time, price, or both."""

    timestamp: int | None = None
    value: float | None = None


class Drawing(Model):
    id: str
    name: str                      # kind of drawing: segment, box, ...
    points: list[Point]
    symbol: str | None = None      # the symbol it belongs to; drawings show on panes of their symbol
    timeframe: str | None = None   # the timeframe it was drawn on
    styles: dict[str, Any] | None = None
    extend_data: Any = None
    lock: bool = False
    visible: bool = True
    z_level: int = 0


class Indicator(Model):
    name: str
    pane: str                      # "candle" for the price pane, otherwise a pane of its own
    params: list[float] = Field(default_factory=list)
    visible: bool = True


class View(Model):
    bar_space: float | None = None
    offset_right: float | None = None
    right_timestamp: int | None = None   # time of the last bar in view


class Pane(Model):
    """One chart of a study."""

    symbol: str
    timeframe: str
    indicators: list[Indicator] = Field(default_factory=list)
    view: View = Field(default_factory=View)


class Layout(Model):
    columns: int = Field(1, ge=1, le=4)
    rows: int = Field(1, ge=1, le=3)


class Subject(Model):
    """What a study is about."""

    kind: Literal["signal", "touch"]
    id: str


class StudyContent(Model):
    """What the application sends when it saves."""

    symbol: str
    focus: int | None = None       # the moment the study is about
    tag: str = ""
    comment: str = ""
    drawings: list[Drawing] = Field(default_factory=list)
    panes: list[Pane] = Field(min_length=1, max_length=MAX_PANES)
    layout: Layout = Field(default_factory=Layout)
    timezone: str = "UTC"
    screenshot: str | None = None  # PNG as a data URL; stored as a file of its own


class Study(StudyContent):
    id: str
    subject: Subject | None = None
    created: str
    updated: str
    has_screenshot: bool = False
    schema_version: int = SCHEMA


class Summary(Model):
    id: str
    symbol: str
    timeframes: list[str]
    focus: int | None
    tag: str
    excerpt: str
    drawings: int
    created: str
    updated: str
    has_screenshot: bool


def now() -> datetime:
    return datetime.now(timezone.utc)


def stamp(moment: datetime) -> str:
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


def write(path: Path, data: bytes) -> None:
    """Replace a file in one step, so that a crash never leaves half a file."""
    temporary = path.with_name(f".{path.name}.{secrets.token_hex(4)}.part")
    temporary.write_bytes(data)
    os.replace(temporary, path)


def write_json(path: Path, content: dict | list) -> None:
    write(path, (json.dumps(content, ensure_ascii=False, indent=1) + "\n").encode("utf-8"))


def excerpt(comment: str, length: int = 200) -> str:
    return " ".join(comment.split())[:length]


def _decode_screenshot(data_url: str) -> bytes:
    if not data_url.startswith(_DATA_URL):
        raise InvalidStudy("the screenshot must be a PNG data URL")
    try:
        image = base64.b64decode(data_url[len(_DATA_URL):], validate=True)
    except (binascii.Error, ValueError) as error:
        raise InvalidStudy("the screenshot is not valid base64") from error
    if not image.startswith(_PNG) or len(image) > MAX_SCREENSHOT_BYTES:
        raise InvalidStudy("the screenshot is not a PNG image of acceptable size")
    return image


def upgrade(stored: dict) -> dict:
    """Bring a study written by an earlier version to the present layout.

    Version 1 had a single chart, described by fields of the study itself.
    """
    if "panes" in stored:
        return stored
    upgraded = {key: value for key, value in stored.items() if key not in ("timeframe", "indicators", "view")}
    upgraded["panes"] = [{
        "symbol": stored["symbol"],
        "timeframe": stored["timeframe"],
        "indicators": stored.get("indicators", []),
        "view": stored.get("view", {}),
    }]
    upgraded["layout"] = {"columns": 1, "rows": 1}
    upgraded["drawings"] = [{"symbol": stored["symbol"], **drawing} for drawing in stored.get("drawings", [])]
    upgraded["schemaVersion"] = SCHEMA
    return upgraded


class StudyFolder:
    """The files of one study."""

    def __init__(self, path: Path) -> None:
        self.path = Path(path)

    def exists(self) -> bool:
        return (self.path / STUDY_FILE).is_file()

    def read(self) -> Study:
        stored = upgrade(json.loads((self.path / STUDY_FILE).read_text(encoding="utf-8")))
        notes = self.path / NOTES_FILE
        stored["comment"] = notes.read_text(encoding="utf-8") if notes.is_file() else ""
        stored["hasScreenshot"] = (self.path / SCREENSHOT_FILE).is_file()
        return Study.model_validate(stored)

    def screenshot(self) -> Path:
        path = self.path / SCREENSHOT_FILE
        if not path.is_file():
            raise StudyNotFound("no screenshot")
        return path

    def save(self, study_id: str, content: StudyContent, subject: Subject | None = None) -> Study:
        """Write the study; what was there before moves to the history."""
        image = _decode_screenshot(content.screenshot) if content.screenshot else None
        created = None
        if self.exists():
            created = json.loads((self.path / STUDY_FILE).read_text(encoding="utf-8"))["created"]
            self._keep_history()
        self.path.mkdir(parents=True, exist_ok=True)
        moment = stamp(now())
        stored = content.model_dump(by_alias=True, exclude={"comment", "screenshot"})
        stored.update({
            "id": study_id,
            "subject": subject.model_dump(by_alias=True) if subject else None,
            "created": created or moment,
            "updated": moment,
            "schemaVersion": SCHEMA,
        })
        write(self.path / NOTES_FILE, content.comment.encode("utf-8"))
        if image is not None:
            write(self.path / SCREENSHOT_FILE, image)
        # The study file goes last: once it is in place the save is complete.
        write_json(self.path / STUDY_FILE, stored)
        return self.read()

    def _keep_history(self) -> None:
        kept = self.path / HISTORY / f"{now():%Y%m%dT%H%M%S}-{secrets.token_hex(2)}"
        kept.mkdir(parents=True)
        for name in (STUDY_FILE, NOTES_FILE, SCREENSHOT_FILE):
            if (self.path / name).is_file():
                shutil.copy2(self.path / name, kept / name)

    def summary(self) -> Summary:
        study = self.read()
        return Summary(
            id=study.id,
            symbol=study.symbol,
            timeframes=[pane.timeframe for pane in study.panes],
            focus=study.focus,
            tag=study.tag,
            excerpt=excerpt(study.comment),
            drawings=len(study.drawings),
            created=study.created,
            updated=study.updated,
            has_screenshot=study.has_screenshot,
        )


def trash(folder: Path, root: Path) -> None:
    """Move a folder to the trash folder of ``root``; nothing is destroyed."""
    bin_ = root / ".trash"
    bin_.mkdir(parents=True, exist_ok=True)
    shutil.move(str(folder), str(bin_ / f"{folder.name}-{now():%Y%m%d%H%M%S}"))


class StudyStore:
    """Studies that stand on their own, below ``<workspace>/studies``."""

    def __init__(self, root: Path) -> None:
        self.root = Path(root)

    def _folder(self, study_id: str) -> StudyFolder:
        if not _ID.match(study_id):
            raise StudyNotFound(study_id)
        return StudyFolder(self.root / study_id)

    def _existing(self, study_id: str) -> StudyFolder:
        folder = self._folder(study_id)
        if not folder.exists():
            raise StudyNotFound(study_id)
        return folder

    def _new_id(self) -> str:
        while True:
            study_id = f"{now():%Y%m%d-%H%M%S}-{secrets.token_hex(2)}"
            if not (self.root / study_id).exists():
                return study_id

    def get(self, study_id: str) -> Study:
        return self._existing(study_id).read()

    def screenshot(self, study_id: str) -> Path:
        return self._existing(study_id).screenshot()

    def list(self) -> list[Summary]:
        """All studies, the one saved last first."""
        if not self.root.is_dir():
            return []
        found = [StudyFolder(path).summary() for path in self.root.iterdir() if _ID.match(path.name) and (path / STUDY_FILE).is_file()]
        return sorted(found, key=lambda item: (item.updated, item.id), reverse=True)

    def create(self, content: StudyContent) -> Study:
        study_id = self._new_id()
        return self._folder(study_id).save(study_id, content)

    def update(self, study_id: str, content: StudyContent) -> Study:
        return self._existing(study_id).save(study_id, content)

    def delete(self, study_id: str) -> None:
        trash(self._existing(study_id).path, self.root)
