"""Projects: separate sets of records over the same market data.

The records the user trusts live at the root of the workspace. A project
is a folder below ``<workspace>/projects`` with records of its own, where
a new idea can be tried without touching the known signals.
"""

from __future__ import annotations

import json
import re
import shutil
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from .signals import SignalStore
from .studies import StudyStore, write_json

PROJECTS = "projects"
PROJECT_FILE = "project.json"
MAIN = ""            # the name of the records at the root of the workspace
MAIN_LABEL = "主项目"
_NAME = re.compile(r"^[\w一-鿿][\w一-鿿 .-]{0,39}$")


class UnknownProject(LookupError):
    pass


class InvalidProject(ValueError):
    pass


@dataclass(frozen=True)
class Space:
    """The records of one project."""

    name: str
    label: str
    root: Path
    workspace: Path

    @property
    def signals(self) -> SignalStore:
        return SignalStore(self.root / "signals")

    @property
    def studies(self) -> StudyStore:
        return StudyStore(self.root / "studies")

    @property
    def screen_dirs(self) -> list[Path]:
        """Where the screens of the project are looked for: its own first, then those of the workspace."""
        own = self.root / "screens"
        shared = self.workspace / "screens"
        return [own, shared] if own != shared else [own]


@dataclass(frozen=True)
class ProjectInfo:
    name: str
    label: str
    created: str | None
    signals: int
    studies: int


class Projects:
    def __init__(self, workspace: Path) -> None:
        self.workspace = Path(workspace)

    def _folder(self, name: str) -> Path:
        if name == MAIN:
            return self.workspace
        if not _NAME.match(name) or name.startswith("."):
            raise InvalidProject(f"not a project name: {name!r}")
        return self.workspace / PROJECTS / name

    def get(self, name: str) -> Space:
        folder = self._folder(name)
        if name != MAIN and not (folder / PROJECT_FILE).is_file():
            raise UnknownProject(name)
        return Space(name, MAIN_LABEL if name == MAIN else name, folder, self.workspace)

    def create(self, name: str) -> Space:
        folder = self._folder(name)
        if name == MAIN or (folder / PROJECT_FILE).is_file():
            raise InvalidProject(f"a project named {name!r} exists already")
        folder.mkdir(parents=True, exist_ok=True)
        write_json(folder / PROJECT_FILE, {"name": name, "created": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")})
        return self.get(name)

    def delete(self, name: str) -> None:
        """Moves a project to the trash; the records at the root cannot be removed."""
        folder = self._folder(name)
        if name == MAIN or not (folder / PROJECT_FILE).is_file():
            raise UnknownProject(name)
        trash = self.workspace / PROJECTS / ".trash"
        trash.mkdir(parents=True, exist_ok=True)
        shutil.move(str(folder), str(trash / f"{name}-{datetime.now(timezone.utc):%Y%m%d%H%M%S}"))

    def list(self) -> list[ProjectInfo]:
        """The records at the root first, then the projects by name."""
        found = [self._info(self.get(MAIN), None)]
        home = self.workspace / PROJECTS
        if home.is_dir():
            for folder in sorted(home.iterdir()):
                if folder.name.startswith(".") or not (folder / PROJECT_FILE).is_file():
                    continue
                stored = json.loads((folder / PROJECT_FILE).read_text(encoding="utf-8"))
                found.append(self._info(self.get(folder.name), stored.get("created")))
        return found

    @staticmethod
    def _info(space: Space, created: str | None) -> ProjectInfo:
        signals = sum(len(space.signals.list(symbol.name)) for symbol in (space.root / "signals").iterdir()) if (space.root / "signals").is_dir() else 0
        return ProjectInfo(space.name, space.label, created, signals, len(space.studies.list()))
