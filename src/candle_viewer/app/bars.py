"""Windows of bars read from the rebuilt dataset.

A chart shows a few hundred bars at a time, while a 1-minute file holds
millions. The files are therefore never loaded whole: the row groups of a
Parquet file are found through the timestamp range each of them covers, and
only the groups a window touches are read.
"""

from __future__ import annotations

import json
import re
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow.parquet as pq

from ..market import store, timeframes

COLUMNS = ("timestamp", "open", "high", "low", "close", "volume", "n_m1", "bar_flags")
MAX_COUNT = 5000
_SYMBOL = re.compile(r"^[a-z0-9]+$")
_GROUPS_KEPT = 24   # row groups held in memory per process


class UnknownSeries(LookupError):
    """No such symbol or timeframe in the dataset."""


@dataclass(frozen=True)
class Window:
    bars: pd.DataFrame
    older: bool   # bars exist before the first one of the window
    newer: bool   # bars exist after the last one


class BarFile:
    """One Parquet file of bars, addressed by position or by time."""

    def __init__(self, path: Path, groups: "OrderedDict[tuple, pd.DataFrame]") -> None:
        self.path = path
        self.modified = path.stat().st_mtime_ns
        self._groups = groups
        parquet = pq.ParquetFile(path)
        meta = parquet.metadata
        column = parquet.schema_arrow.names.index("timestamp")
        counts = [meta.row_group(i).num_rows for i in range(meta.num_row_groups)]
        ranges = [meta.row_group(i).column(column).statistics for i in range(meta.num_row_groups)]
        self.offsets = np.r_[0, np.cumsum(counts)].astype("int64")
        self.first = np.array([r.min for r in ranges], dtype="int64")
        self.last = np.array([r.max for r in ranges], dtype="int64")
        self.rows = int(self.offsets[-1])

    def _group(self, index: int) -> pd.DataFrame:
        key = (self.path, self.modified, index)
        frame = self._groups.get(key)
        if frame is None:
            frame = pq.ParquetFile(self.path).read_row_group(index, columns=list(COLUMNS)).to_pandas()
            self._groups[key] = frame
            while len(self._groups) > _GROUPS_KEPT:
                self._groups.popitem(last=False)
        else:
            self._groups.move_to_end(key)
        return frame

    def position(self, timestamp: int) -> int:
        """Position of the first bar at or after ``timestamp``."""
        group = int(np.searchsorted(self.last, timestamp, side="left"))
        if group == len(self.last):
            return self.rows
        inside = np.searchsorted(self._group(group)["timestamp"].to_numpy(), timestamp, side="left")
        return int(self.offsets[group] + inside)

    def between(self, start: int, stop: int) -> pd.DataFrame:
        """Bars at positions [start, stop)."""
        start, stop = max(0, start), min(self.rows, stop)
        if start >= stop:
            return pd.DataFrame(columns=list(COLUMNS))
        first = int(np.searchsorted(self.offsets, start, side="right")) - 1
        last = int(np.searchsorted(self.offsets, stop, side="left")) - 1
        parts = [self._group(i) for i in range(first, last + 1)]
        frame = pd.concat(parts, ignore_index=True) if len(parts) > 1 else parts[0]
        begin = start - int(self.offsets[first])
        return frame.iloc[begin : begin + (stop - start)].reset_index(drop=True)

    def span(self) -> tuple[int, int]:
        return int(self.first[0]), int(self.last[-1])


class BarStore:
    """Read access to one dataset (``<workspace>/market/<convention>``)."""

    def __init__(self, dataset: Path) -> None:
        self.dataset = Path(dataset)
        self._files: dict[tuple[str, str], BarFile] = {}
        self._groups: OrderedDict[tuple, pd.DataFrame] = OrderedDict()

    def _file(self, symbol: str, timeframe: str) -> BarFile:
        if not _SYMBOL.match(symbol) or timeframe not in timeframes.BY_NAME:
            raise UnknownSeries(f"{symbol} {timeframe}")
        path = store.bars_path(self.dataset, symbol, timeframe)
        if not path.is_file():
            raise UnknownSeries(f"{symbol} {timeframe}")
        known = self._files.get((symbol, timeframe))
        if known is None or known.modified != path.stat().st_mtime_ns:
            known = self._files[(symbol, timeframe)] = BarFile(path, self._groups)
        return known

    def symbols(self) -> list[str]:
        if not self.dataset.is_dir():
            return []
        return store.symbols(self.dataset)

    def meta(self) -> dict:
        """What the dataset holds: symbols, their timeframes and the time each of them spans."""
        manifest_file = self.dataset / store.MANIFEST
        manifest = json.loads(manifest_file.read_text(encoding="utf-8")) if manifest_file.is_file() else {}
        described = []
        for symbol in self.symbols():
            series = []
            for tf in timeframes.ALL:
                if store.bars_path(self.dataset, symbol, tf.name).is_file():
                    file = self._file(symbol, tf.name)
                    first, last = file.span()
                    series.append({"name": tf.name, "rows": file.rows, "first": first, "last": last})
            pip = manifest.get("symbols", {}).get(symbol, {}).get("pip", 0.0001)
            described.append({"name": symbol, "pip": pip, "digits": 3 if pip >= 0.01 else 5, "timeframes": series})
        return {"convention": manifest.get("convention", "utc"), "generated": manifest.get("generated"), "symbols": described}

    def window(self, symbol: str, timeframe: str, *, before: int | None = None, after: int | None = None, around: int | None = None, count: int = 1000) -> Window:
        """A window of at most ``count`` bars.

        ``before``: the bars just before that time. ``after``: the bars just
        after it. ``around``: bars on both sides of it. None of them: the
        latest bars.
        """
        if sum(value is not None for value in (before, after, around)) > 1:
            raise ValueError("give only one of before, after and around")
        count = max(1, min(int(count), MAX_COUNT))
        file = self._file(symbol, timeframe)
        if before is not None:
            stop = file.position(before)
            start = stop - count
        elif after is not None:
            start = file.position(after + 1)
            stop = start + count
        elif around is not None:
            start = max(0, min(file.position(around) - count // 2, file.rows - count))
            stop = start + count
        else:
            stop = file.rows
            start = stop - count
        start, stop = max(0, start), min(file.rows, stop)
        return Window(file.between(start, stop), older=start > 0, newer=stop < file.rows)
