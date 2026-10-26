"""Choose the private workspace consistently for every entry point."""

from __future__ import annotations

import os
import sys
from pathlib import Path


def default_workspace() -> Path:
    """Prefer an explicit override, then the shared data, then the home directory."""
    configured = os.environ.get("CANDLE_WORKSPACE")
    if configured:
        return Path(configured).expanduser()
    shared = Path("F:/candle_workspace" if sys.platform == "win32" else "/mnt/desktop-f/candle_workspace")
    if shared.is_dir():
        return shared
    return Path.home() / "candle_workspace"
