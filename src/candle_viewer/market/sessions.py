"""Session calendars: how instants in time are assigned to bars.

All stored timestamps are UTC epoch milliseconds. A *chart clock* is the wall
clock bars are aligned to. Two conventions are supported:

``utc``
    The chart clock is UTC. Days start at 00:00 UTC.

``nyclose``
    The chart clock is New York time plus seven hours, so that the New York
    close (17:00) falls on midnight. This equals GMT+2 in winter and GMT+3
    during US daylight saving time, the convention of most MT4 servers. Every
    trading week then consists of five full days.

Rules common to both conventions:

* Intraday bars sit on a fixed grid of the chart clock.
* Anything traded on a Saturday or Sunday of the chart clock belongs to the
  trading day of the following Monday. Daily, weekly and monthly bars are built
  from trading days, so the Sunday evening session is part of Monday.
* A bar's timestamp is the nominal start of its period expressed in UTC.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from .timeframes import DAY_MS, MINUTE_MS, Timeframe

CONVENTIONS = ("utc", "nyclose")

_NY = "America/New_York"
_NY_SHIFT_MS = 7 * 3_600_000
_THURSDAY_OFFSET = 3  # 1970-01-01 was a Thursday; (day + 3) % 7 == 0 on Mondays


def _as_ms_index(values: np.ndarray) -> pd.DatetimeIndex:
    return pd.DatetimeIndex(np.asarray(values, dtype="int64").astype("datetime64[ms]"))


def _index_to_ms(index: pd.DatetimeIndex) -> np.ndarray:
    return index.as_unit("ms").asi8


@dataclass(frozen=True)
class SessionCalendar:
    """Assigns UTC instants to bars under one convention."""

    convention: str = "utc"

    def __post_init__(self) -> None:
        if self.convention not in CONVENTIONS:
            raise ValueError(f"unknown convention {self.convention!r}; expected one of {CONVENTIONS}")

    # -- chart clock -------------------------------------------------------

    def to_chart(self, ts_utc: np.ndarray) -> np.ndarray:
        """Chart-clock milliseconds for UTC instants."""
        ts_utc = np.asarray(ts_utc, dtype="int64")
        if self.convention == "utc":
            return ts_utc
        local = _as_ms_index(ts_utc).tz_localize("UTC").tz_convert(_NY).tz_localize(None)
        return _index_to_ms(local) + _NY_SHIFT_MS

    def to_utc(self, chart_ms: np.ndarray) -> np.ndarray:
        """UTC instants for chart-clock milliseconds (inverse of :meth:`to_chart`)."""
        chart_ms = np.asarray(chart_ms, dtype="int64")
        if self.convention == "utc":
            return chart_ms
        local = _as_ms_index(chart_ms - _NY_SHIFT_MS)
        # Ambiguous or missing local times only occur on Sundays while the market is shut.
        aware = local.tz_localize(_NY, ambiguous=np.ones(len(local), dtype=bool), nonexistent="shift_forward")
        return _index_to_ms(aware.tz_convert("UTC").tz_localize(None))

    # -- trading days ------------------------------------------------------

    def trading_day(self, ts_utc: np.ndarray) -> np.ndarray:
        """Trading day as days since 1970-01-01 on the chart clock; weekends roll to Monday."""
        day = self.to_chart(ts_utc) // DAY_MS
        weekday = (day + _THURSDAY_OFFSET) % 7
        return day + np.where(weekday >= 5, 7 - weekday, 0)

    @staticmethod
    def weekday(day: np.ndarray) -> np.ndarray:
        """Weekday of a day number, Monday = 0."""
        return (np.asarray(day, dtype="int64") + _THURSDAY_OFFSET) % 7

    def period_start_day(self, day: np.ndarray, tf: Timeframe) -> np.ndarray:
        """First day of the period of ``tf`` containing trading day ``day``."""
        day = np.asarray(day, dtype="int64")
        if tf.kind == "day":
            return day
        if tf.kind == "week":
            return day - self.weekday(day)
        if tf.kind == "month":
            months = day.astype("datetime64[D]").astype("datetime64[M]").astype("int64")
            months -= months % tf.span
            return months.astype("datetime64[M]").astype("datetime64[D]").astype("int64")
        raise ValueError(f"{tf.name} is not built from trading days")

    def period_end_day(self, start_day: np.ndarray, tf: Timeframe) -> np.ndarray:
        """Day after the last day of the period that starts on ``start_day``."""
        start_day = np.asarray(start_day, dtype="int64")
        if tf.kind == "day":
            return start_day + 1
        if tf.kind == "week":
            return start_day + 7
        if tf.kind == "month":
            months = start_day.astype("datetime64[D]").astype("datetime64[M]").astype("int64") + tf.span
            return months.astype("datetime64[M]").astype("datetime64[D]").astype("int64")
        raise ValueError(f"{tf.name} is not built from trading days")

    def day_to_utc(self, day: np.ndarray) -> np.ndarray:
        """UTC instant of chart-clock midnight of a day number."""
        return self.to_utc(np.asarray(day, dtype="int64") * DAY_MS)

    # -- bars --------------------------------------------------------------

    def bar_start(self, ts_utc: np.ndarray, tf: Timeframe) -> np.ndarray:
        """Timestamp of the bar of ``tf`` that contains each instant."""
        ts_utc = np.asarray(ts_utc, dtype="int64")
        if tf.is_intraday:
            step = tf.span * MINUTE_MS
            chart = self.to_chart(ts_utc)
            return self._unique_map(chart - chart % step, self.to_utc)
        start_day = self.period_start_day(self.trading_day(ts_utc), tf)
        return self._unique_map(start_day, self.day_to_utc)

    def bar_end(self, bar_start_utc: np.ndarray, tf: Timeframe) -> np.ndarray:
        """Nominal end (exclusive) of bars given their timestamps."""
        bar_start_utc = np.asarray(bar_start_utc, dtype="int64")
        if tf.is_intraday:
            return self.to_utc(self.to_chart(bar_start_utc) + tf.span * MINUTE_MS)
        start_day = self.to_chart(bar_start_utc) // DAY_MS
        return self.day_to_utc(self.period_end_day(start_day, tf))

    def weekly_close(self, day: np.ndarray) -> np.ndarray:
        """UTC instant of the New York close (17:00) on the Friday of the week of ``day``."""
        day = np.asarray(day, dtype="int64")
        friday = day - self.weekday(day) + 4

        def close_of(fridays: np.ndarray) -> np.ndarray:
            local = _as_ms_index(fridays * DAY_MS + 17 * 3_600_000)
            return _index_to_ms(local.tz_localize(_NY).tz_convert("UTC").tz_localize(None))

        uniq, inverse = np.unique(friday, return_inverse=True)
        return close_of(uniq)[inverse]

    def session_end(self, bar_start_utc: np.ndarray, tf: Timeframe) -> np.ndarray:
        """Instant after which nothing more can trade inside a bar.

        This is the nominal end, except that a period whose last day is a
        Friday or falls on the weekend is already over at the Friday close.
        """
        bar_start_utc = np.asarray(bar_start_utc, dtype="int64")
        nominal = self.bar_end(bar_start_utc, tf)
        start_day = self.to_chart(bar_start_utc) // DAY_MS
        if tf.is_intraday:
            on_friday = self.weekday(start_day) == 4
            return np.where(on_friday, np.minimum(nominal, self.weekly_close(start_day)), nominal)
        end_day = self.period_end_day(start_day, tf)
        last_day = end_day - 1
        ends_with_week = self.weekday(last_day) >= 4
        return np.where(ends_with_week, self.weekly_close(last_day), nominal)

    def _unique_map(self, values: np.ndarray, fn) -> np.ndarray:
        """Apply ``fn`` once per distinct value; inputs are highly repetitive."""
        if self.convention == "utc":
            return fn(values)
        uniq, inverse = np.unique(values, return_inverse=True)
        return fn(uniq)[inverse]
