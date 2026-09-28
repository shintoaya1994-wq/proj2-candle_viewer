"""Rebuild every timeframe of one symbol from the finest data available.

Pipeline
--------
1. Clean the 1-minute bars: keep the minutes that traded, widen tiny
   open/close overshoots, close short pauses with flat bars.
2. Aggregate 15-minute and hourly bars from the minutes. Hours the minutes
   lack are copied from the downloaded hourly candles.
3. Aggregate four-hour and daily bars from the hourly bars. Days the hourly
   bars lack are copied from the downloaded daily candles, which reach
   further back.
4. Aggregate weekly, monthly and quarterly bars from the daily bars.

Every bar therefore has exactly one origin, recorded in ``bar_flags``.
"""

from __future__ import annotations

import enum
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from . import clean, timeframes
from .rawdata import PATCHED, PRICE_COLUMNS, VOLUME, pip_size
from .sessions import SessionCalendar
from .timeframes import HOUR_MS, MINUTE_MS, Timeframe

OUTPUT_COLUMNS = ("timestamp", *PRICE_COLUMNS, VOLUME, "n_m1", "bar_flags")
_FIELDS = ("key", "open", "high", "low", "close", "volume", "n_m1", "covered", "flags")

HOURLY = timeframes.get("h1")


class Flag(enum.IntFlag):
    """Bit flags stored with every bar in the ``bar_flags`` column."""

    PARTIAL = 1      # hourly or daily bar whose data cover clearly less than the normal session
    ORIGINAL = 2     # no 1-minute data behind this bar; it rests on downloaded coarser candles
    MIXED = 4        # 1-minute data behind only a part of this bar
    BAD_OHLC = 8     # open or close outside [low, high]; values kept as delivered
    UNFINISHED = 16  # the period was not over when the data ended
    REPAIRED = 32    # 1-minute bar whose high/low were widened within the tolerance
    FILLED = 64      # no trades in this bar; it stands flat at the previous close
    PATCHED = 128    # 1-minute bar taken from a patch file, absent from the main file
    COPIED = 256     # taken as it is from the downloaded candles of this timeframe


_MINUTE_ONLY = Flag.REPAIRED | Flag.PATCHED
_ORIGIN = Flag.ORIGINAL | Flag.MIXED
_NOT_INHERITED = _MINUTE_ONLY | _ORIGIN | Flag.FILLED | Flag.COPIED | Flag.PARTIAL | Flag.BAD_OHLC | Flag.UNFINISHED


@dataclass(frozen=True)
class RebuildConfig:
    convention: str = "utc"
    filler_min_minutes: int = 60   # this many minutes without a trade are a closure, fewer a pause
    repair_tolerance_pips: float = 1.0
    full_coverage: float = 0.9     # below this share of the normal length a rebuilt bar is PARTIAL
    min_coverage: float = 0.5      # below this share the downloaded candle is preferred


@dataclass
class SymbolResult:
    symbol: str
    pip: float
    bars: dict[str, pd.DataFrame]
    filler: clean.FillerRuns
    raw_m1_rows: int
    untraded_rows: int                  # raw minutes with volume zero, dropped
    filled_rows: int                    # minutes inserted into short pauses
    patched_rows: int                   # minutes that came from a patch file
    repaired_rows: int
    data_end: int                       # UTC ms just after the last usable bar
    typical_minutes: dict[int, float]   # weekday -> median length of a trading day in minutes
    daily_coverage: pd.DataFrame = field(repr=False, default=None)


@dataclass
class _Agg:
    key: np.ndarray
    open: np.ndarray
    high: np.ndarray
    low: np.ndarray
    close: np.ndarray
    volume: np.ndarray    # NaN where the source has no volumes
    n_m1: np.ndarray      # 1-minute bars behind the bar
    covered: np.ndarray   # minutes of trading the bar stands for, whatever its origin
    flags: np.ndarray

    def __len__(self) -> int:
        return len(self.key)

    def take(self, rows) -> "_Agg":
        return _Agg(**{name: getattr(self, name)[rows] for name in _FIELDS})

    def frame(self, timestamps: np.ndarray) -> pd.DataFrame:
        return pd.DataFrame(
            {
                "timestamp": timestamps.astype("int64"),
                "open": self.open,
                "high": self.high,
                "low": self.low,
                "close": self.close,
                "volume": self.volume,
                "n_m1": self.n_m1.astype("int32"),
                "bar_flags": self.flags.astype("int16"),
            }
        )


