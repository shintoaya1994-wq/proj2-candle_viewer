"""Independent checks of a stored dataset.

Every timeframe is recomputed from the next finer one with pandas ``groupby``,
a different code path from the one that built the bars, and compared value by
value.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd

from . import store, timeframes
from .rawdata import PRICE_COLUMNS, VOLUME
from .rebuild import Flag
from .sessions import SessionCalendar


@dataclass(frozen=True)
class Check:
    symbol: str
    name: str
    passed: bool
    detail: str


def _flag(frame: pd.DataFrame, flag: Flag) -> np.ndarray:
    return (frame["bar_flags"].to_numpy() & int(flag)) > 0


def _prices(frame: pd.DataFrame) -> pd.DataFrame:
    grouped = frame.groupby("_key", sort=True)
    return pd.DataFrame({"open": grouped["open"].first(), "high": grouped["high"].max(), "low": grouped["low"].min(), "close": grouped["close"].last()})


def _regroup(frame: pd.DataFrame, keys: np.ndarray) -> pd.DataFrame:
    """Aggregate with pandas: prices from the bars that traded, sums over all bars."""
    frame = frame.assign(_key=keys)
    prices = _prices(frame)
    prices.update(_prices(frame[~_flag(frame, Flag.FILLED)]))
    grouped = frame.groupby("_key", sort=True)
    return prices.assign(volume=grouped[VOLUME].sum(min_count=1), n_m1=grouped["n_m1"].sum())


def _same(expected: pd.DataFrame, stored: pd.DataFrame) -> tuple[bool, str]:
    stored = stored.set_index("timestamp")
    if not expected.index.equals(stored.index):
        extra = len(stored.index.difference(expected.index))
        missing = len(expected.index.difference(stored.index))
        return False, f"{missing} bars missing, {extra} bars unexpected"
    wrong = 0
    for name in (*PRICE_COLUMNS, "n_m1"):
        wrong += int((expected[name].to_numpy() != stored[name].to_numpy()).sum())
    # Volumes are sums of floats; the order of addition differs between the two code paths.
    wrong += int((~np.isclose(expected[VOLUME].to_numpy(), stored[VOLUME].to_numpy(), rtol=1e-9, atol=1e-6, equal_nan=True)).sum())
    return wrong == 0, f"{len(stored)} bars" if wrong == 0 else f"{wrong} values differ in {len(stored)} bars"


def check_symbol(dataset: Path, symbol: str, calendar: SessionCalendar) -> list[Check]:
    bars = {tf.name: store.read_bars(dataset, symbol, tf.name) for tf in timeframes.ALL if store.bars_path(dataset, symbol, tf.name).exists()}
    checks: list[Check] = []

    def add(name: str, passed: bool, detail: str) -> None:
        checks.append(Check(symbol, name, bool(passed), detail))

    for name, frame in bars.items():
        ts = frame["timestamp"].to_numpy()
        add(f"{name}: timestamps strictly increasing", (np.diff(ts) > 0).all(), f"{len(ts)} bars")
        o, h, l, c = (frame[k].to_numpy() for k in PRICE_COLUMNS)
        invalid = (h < np.maximum(o, c)) | (l > np.minimum(o, c)) | (h < l)
        unflagged = invalid & ~_flag(frame, Flag.BAD_OHLC)
        add(f"{name}: every candle valid or flagged", not unflagged.any(), f"{int(invalid.sum())} flagged, {int(unflagged.sum())} unflagged")

    # Quarters are regrouped from months; every other timeframe from the next finer one.
    finer_of = {"m15": "m1", "h1": "m15", "h4": "h1", "d1": "h4", "w1": "d1", "1mo": "d1", "3mo": "1mo"}
    for tf in timeframes.ALL:
        finer = finer_of.get(tf.name)
        if tf.name not in bars or finer not in bars:
            continue
        source = bars[finer]
        expected = _regroup(source, calendar.bar_start(source["timestamp"].to_numpy(), tf))
        stored = bars[tf.name]
        aggregated = stored[~_flag(stored, Flag.COPIED)]
        # A copied bar replaces whatever the finer bars of its period would give.
        expected = expected[~expected.index.isin(stored.loc[_flag(stored, Flag.COPIED), "timestamp"])]
        add(f"{tf.name} equals {finer} regrouped", *_same(expected, aggregated))

    return checks


def check_dataset(dataset: Path) -> list[Check]:
    calendar = SessionCalendar(store.read_manifest(dataset)["convention"])
    checks: list[Check] = []
    for symbol in store.symbols(dataset):
        checks.extend(check_symbol(dataset, symbol, calendar))
    return checks
