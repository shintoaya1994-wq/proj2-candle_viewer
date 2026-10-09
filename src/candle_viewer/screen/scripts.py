"""Finding and loading screens: the ones shipped with the package and the user's own."""

from __future__ import annotations

import importlib
import importlib.util
import re
from dataclasses import dataclass
from pathlib import Path
from types import ModuleType

from .. import screens as shipped

_NAME = re.compile(r"^[a-z][a-z0-9_]*$")


class UnknownScreen(LookupError):
    pass


class BadScreen(ValueError):
    pass


@dataclass(frozen=True)
class Screen:
    name: str
    title: str
    params: dict
    module: ModuleType
    source: Path
    shipped: bool

    def run(self, market, symbol: str, params: dict | None = None):
        settings = {**self.params, **(params or {})}
        return list(self.module.run(market, symbol, settings))


def _load(path: Path, shipped_: bool) -> Screen:
    spec = importlib.util.spec_from_file_location(f"candle_screen_{path.stem}", path)
    if spec is None or spec.loader is None:
        raise BadScreen(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    name = getattr(module, "NAME", path.stem)
    if not _NAME.match(name):
        raise BadScreen(f"{path}: NAME must be lowercase letters, digits and underscores, not {name!r}")
    if not callable(getattr(module, "run", None)):
        raise BadScreen(f"{path}: no run(market, symbol, params) function")
    params = getattr(module, "PARAMS", {})
    if not isinstance(params, dict):
        raise BadScreen(f"{path}: PARAMS must be a dict")
    return Screen(name, str(getattr(module, "TITLE", name)), dict(params), module, path, shipped_)


def discover(workspace: Path) -> dict[str, Screen]:
    """Screens by name: the user's own first, then the shipped ones they do not replace."""
    found: dict[str, Screen] = {}
    own = Path(workspace) / "screens"
    if own.is_dir():
        for path in sorted(own.glob("*.py")):
            if path.name.startswith("_"):
                continue
            screen = _load(path, False)
            found[screen.name] = screen
    for path in sorted(Path(shipped.__file__).parent.glob("*.py")):
        if path.name.startswith("_"):
            continue
        screen = _load(path, True)
        found.setdefault(screen.name, screen)
    return found


def get(workspace: Path, name: str) -> Screen:
    screens = discover(workspace)
    if name not in screens:
        raise UnknownScreen(name)
    return screens[name]
