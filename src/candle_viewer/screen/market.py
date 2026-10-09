"""What a screen is allowed to see: bars up to a moment, and a few helpers."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np

from ..market import store, timeframes
from ..market.sessions import SessionCalendar


@dataclass(frozen=True)
class Bars:
    """Bars of one series as arrays, oldest first. Timestamps are UTC milliseconds of the bar start."""

    timeframe: str
    timestamp: np.ndarray
    open: np.ndarray
    high: np.ndarray
    low: np.ndarray
    close: np.ndarray

    def __len__(self) -> int:
        return len(self.timestamp)

    def index_of(self, timestamp: int) -> int:
        """Position of the bar that starts at the instant, or of the last bar before it; -1 before the first."""
        return int(np.searchsorted(self.timestamp, timestamp, side="right")) - 1


class Market:
    """Read access to a dataset for screens.

    ``as_of`` cuts the data: only bars that have ended by then are handed
    out. A screen run with a cut cannot know what came later, which is how
    the look-ahead check tells an honest ``known_at`` from a wishful one.
    """

    def __init__(self, dataset: Path, as_of: int | None = None) -> None:
        self.dataset = Path(dataset)
        self.as_of = as_of
        manifest = store.read_manifest(self.dataset) if (self.dataset / store.MANIFEST).exists() else {}
        self.calendar = SessionCalendar(manifest.get("convention", "utc"))
        self._cache: dict[tuple[str, str], Bars] = {}

    def symbols(self) -> list[str]:
        return store.symbols(self.dataset)

    def bars(self, symbol: str, timeframe: str) -> Bars:
        key = (symbol, timeframe)
        if key not in self._cache:
            tf = timeframes.get(timeframe)
            frame = store.read_bars(self.dataset, symbol, timeframe)
            ts = frame["timestamp"].to_numpy(dtype="int64")
            keep = slice(None)
            if self.as_of is not None:
                ended = self.calendar.session_end(ts, tf) <= self.as_of
                keep = ended
            self._cache[key] = Bars(
                timeframe,
                ts[keep],
                frame["open"].to_numpy(dtype="float64")[keep],
                frame["high"].to_numpy(dtype="float64")[keep],
                frame["low"].to_numpy(dtype="float64")[keep],
                frame["close"].to_numpy(dtype="float64")[keep],
            )
        return self._cache[key]

    def bar_start(self, timestamps: np.ndarray, timeframe: str) -> np.ndarray:
        """Start of the bar of a coarser timeframe that each instant falls in."""
        return self.calendar.bar_start(np.asarray(timestamps, dtype="int64"), timeframes.get(timeframe))

    def bar_end(self, timestamps: np.ndarray, timeframe: str) -> np.ndarray:
        """Nominal end of the bars that start at the instants."""
        return self.calendar.bar_end(np.asarray(timestamps, dtype="int64"), timeframes.get(timeframe))

    def ended(self, timestamps: np.ndarray, timeframe: str) -> np.ndarray:
        """The moment each bar is complete and can be known: its end, or the Friday close where the week ends inside it.

        This is the moment to give as ``known_at`` for a finding that needs the bar.
        """
        return self.calendar.session_end(np.asarray(timestamps, dtype="int64"), timeframes.get(timeframe))

    def pip(self, symbol: str) -> float:
        manifest = store.read_manifest(self.dataset) if (self.dataset / store.MANIFEST).exists() else {}
        return float(manifest.get("symbols", {}).get(symbol, {}).get("pip", 0.0001))


def rolling_max_before(values: np.ndarray, window: int) -> np.ndarray:
    """For each position, the greatest of the ``window`` values before it; NaN where there are fewer."""
    values = np.asarray(values, dtype="float64")
    out = np.full(len(values), np.nan)
    if len(values) <= window:
        return out
    from numpy.lib.stride_tricks import sliding_window_view

    out[window:] = sliding_window_view(values[:-1], window).max(axis=1)
    return out


def rolling_min_before(values: np.ndarray, window: int) -> np.ndarray:
    """For each position, the smallest of the ``window`` values before it; NaN where there are fewer."""
    values = np.asarray(values, dtype="float64")
    out = np.full(len(values), np.nan)
    if len(values) <= window:
        return out
    from numpy.lib.stride_tricks import sliding_window_view

    out[window:] = sliding_window_view(values[:-1], window).min(axis=1)
    return out


def atr(bars: Bars, period: int = 14) -> np.ndarray:
    """Average true range after Wilder, up to and including each bar; NaN until ``period`` bars exist."""
    high, low, close = bars.high, bars.low, bars.close
    n = len(bars)
    out = np.full(n, np.nan)
    if n < period + 1:
        return out
    previous = np.r_[np.nan, close[:-1]]
    true_range = np.maximum(high - low, np.maximum(np.abs(high - previous), np.abs(low - previous)))
    true_range[0] = high[0] - low[0]
    value = float(true_range[:period].mean())
    out[period - 1] = value
    weight = 1.0 / period
    for i in range(period, n):
        value += (true_range[i] - value) * weight
        out[i] = value
    return out