def _concat(parts: list[_Agg]) -> _Agg:
    joined = {name: np.concatenate([getattr(part, name) for part in parts]) for name in _FIELDS}
    order = np.argsort(joined["key"], kind="stable")
    return _Agg(**{name: values[order] for name, values in joined.items()})


def group_starts(keys: np.ndarray) -> np.ndarray:
    """Index of the first row of every run of equal keys."""
    if len(keys) == 0:
        return np.empty(0, dtype="int64")
    return np.flatnonzero(np.r_[True, keys[1:] != keys[:-1]])


def aggregate(keys: np.ndarray, source: _Agg) -> _Agg:
    """Combine consecutive bars that share a key; ``keys`` must not decrease.

    Prices come from the bars that traded. Bars inserted into pauses count as
    time covered but do not move open, high, low or close, so the result equals
    the candle the data provider builds from the same trades. Only a period
    without any trade takes the flat price and is itself marked FILLED.

    The origin of the result follows from the origins of its parts: ORIGINAL if
    none of them rests on 1-minute data, MIXED if only some do.
    """
    if len(keys) and (np.diff(keys) < 0).any():
        raise ValueError("bars are not ordered by their target period")
    starts = group_starts(keys)
    if len(starts) == 0:
        return source.take(np.empty(0, dtype="int64"))
    ends = np.r_[starts[1:], len(keys)]

    without_minutes = (source.flags & Flag.ORIGINAL) > 0
    partly = (source.flags & Flag.MIXED) > 0
    all_without = np.minimum.reduceat(without_minutes, starts)
    some_without = np.maximum.reduceat(without_minutes | partly, starts)
    inherited = np.bitwise_or.reduceat(source.flags & ~_NOT_INHERITED, starts)
    flags = inherited | np.where(all_without, int(Flag.ORIGINAL), np.where(some_without, int(Flag.MIXED), 0))

    traded = (source.flags & Flag.FILLED) == 0
    row = np.arange(len(keys))
    first = np.minimum.reduceat(np.where(traded, row, len(keys)), starts)
    last = np.maximum.reduceat(np.where(traded, row, -1), starts)
    quiet = last < 0
    first, last = np.where(quiet, starts, first), np.where(quiet, ends - 1, last)
    high = np.maximum.reduceat(np.where(traded, source.high, -np.inf), starts)
    low = np.minimum.reduceat(np.where(traded, source.low, np.inf), starts)
    flags = np.where(quiet, flags | Flag.FILLED, flags)

    return _Agg(
        key=keys[starts],
        open=source.open[first],
        high=np.where(quiet, source.high[first], high),
        low=np.where(quiet, source.low[first], low),
        close=source.close[last],
        volume=np.add.reduceat(source.volume, starts),
        n_m1=np.add.reduceat(source.n_m1, starts),
        covered=np.add.reduceat(source.covered, starts),
        flags=flags,
    )


def _mark_bad_ohlc(bars: _Agg) -> None:
    bad = clean.ohlc_violation(bars.open, bars.high, bars.low, bars.close) > 0
    bars.flags = np.where(bad, bars.flags | Flag.BAD_OHLC, bars.flags & ~Flag.BAD_OHLC)


def _mark_unfinished(bars: _Agg, session_ends: np.ndarray, data_end: int) -> None:
    bars.flags = np.where(session_ends > data_end, bars.flags | Flag.UNFINISHED, bars.flags & ~Flag.UNFINISHED)


def _volumes(frame: pd.DataFrame) -> np.ndarray:
    return frame[VOLUME].to_numpy() if VOLUME in frame else np.full(len(frame), np.nan)


def _empty() -> _Agg:
    whole, real = np.empty(0, dtype="int64"), np.empty(0)
    return _Agg(whole, real, real, real, real, real, whole, whole, whole)


@dataclass
class _Cleaned:
    minutes: _Agg
    filler: clean.FillerRuns
    untraded_rows: int = 0
    filled_rows: int = 0
    repaired_rows: int = 0
    patched_rows: int = 0


