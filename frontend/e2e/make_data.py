"""Writes a small invented market for the browser tests: one symbol, minutes and daily candles.

Usage: python make_data.py <folder>
"""

import sys
from pathlib import Path

import numpy as np
import pandas as pd

MINUTE = 60_000
WEEKS = 10
FIRST_SUNDAY = pd.Timestamp("2024-01-07")


def minutes() -> pd.DataFrame:
    parts = []
    epoch = pd.Timestamp("1970-01-01")
    for week in range(WEEKS):
        opening = (FIRST_SUNDAY + pd.Timedelta(days=7 * week, hours=22) - epoch) // pd.Timedelta(milliseconds=1)
        parts.append(np.arange(opening, opening + 5 * 1440 * MINUTE, MINUTE, dtype="int64"))
    ts = np.concatenate(parts)
    rng = np.random.default_rng(11)
    close = np.round(1.25 + np.cumsum(rng.normal(0, 0.00012, len(ts))), 5)
    open_ = np.r_[1.25, close[:-1]]
    high = np.round(np.maximum(open_, close) + rng.uniform(0.00001, 0.0002, len(ts)), 5)
    low = np.round(np.minimum(open_, close) - rng.uniform(0.00001, 0.0002, len(ts)), 5)
    volume = np.round(rng.uniform(1, 300, len(ts)), 2)
    return pd.DataFrame({"timestamp": ts, "open": open_, "high": high, "low": low, "close": close, "volume": volume})


def daily() -> pd.DataFrame:
    """Daily candles of the year before the minutes begin."""
    days = pd.bdate_range("2023-01-02", "2024-01-05")
    rng = np.random.default_rng(12)
    close = np.round(1.25 + np.cumsum(rng.normal(0, 0.004, len(days)))[::-1] * -1, 4)
    open_ = np.r_[close[0], close[:-1]]
    high = np.round(np.maximum(open_, close) + rng.uniform(0.001, 0.006, len(days)), 4)
    low = np.round(np.minimum(open_, close) - rng.uniform(0.001, 0.006, len(days)), 4)
    volume = np.round(rng.uniform(50_000, 200_000, len(days)), 1)
    timestamps = (days - pd.Timestamp("1970-01-01")) // pd.Timedelta(milliseconds=1)
    return pd.DataFrame({"timestamp": timestamps, "open": open_, "high": high, "low": low, "close": close, "volume": volume})


if __name__ == "__main__":
    folder = Path(sys.argv[1])
    folder.mkdir(parents=True, exist_ok=True)
    minutes().to_csv(folder / "testfx-m1-bid_full.csv", index=False)
    daily().to_csv(folder / "testfx-d1-bid_full.csv", index=False)
