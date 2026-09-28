"""Cleaning of 1-minute data before aggregation.

Only minutes with trades are market data. Two kinds of raw file exist:

* With a ``volume`` column. Minutes without trades have volume zero or are
  absent, so the feed itself tells which minutes traded.
* Without volumes (older downloads). Every minute of the session window is
  present; while the market is shut or the feed is down the bars repeat one
  price. Runs of such bars are recognised by their length and removed.

Afterwards short pauses in trading are closed with flat bars at the previous
close, so that a session is a continuous series of minutes. Long pauses stay
empty: they are closures or holes.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .timeframes import MINUTE_MS


@dataclass(frozen=True)
class FillerRuns:
    """Runs of repeated-price bars that were classified as filler."""

    mask: np.ndarray      # per input row: True when the row is filler
    start: np.ndarray     # timestamp of the first bar of each run
    minutes: np.ndarray   # length of each run
    price: np.ndarray     # the repeated price


def is_flat(o: np.ndarray, h: np.ndarray, l: np.ndarray, c: np.ndarray) -> np.ndarray:
    return (o == h) & (h == l) & (l == c)


def find_filler(ts: np.ndarray, o: np.ndarray, h: np.ndarray, l: np.ndarray, c: np.ndarray, min_minutes: int = 60) -> FillerRuns:
    """Locate runs of at least ``min_minutes`` consecutive minutes stuck on one price."""
    flat = is_flat(o, h, l, c)
    continues = np.zeros(len(ts), dtype=bool)
    if len(ts) > 1:
        continues[1:] = flat[1:] & flat[:-1] & (np.diff(ts) == MINUTE_MS) & (c[1:] == c[:-1])
    starts = flat & ~continues
    run_id = np.cumsum(starts) - 1
    lengths = np.bincount(run_id[flat], minlength=int(starts.sum()))
    mask = np.zeros(len(ts), dtype=bool)
    mask[flat] = lengths[run_id[flat]] >= min_minutes
    first = np.flatnonzero(starts)
    long_runs = lengths >= min_minutes
    return FillerRuns(mask=mask, start=ts[first][long_runs], minutes=lengths[long_runs], price=c[first][long_runs])


def ohlc_violation(o: np.ndarray, h: np.ndarray, l: np.ndarray, c: np.ndarray) -> np.ndarray:
    """How far open or close lie outside [low, high]; zero for a valid candle."""
    above = np.maximum(np.maximum(o, c) - h, 0.0)
    below = np.maximum(l - np.minimum(o, c), 0.0)
    inverted = np.maximum(l - h, 0.0)
    return np.maximum(np.maximum(above, below), inverted)


def widen_small_violations(o: np.ndarray, h: np.ndarray, l: np.ndarray, c: np.ndarray, tolerance: float) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Stretch high and low to contain open and close where the miss is within ``tolerance``.

    Returns the new highs, the new lows and a mask of the rows that were changed.
    Larger violations are left untouched because it is unknown which value is wrong.
    """
    violation = ohlc_violation(o, h, l, c)
    fix = (violation > 0) & (violation <= tolerance)
    high = np.where(fix, np.maximum.reduce([o, h, l, c]), h)
    low = np.where(fix, np.minimum.reduce([o, h, l, c]), l)
    return high, low, fix


def fill_short_gaps(ts: np.ndarray, close: np.ndarray, max_missing: int) -> tuple[np.ndarray, np.ndarray]:
    """Minutes to insert where at most ``max_missing`` consecutive minutes are absent.

    Returns the timestamps of the new bars and, for each, the close of the bar
    before the gap, which is the price the market stood at.
    """
    if len(ts) < 2:
        return np.empty(0, dtype="int64"), np.empty(0)
    missing = np.diff(ts) // MINUTE_MS - 1
    counts = np.where((missing > 0) & (missing <= max_missing), missing, 0)
    total = int(counts.sum())
    if total == 0:
        return np.empty(0, dtype="int64"), np.empty(0)
    before = np.repeat(np.arange(len(ts) - 1), counts)
    first_of_gap = np.repeat(np.cumsum(counts) - counts, counts)
    position = np.arange(total) - first_of_gap + 1
    return ts[before] + position * MINUTE_MS, close[before]
