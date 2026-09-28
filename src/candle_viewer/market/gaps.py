"""Periods without usable 1-minute data.

A gap is the time between two consecutive cleaned minutes that are more than
one minute apart. Weekends and the holidays the download leaves out are
expected; everything else is a hole in the data.
"""

from __future__ import annotations

import datetime as dt

import numpy as np
import pandas as pd

from .timeframes import DAY_MS, MINUTE_MS

_NY = "America/New_York"
# Minutes of trading a gap may swallow and still count as an ordinary closure.
# Covers the download's fixed weekend window, which is an hour off in summer.
CLOSURE_TOLERANCE_MINUTES = 240

COLUMNS = ("start", "end", "minutes", "lost_minutes", "filler_minutes", "kind")


def good_friday(year: int) -> dt.date:
    """Friday before Easter Sunday (Gregorian calendar, Meeus/Jones/Butcher)."""
    a = year % 19
    b, c = divmod(year, 100)
    d, e = divmod(b, 4)
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i, k = divmod(c, 4)
    l = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * l) // 451
    month, day = divmod(h + l - 7 * m + 114, 31)
    return dt.date(year, month, day + 1) - dt.timedelta(days=2)


def _ny_to_utc_ms(local: pd.Timestamp) -> int:
    return int(local.tz_localize(_NY).tz_convert("UTC").tz_localize(None).value // 1_000_000)


def closures(start: int, end: int) -> list[tuple[int, int, str]]:
    """Expected market closures overlapping [start, end): weekends and left-out holidays."""
    found: list[tuple[int, int, str]] = []
    first = pd.Timestamp(start, unit="ms").normalize() - pd.Timedelta(days=7)
    last = pd.Timestamp(end, unit="ms").normalize() + pd.Timedelta(days=7)

    friday = first + pd.Timedelta(days=(4 - first.weekday()) % 7)
    while friday <= last:
        close = _ny_to_utc_ms(friday + pd.Timedelta(hours=17))
        reopen = _ny_to_utc_ms(friday + pd.Timedelta(days=2, hours=17))
        found.append((close, reopen, "weekend"))
        friday += pd.Timedelta(days=7)

    for year in range(first.year, last.year + 1):
        for day in (dt.date(year, 1, 1), dt.date(year, 12, 25), good_friday(year)):
            begin = int(pd.Timestamp(day).value // 1_000_000)
            found.append((begin, begin + DAY_MS, "holiday"))

    return [(a, b, kind) for a, b, kind in found if a < end and b > start]


def _covered_minutes(start: int, end: int, intervals: list[tuple[int, int, str]]) -> int:
    """Minutes of [start, end) inside the union of ``intervals``."""
    clipped = sorted((max(a, start), min(b, end)) for a, b, _ in intervals)
    total, reach = 0, start
    for a, b in clipped:
        if b > reach:
            total += b - max(a, reach)
            reach = b
    return total // MINUTE_MS


def find_gaps(clean_ts: np.ndarray, raw_ts: np.ndarray) -> pd.DataFrame:
    """Gaps in the cleaned minutes.

    ``lost_minutes`` counts the part of a gap outside the expected closures;
    ``filler_minutes`` the part that held filler bars in the raw file.
    ``kind`` is ``weekend``, ``holiday`` or ``hole``.
    """
    clean_ts = np.asarray(clean_ts, dtype="int64")
    raw_ts = np.asarray(raw_ts, dtype="int64")
    jump = np.flatnonzero(np.diff(clean_ts) > MINUTE_MS)
    starts = clean_ts[jump] + MINUTE_MS
    ends = clean_ts[jump + 1]
    in_raw = np.searchsorted(raw_ts, ends, side="left") - np.searchsorted(raw_ts, starts, side="left")

    rows = []
    for start, end, filler in zip(starts.tolist(), ends.tolist(), in_raw.tolist()):
        minutes = (end - start) // MINUTE_MS
        expected = closures(start, end)
        lost = minutes - _covered_minutes(start, end, expected)
        if lost > CLOSURE_TOLERANCE_MINUTES or not expected:
            kind = "hole"
        elif any(k == "holiday" for _, _, k in expected):
            kind = "holiday"
        else:
            kind = "weekend"
        rows.append((start, end, minutes, lost, filler, kind))
    return pd.DataFrame(rows, columns=list(COLUMNS))


def weekend_edges(gaps: pd.DataFrame) -> pd.DataFrame:
    """For ordinary weekends: how far the data stops before the close and resumes after the open."""
    rows = []
    for start, end in gaps.loc[gaps["kind"] == "weekend", ["start", "end"]].itertuples(index=False):
        weekend = [c for c in closures(start, end) if c[2] == "weekend"]
        if len(weekend) != 1:
            continue
        close, reopen, _ = weekend[0]
        rows.append((start, (close - start) // MINUTE_MS, (end - reopen) // MINUTE_MS))
    return pd.DataFrame(rows, columns=["start", "early_close_minutes", "late_open_minutes"])


def describe(ms: int) -> str:
    return pd.Timestamp(ms, unit="ms").strftime("%Y-%m-%d %H:%M")

