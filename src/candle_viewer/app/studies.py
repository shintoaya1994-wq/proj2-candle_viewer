"""Research records ("studies") kept as plain files.

Every study is a folder below ``<workspace>/studies``::

    <id>/study.json       chart state: drawings, indicators, view, tag
    <id>/notes.md         the comment, readable and editable outside the application
    <id>/screenshot.png   the chart as it looked when it was saved
    <id>/history/<time>/  what the three files held before each later save

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
from typing import Any

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

SCHEMA = 1
STUDY_FILE, NOTES_FILE, SCREENSHOT_FILE = "study.json", "notes.md", "screenshot.png"
_ID = re.compile(r"^[0-9]{8}-[0-9]{6}-[0-9a-f]{4}$")
_PNG = b"\x89PNG\r\n\x1a\n"
_DATA_URL = "data:image/png;base64,"
MAX_SCREENSHOT_BYTES = 20 * 1024 * 1024


class StudyNotFound(LookupError):
    pass


class InvalidStudy(ValueError):
    pass


class _Model(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")


class Point(_Model):
    """An anchor of a drawing in chart coordinates: time, price, or both."""

    timestamp: int | None = None
    value: float | None = None


class Drawing(_Model):
    id: str
    name: str                      # kind of drawing: segment, box, ...
    points: list[Point]
    timeframe: str | None = None   # the timeframe it was drawn on
    styles: dict[str, Any] | None = None
    extend_data: Any = None
    lock: bool = False
    visible: bool = True
    z_level: int = 0


class Indicator(_Model):
    name: str
    pane: str                      # "candle" for the price pane, otherwise a pane of its own
    params: list[float] = Field(default_factory=list)
    visible: bool = True


class View(_Model):
    bar_space: float | None = None
    offset_right: float | None = None
    right_timestamp: int | None = None   # time of the last bar in view


class StudyContent(_Model):
    """What the application sends when it saves."""

    symbol: str
    timeframe: str
    focus: int | None = None       # the moment the study is about
    tag: str = ""
    comment: str = ""
    drawings: list[Drawing] = Field(default_factory=list)
    indicators: list[Indicator] = Field(default_factory=list)
    view: View = Field(default_factory=View)
    timezone: str = "UTC"
    screenshot: str | None = None  # PNG as a data URL; stored as a file of its own


class Study(StudyContent):
    id: str
    created: str
    updated: str
    has_screenshot: bool = False
    schema_version: int = SCHEMA


class Summary(_Model):
    id: str
    symbol: str
    timeframe: str
    focus: int | None
    tag: str
    excerpt: str
    drawings: int
    created: str
    updated: str
    has_screenshot: bool


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _stamp(moment: datetime) -> str:
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


def _write(path: Path, data: bytes) -> None:
    """Replace a file in one step, so that a crash never leaves half a file."""
    temporary = path.with_name(f".{path.name}.{secrets.token_hex(4)}.part")
    temporary.write_bytes(data)
    os.replace(temporary, path)


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


class StudyStore:
    def __init__(self, root: Path) -> None:
        self.root = Path(root)

    def _folder(self, study_id: str) -> Path:
        if not _ID.match(study_id):
            raise StudyNotFound(study_id)
        return self.root / study_id

    def _existing(self, study_id: str) -> Path:
        folder = self._folder(study_id)
        if not (folder / STUDY_FILE).is_file():
            raise StudyNotFound(study_id)
        return folder

    def _new_id(self) -> str:
        while True:
            study_id = f"{_now():%Y%m%d-%H%M%S}-{secrets.token_hex(2)}"
            if not (self.root / study_id).exists():
                return study_id

    def _read(self, folder: Path) -> Study:
        stored = json.loads((folder / STUDY_FILE).read_text(encoding="utf-8"))
        notes = folder / NOTES_FILE
        stored["comment"] = notes.read_text(encoding="utf-8") if notes.is_file() else ""
        stored["hasScreenshot"] = (folder / SCREENSHOT_FILE).is_file()
        return Study.model_validate(stored)

    def get(self, study_id: str) -> Study:
        return self._read(self._existing(study_id))

    def screenshot(self, study_id: str) -> Path:
        path = self._existing(study_id) / SCREENSHOT_FILE
        if not path.is_file():
            raise StudyNotFound(f"{study_id} has no screenshot")
        return path

    def list(self) -> list[Summary]:
        """All studies, the one saved last first."""
        if not self.root.is_dir():
            return []
        found = []
        for folder in self.root.iterdir():
            if _ID.match(folder.name) and (folder / STUDY_FILE).is_file():
                study = self._read(folder)
                excerpt = " ".join(study.comment.split())[:200]
                found.append(Summary(
                    id=study.id, symbol=study.symbol, timeframe=study.timeframe, focus=study.focus, tag=study.tag, excerpt=excerpt,
                    drawings=len(study.drawings), created=study.created, updated=study.updated, has_screenshot=study.has_screenshot,
                ))
        return sorted(found, key=lambda item: (item.updated, item.id), reverse=True)

    def create(self, content: StudyContent) -> Study:
        return self._save(self._new_id(), content, created=None)

    def update(self, study_id: str, content: StudyContent) -> Study:
        folder = self._existing(study_id)
        created = json.loads((folder / STUDY_FILE).read_text(encoding="utf-8"))["created"]
        self._keep_history(folder)
        return self._save(study_id, content, created=created)

    def delete(self, study_id: str) -> None:
        """Move a study to the trash folder; nothing is destroyed."""
        folder = self._existing(study_id)
        trash = self.root / ".trash"
        trash.mkdir(parents=True, exist_ok=True)
        shutil.move(str(folder), str(trash / f"{study_id}-{_now():%Y%m%d%H%M%S}"))

    def _keep_history(self, folder: Path) -> None:
        kept = folder / "history" / f"{_now():%Y%m%dT%H%M%S}-{secrets.token_hex(2)}"
        kept.mkdir(parents=True)
        for name in (STUDY_FILE, NOTES_FILE, SCREENSHOT_FILE):
            if (folder / name).is_file():
                shutil.copy2(folder / name, kept / name)

    def _save(self, study_id: str, content: StudyContent, created: str | None) -> Study:
        image = _decode_screenshot(content.screenshot) if content.screenshot else None
        folder = self._folder(study_id)
        folder.mkdir(parents=True, exist_ok=True)
        moment = _stamp(_now())
        stored = content.model_dump(by_alias=True, exclude={"comment", "screenshot"})
        stored.update({"id": study_id, "created": created or moment, "updated": moment, "schemaVersion": SCHEMA})
        _write(folder / NOTES_FILE, content.comment.encode("utf-8"))
        if image is not None:
            _write(folder / SCREENSHOT_FILE, image)
        # The study file goes last: once it is in place the save is complete.
        _write(folder / STUDY_FILE, (json.dumps(stored, ensure_ascii=False, indent=1) + "\n").encode("utf-8"))
        return self._read(folder)
