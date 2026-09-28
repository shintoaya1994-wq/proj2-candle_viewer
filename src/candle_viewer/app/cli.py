"""Command line entry point: ``candle-viewer``."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import uvicorn

from ..market.cli import DEFAULT_WORKSPACE
from ..market.sessions import CONVENTIONS
from .main import create_app


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="candle-viewer", description="Serve the candle viewer on this computer.")
    parser.add_argument("--workspace", default=str(DEFAULT_WORKSPACE), help="private workspace directory (default: %(default)s)")
    parser.add_argument("--convention", choices=CONVENTIONS, default="utc", help="dataset to show (default: %(default)s)")
    parser.add_argument("--host", default="127.0.0.1", help="address to listen on; 0.0.0.0 opens the viewer to the local network (default: %(default)s)")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args(argv)
    app = create_app(Path(args.workspace), args.convention)
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")
    return 0


if __name__ == "__main__":
    sys.exit(main())