def _clean_minutes(frame: pd.DataFrame, pip: float, config: RebuildConfig) -> _Cleaned:
    ts = frame["timestamp"].to_numpy()
    o, h, l, c = (frame[name].to_numpy() for name in PRICE_COLUMNS)
    volume = _volumes(frame)
    h, l, repaired = clean.widen_small_violations(o, h, l, c, config.repair_tolerance_pips * pip)

    if VOLUME in frame:
        traded = volume > 0
        filler = clean.FillerRuns(~traded, np.empty(0, "int64"), np.empty(0, "int64"), np.empty(0))
        untraded = int((~traded).sum())
    else:
        filler = clean.find_filler(ts, o, h, l, c, config.filler_min_minutes)
        traded = ~filler.mask
        untraded = 0

    count = int(traded.sum())
    patched = frame[PATCHED].to_numpy()[traded] if PATCHED in frame else np.zeros(count, dtype=bool)
    flags = np.where(repaired[traded], int(Flag.REPAIRED), 0) | np.where(patched, int(Flag.PATCHED), 0)
    ones = np.ones(count, dtype="int64")
    kept = _Agg(ts[traded], o[traded], h[traded], l[traded], c[traded], volume[traded], ones, ones.copy(), flags.astype("int64"))

    pause_ts, price = clean.fill_short_gaps(kept.key, kept.close, config.filler_min_minutes - 1)
    ones = np.ones(len(pause_ts), dtype="int64")
    quiet = np.full(len(pause_ts), 0.0 if VOLUME in frame else np.nan)
    pauses = _Agg(pause_ts, price, price, price, price, quiet, ones, ones.copy(), np.full(len(pause_ts), int(Flag.FILLED), dtype="int64"))

    minutes = _concat([kept, pauses]) if len(pauses) else kept
    _mark_bad_ohlc(minutes)
    return _Cleaned(minutes, filler, untraded, len(pauses), int(repaired[traded].sum()), int(patched.sum()))


def _traded(frame: pd.DataFrame) -> pd.DataFrame:
    """Drop candles without trades; files without volumes are taken as they are."""
    return frame[frame[VOLUME] > 0] if VOLUME in frame else frame


def _copied(frame: pd.DataFrame, keys: np.ndarray, minutes_each: int) -> _Agg:
    """Downloaded candles of one timeframe as they are."""
    rows = len(frame)
    o, h, l, c = (frame[name].to_numpy() for name in PRICE_COLUMNS)
    flags = np.full(rows, int(Flag.ORIGINAL | Flag.COPIED), dtype="int64")
    return _Agg(keys, o, h, l, c, _volumes(frame), np.zeros(rows, "int64"), np.full(rows, minutes_each, "int64"), flags)


def _copied_hourly(frame: pd.DataFrame, calendar: SessionCalendar) -> _Agg:
    frame = _traded(frame)
    ts = frame["timestamp"].to_numpy()
    if len(ts) and (calendar.bar_start(ts, HOURLY) != ts).any():
        raise ValueError("hourly candles do not start on the hour")
    return _copied(frame, ts, 60)


def _copied_daily(frame: pd.DataFrame, calendar: SessionCalendar, typical: dict[int, float]) -> _Agg:
    """Downloaded daily candles keyed by trading day. Their timestamps carry the date at 00:00 UTC."""
    frame = _traded(frame)
    day = frame["timestamp"].to_numpy() // timeframes.DAY_MS
    weekday = calendar.weekday(day)
    day = day + np.where(weekday >= 5, 7 - weekday, 0)
    bars = _copied(frame, day, 0)
    starts = group_starts(day)
    merged = aggregate(day, bars)   # a Sunday candle joins the Monday after it
    merged.flags = np.full(len(merged), int(Flag.ORIGINAL | Flag.COPIED), dtype="int64")
    length = pd.Series(calendar.weekday(day[starts])).map(typical).fillna(1440).to_numpy()
    merged.covered = length.astype("int64")
    return merged


def _splice(rebuilt: _Agg, copied: _Agg | None, normal: np.ndarray, last_key: int, config: RebuildConfig) -> _Agg:
    """Choose one origin per period: what was rebuilt from finer bars, or the downloaded candle.

    ``normal`` is the usual length in minutes of each rebuilt period.
    """
    coverage = rebuilt.covered / normal
    rebuilt.flags = np.where(coverage < config.full_coverage, rebuilt.flags | Flag.PARTIAL, rebuilt.flags)
    if copied is None or len(copied) == 0:
        return rebuilt
    if len(rebuilt) == 0:
        return copied
    has_copy = np.isin(rebuilt.key, copied.key)
    # The period in progress at the end of data stays rebuilt so that it matches the finer bars.
    keep_rebuilt = (coverage >= config.min_coverage) | ~has_copy | (rebuilt.key >= last_key)
    keep_copied = ~np.isin(copied.key, rebuilt.key[keep_rebuilt])
    return _concat([rebuilt.take(keep_rebuilt), copied.take(keep_copied)])


def _present(frame: pd.DataFrame | None) -> bool:
    return frame is not None and len(frame) > 0


