"""Command line entry point: ``candle-screen``."""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from ..app.signals import SignalStore
from ..market.cli import DEFAULT_WORKSPACE
from ..market.sessions import CONVENTIONS
from . import runner, scripts


def _when(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, timezone.utc).strftime("%Y-%m-%d %H:%M")


def _params(items: list[str] | None) -> dict:
    settings = {}
    for item in items or []:
        name, _, value = item.partition("=")
        try:
            settings[name] = json.loads(value)
        except json.JSONDecodeError:
            settings[name] = value
    return settings


def _list(args: argparse.Namespace) -> int:
    for screen in scripts.discover(Path(args.workspace).expanduser()).values():
        where = "shipped" if screen.shipped else str(screen.source)
        print(f"{screen.name:20} {screen.title}  [{where}]  params={screen.params}")
    return 0


def _run(args: argparse.Namespace) -> int:
    workspace = Path(args.workspace).expanduser()
    screen = scripts.get(workspace, args.screen)
    dataset = runner.dataset_of(workspace, args.convention)
    signals = SignalStore(workspace / "signals")
    for symbol in args.symbols:
        found = runner.run(screen, dataset, symbol, _params(args.param))
        if args.dry_run:
            for item in found:
                print(f"{symbol} {item.key:28} {item.shape:7} {item.timeframe:4} {_when(item.anchors[0][0])}  known {_when(item.known_at)}  {item.note}")
            print(f"{symbol}: {len(found)} found")
            continue
        outcome = runner.publish(found, signals, screen, symbol)
        print(f"{symbol}: {outcome.found} found, {len(outcome.created)} new candidates, {outcome.known} known already")
    return 0


def _check(args: argparse.Namespace) -> int:
    workspace = Path(args.workspace).expanduser()
    screen = scripts.get(workspace, args.screen)
    dataset = runner.dataset_of(workspace, args.convention)
    failed = False
    for symbol in args.symbols:
        report = runner.check(screen, dataset, symbol, _params(args.param))
        for item in report.differences:
            print(f"{symbol} {item.kind:5} at {_when(item.cutoff)}: {item.key}  {item.detail}")
        verdict = "passed" if report.passed else "FAILED: the screen looks ahead"
        print(f"{symbol}: {report.found} found, {report.cutoffs} cutoffs tried, {verdict}")
        failed |= not report.passed
    return 1 if failed else 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="candle-screen", description="Run the screens that look for signals, and check them for looking ahead.")
    parser.add_argument("--workspace", default=str(DEFAULT_WORKSPACE))
    parser.add_argument("--convention", choices=CONVENTIONS, default="utc")
    commands = parser.add_subparsers(dest="command", required=True)

    listing = commands.add_parser("list", help="the screens that can be run")
    listing.set_defaults(run=_list)

    running = commands.add_parser("run", help="run a screen and keep what it finds as candidate signals")
    running.add_argument("screen")
    running.add_argument("--symbols", nargs="+", required=True)
    running.add_argument("--param", action="append", help="name=value, repeatable")
    running.add_argument("--dry-run", action="store_true", help="only print what would be found")
    running.set_defaults(run=_run)

    checking = commands.add_parser("check", help="run a screen on cut data and see whether it looks ahead")
    checking.add_argument("screen")
    checking.add_argument("--symbols", nargs="+", required=True)
    checking.add_argument("--param", action="append")
    checking.set_defaults(run=_check)

    args = parser.parse_args(argv)
    return args.run(args)


if __name__ == "__main__":
    sys.exit(main())
