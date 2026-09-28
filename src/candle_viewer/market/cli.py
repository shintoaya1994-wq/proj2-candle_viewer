"""Command line entry point: ``candle-data``."""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import pandas as pd

from . import quality, rawdata, report, store, timeframes, verify
from .rebuild import RebuildConfig, rebuild_symbol
from .sessions import CONVENTIONS

DEFAULT_WORKSPACE = Path.home() / "candle_workspace"


def _rebuild(args: argparse.Namespace) -> int:
    config = RebuildConfig(convention=args.convention)
    source, workspace = Path(args.source).expanduser(), Path(args.workspace).expanduser()
    dataset = store.dataset_dir(workspace, config.convention)
    found = rawdata.discover(source)
    wanted = [s.lower() for s in args.symbols] if args.symbols else sorted(found)
    unknown = [s for s in wanted if s not in found]
    if unknown:
        print(f"no raw files for: {', '.join(unknown)} (found: {', '.join(sorted(found)) or 'nothing'})", file=sys.stderr)
        return 2

    patch_dir = Path(args.patches).expanduser() if args.patches else source / "patches"
    patches = rawdata.discover(patch_dir) if patch_dir.is_dir() else {}
    baseline_dir = Path(args.compare_with).expanduser() if args.compare_with else source
    baseline_files = rawdata.discover(baseline_dir)

    reports, manifest_symbols = [], {}
    for symbol in wanted:
        began = time.time()
        files = found[symbol]
        minutes = rawdata.read_bars(files["m1"].path) if "m1" in files else None
        daily = rawdata.read_bars(files["d1"].path) if "d1" in files else None
        hourly = rawdata.read_bars(files["h1"].path) if "h1" in files else None
        patch = patches.get(symbol, {}).get("m1")
        if minutes is not None and patch is not None:
            minutes = rawdata.apply_patch(minutes, rawdata.read_bars(patch.path))
        result = rebuild_symbol(symbol, minutes, daily, config, original_hourly=hourly)
        baseline = {name: rawdata.read_bars(file.path) for name, file in baseline_files.get(symbol, {}).items() if name != timeframes.BASE.name}
        summary = quality.summarize(result, minutes, baseline, config)
        store.write_bars(dataset, symbol, result.bars)
        store.write_gaps(dataset, symbol, summary.gaps)
        entry = quality.manifest_entry(summary)
        entry["sources"] = [store.fingerprint(file) for _, file in sorted(files.items())]
        manifest_symbols[symbol] = entry
        reports.append(summary)
        holes = entry["holes"]
        print(f"{symbol}: {len(result.bars)} timeframes, {holes['large']} large holes, {time.time() - began:.1f}s")

    generated = pd.Timestamp.now(tz="UTC").strftime("%Y-%m-%d %H:%M UTC")
    previous = store.read_manifest(dataset).get("symbols", {}) if (dataset / store.MANIFEST).exists() else {}
    store.write_manifest(dataset, {
        "convention": config.convention,
        "generated": generated,
        "source": str(source),
        "config": config.__dict__,
        "symbols": {**previous, **manifest_symbols},
    })
    target = workspace / "reports" / f"data_quality_{config.convention}.md"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(report.render(reports, config, source, dataset, generated, baseline_dir), encoding="utf-8")
    print(f"dataset: {dataset}\nreport:  {target}")
    return 0


def _check(args: argparse.Namespace) -> int:
    dataset = store.dataset_dir(Path(args.workspace).expanduser(), args.convention)
    checks = verify.check_dataset(dataset)
    failed = [c for c in checks if not c.passed]
    for check in checks if args.verbose else failed:
        print(f"{'ok  ' if check.passed else 'FAIL'} {check.symbol} {check.name}: {check.detail}")
    print(f"{len(checks) - len(failed)} of {len(checks)} checks passed")
    return 1 if failed else 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="candle-data", description="Rebuild and check market data for the candle viewer.")
    commands = parser.add_subparsers(dest="command", required=True)

    rebuild = commands.add_parser("rebuild", help="rebuild all timeframes from 1-minute data")
    rebuild.add_argument("--source", required=True, help="directory with the raw CSV files")
    rebuild.add_argument("--workspace", default=str(DEFAULT_WORKSPACE), help="private workspace directory (default: %(default)s)")
    rebuild.add_argument("--convention", choices=CONVENTIONS, default="utc", help="how days and four-hour bars are aligned (default: %(default)s)")
    rebuild.add_argument("--symbols", nargs="*", help="symbols to rebuild (default: all found)")
    rebuild.add_argument("--patches", help="directory with 1-minute files that fill holes of the main files (default: <source>/patches)")
    rebuild.add_argument("--compare-with", help="directory with files of an earlier dataset to compare against (default: the source)")
    rebuild.set_defaults(run=_rebuild)

    check = commands.add_parser("check", help="verify a rebuilt dataset")
    check.add_argument("--workspace", default=str(DEFAULT_WORKSPACE))
    check.add_argument("--convention", choices=CONVENTIONS, default="utc")
    check.add_argument("--verbose", action="store_true", help="list passed checks too")
    check.set_defaults(run=_check)

    args = parser.parse_args(argv)
    return args.run(args)


if __name__ == "__main__":
    sys.exit(main())
