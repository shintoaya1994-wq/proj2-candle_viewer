"""Reading and writing rebuilt datasets.

Layout below the workspace::

    market/<convention>/
        manifest.json
        <symbol>/<timeframe>.parquet    all timeframes, with volume, n_m1 and bar_flags
        <symbol>/gaps.csv               periods without usable 1-minute data
        csv/<symbol>-<timeframe>-bid_full.csv   the same bars in the layout of the raw files
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pandas as pd

from .rawdata import COLUMNS as RAW_COLUMNS
from .rawdata import VOLUME, RawFile

MANIFEST = "manifest.json"


def dataset_dir(workspace: Path, convention: str) -> Path:
    return Path(workspace) / "market" / convention


def bars_path(dataset: Path, symbol: str, timeframe: str) -> Path:
    return dataset / symbol / f"{timeframe}.parquet"


def gaps_path(dataset: Path, symbol: str) -> Path:
    return dataset / symbol / "gaps.csv"


def csv_path(dataset: Path, symbol: str, timeframe: str) -> Path:
    return dataset / "csv" / f"{symbol}-{timeframe}-bid_full.csv"


def write_bars(dataset: Path, symbol: str, bars: dict[str, pd.DataFrame]) -> None:
    for name, frame in bars.items():
        target = bars_path(dataset, symbol, name)
        target.parent.mkdir(parents=True, exist_ok=True)
        frame.to_parquet(target, compression="zstd", index=False)
        target = csv_path(dataset, symbol, name)
        target.parent.mkdir(parents=True, exist_ok=True)
        columns = [*RAW_COLUMNS, VOLUME] if frame[VOLUME].notna().any() else list(RAW_COLUMNS)
        frame[columns].to_csv(target, index=False)


def write_gaps(dataset: Path, symbol: str, gaps: pd.DataFrame) -> None:
    readable = gaps.assign(
        start_utc=pd.to_datetime(gaps["start"], unit="ms").dt.strftime("%Y-%m-%d %H:%M"),
        end_utc=pd.to_datetime(gaps["end"], unit="ms").dt.strftime("%Y-%m-%d %H:%M"),
    )
    target = gaps_path(dataset, symbol)
    target.parent.mkdir(parents=True, exist_ok=True)
    readable.to_csv(target, index=False)


def read_bars(dataset: Path, symbol: str, timeframe: str) -> pd.DataFrame:
    return pd.read_parquet(bars_path(dataset, symbol, timeframe))


def symbols(dataset: Path) -> list[str]:
    return sorted(p.name for p in Path(dataset).iterdir() if p.is_dir() and any(p.glob("*.parquet")))


def fingerprint(file: RawFile) -> dict:
    """Identity of a source file, so that a dataset can be traced to its inputs."""
    digest = hashlib.sha256()
    with open(file.path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 22), b""):
            digest.update(chunk)
    stat = file.path.stat()
    return {"name": file.path.name, "bytes": stat.st_size, "modified": pd.Timestamp(stat.st_mtime, unit="s").strftime("%Y-%m-%d %H:%M:%S"), "sha256": digest.hexdigest()}


def write_manifest(dataset: Path, manifest: dict) -> None:
    (dataset / MANIFEST).write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def read_manifest(dataset: Path) -> dict:
    return json.loads((dataset / MANIFEST).read_text(encoding="utf-8"))
