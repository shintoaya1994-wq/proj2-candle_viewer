"""Shared helpers: synthetic 1-minute data with known structure."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

MINUTE = 60_000


def ms(text: str) -> int:
    """UTC epoch milliseconds of an ISO timestamp."""
    return int(pd.Timestamp(text).value // 1_000_000)


def minutes_between(start: str, end: str) -> np.ndarray:
    """Every full minute in [start, end)."""
    return np.arange(ms(start), ms(end), MINUTE, dtype="int64")


def random_walk(timestamps: np.ndarray, seed: int = 7, start_price: float = 1.2, volumes: bool = False) -> pd.DataFrame:
    """Valid 1-minute candles following a random walk; no bar is flat."""
    rng = np.random.default_rng(seed)
    n = len(timestamps)
    close = np.round(start_price + np.cumsum(rng.normal(0, 0.0002, n)), 5)
    open_ = np.r_[start_price, close[:-1]]
    high = np.round(np.maximum(open_, close) + rng.uniform(0.00001, 0.0003, n), 5)
    low = np.round(np.minimum(open_, close) - rng.uniform(0.00001, 0.0003, n), 5)
    frame = pd.DataFrame({"timestamp": timestamps, "open": open_, "high": high, "low": low, "close": close})
    if volumes:
        frame["volume"] = np.round(rng.uniform(1, 500, n), 2)
    return frame


def trading_weeks(first_sunday: str, weeks: int) -> np.ndarray:
    """Minutes of ``weeks`` trading weeks, each from Sunday 22:00 to Friday 22:00 UTC."""
    sunday = pd.Timestamp(first_sunday)
    parts = []
    for week in range(weeks):
        opening = sunday + pd.Timedelta(days=7 * week, hours=22)
        parts.append(minutes_between(str(opening), str(opening + pd.Timedelta(days=5))))
    return np.concatenate(parts)


@pytest.fixture
def two_weeks() -> pd.DataFrame:
    # 2024-01-07 is a Sunday; winter time in New York.
    return random_walk(trading_weeks("2024-01-07", 2))


@pytest.fixture
def two_weeks_with_volume() -> pd.DataFrame:
    return random_walk(trading_weeks("2024-01-07", 2), volumes=True)