def rebuild_symbol(
    symbol: str,
    minutes_raw: pd.DataFrame | None,
    original_daily: pd.DataFrame | None,
    config: RebuildConfig = RebuildConfig(),
    original_hourly: pd.DataFrame | None = None,
) -> SymbolResult:
    """Build all timeframes of one symbol.

    ``minutes_raw``, ``original_hourly`` and ``original_daily`` are the raw
    downloads of 1-minute, hourly and daily candles. Any may be missing; a
    timeframe finer than the finest download is not produced.

    Hourly candles are only used when they come with volumes. Without them
    hours of a shut market cannot be told from hours of trading.
    """
    calendar = SessionCalendar(config.convention)
    reference = next((frame for frame in (minutes_raw, original_hourly, original_daily) if _present(frame)), None)
    if reference is None:
        raise ValueError(f"{symbol}: no data")
    pip = pip_size(reference["close"].to_numpy())
    bars: dict[str, _Agg] = {}

    if _present(minutes_raw):
        cleaned = _clean_minutes(minutes_raw, pip, config)
        minutes = cleaned.minutes
        bars["m1"] = minutes
        bars["m15"] = aggregate(calendar.bar_start(minutes.key, timeframes.get("m15")), minutes)
        hourly = aggregate(calendar.bar_start(minutes.key, HOURLY), minutes)
    else:
        cleaned = _Cleaned(_empty(), clean.FillerRuns(np.empty(0, bool), np.empty(0, "int64"), np.empty(0, "int64"), np.empty(0)))
        hourly = _empty()

    use_hourly = _present(original_hourly) and VOLUME in original_hourly
    copied_hours = _copied_hourly(original_hourly, calendar) if use_hourly else None
    last_hour = int(hourly.key[-1]) if len(hourly) else np.iinfo("int64").max
    hourly = _splice(hourly, copied_hours, np.full(len(hourly), 60), last_hour, config)

    if len(hourly):
        bars["h1"] = hourly
        bars["h4"] = aggregate(calendar.bar_start(hourly.key, timeframes.get("h4")), hourly)
        rebuilt_days = aggregate(calendar.trading_day(hourly.key), hourly)
        weekday = calendar.weekday(rebuilt_days.key)
        typical = pd.Series(rebuilt_days.covered).groupby(weekday).median()
        typical_minutes = {int(k): float(v) for k, v in typical.items()}
        normal = typical.reindex(weekday).to_numpy()
        daily_coverage = pd.DataFrame({"day": rebuilt_days.key, "minutes": rebuilt_days.covered, "coverage": rebuilt_days.covered / normal})
        last_day = int(rebuilt_days.key[-1])
        data_end = int(bars["m1"].key[-1]) + MINUTE_MS if "m1" in bars else int(hourly.key[-1]) + HOUR_MS
    else:
        rebuilt_days, typical_minutes, normal, last_day = _empty(), {}, np.empty(0), np.iinfo("int64").max
        daily_coverage = pd.DataFrame({"day": [], "minutes": [], "coverage": []})
        data_end = None

    copied_days = _copied_daily(original_daily, calendar, typical_minutes) if _present(original_daily) else None
    daily = _splice(rebuilt_days, copied_days, normal, last_day, config)
    if data_end is None:
        data_end = int(calendar.session_end(calendar.day_to_utc(daily.key[-1:]), timeframes.DAILY)[0])

    bars["d1"] = daily
    for tf in timeframes.ALL:
        if tf.kind in ("week", "month"):
            bars[tf.name] = aggregate(calendar.period_start_day(daily.key, tf), daily)

    frames: dict[str, pd.DataFrame] = {}
    for tf in timeframes.ALL:
        built = bars.get(tf.name)
        if built is None:
            continue
        timestamps = built.key if tf.is_intraday else calendar.day_to_utc(built.key)
        if tf.name != "m1":
            built.flags = built.flags & ~_MINUTE_ONLY
            _mark_bad_ohlc(built)
            _mark_unfinished(built, calendar.session_end(timestamps, tf), data_end)
        frames[tf.name] = built.frame(timestamps)

    return SymbolResult(
        symbol=symbol,
        pip=pip,
        bars=frames,
        filler=cleaned.filler,
        raw_m1_rows=len(minutes_raw) if _present(minutes_raw) else 0,
        untraded_rows=cleaned.untraded_rows,
        filled_rows=cleaned.filled_rows,
        patched_rows=cleaned.patched_rows,
        repaired_rows=cleaned.repaired_rows,
        data_end=data_end,
        typical_minutes=typical_minutes,
        daily_coverage=daily_coverage,
    )
