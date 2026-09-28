import datetime as dt

import numpy as np
import pytest

from candle_viewer.market import gaps

from .conftest import minutes_between, ms, trading_weeks


@pytest.mark.parametrize("year, expected", [(2016, (3, 25)), (2019, (4, 19)), (2024, (3, 29)), (2025, (4, 18)), (2026, (4, 3))])
def test_good_friday(year, expected):
    assert gaps.good_friday(year) == dt.date(year, *expected)


def kinds(frame):
    return frame["kind"].tolist()


def test_ordinary_weekend():
    ts = trading_weeks("2024-01-07", 2)
    found = gaps.find_gaps(ts, ts)
    assert kinds(found) == ["weekend"]
    assert found.loc[0, ["start", "end", "minutes", "lost_minutes"]].tolist() == [ms("2024-01-12 22:00"), ms("2024-01-14 22:00"), 2880, 0]


def test_weekend_cut_an_hour_late_in_summer_is_still_a_weekend():
    # The download closes the week at 22:00 UTC all year; New York closes at 21:00 UTC in summer.
    ts = trading_weeks("2024-07-07", 2)
    found = gaps.find_gaps(ts, ts)
    assert kinds(found) == ["weekend"]
    assert found.loc[0, "lost_minutes"] == 60
    edges = gaps.weekend_edges(found)
    assert edges.loc[0, ["early_close_minutes", "late_open_minutes"]].tolist() == [-60, 60]


def test_left_out_holiday():
    ts = np.r_[minutes_between("2024-12-23", "2024-12-25"), minutes_between("2024-12-26", "2024-12-27")]
    found = gaps.find_gaps(ts, ts)
    assert kinds(found) == ["holiday"]
    assert found.loc[0, "lost_minutes"] == 0


def test_missing_weekday_is_a_hole():
    ts = np.r_[minutes_between("2024-01-08", "2024-01-10"), minutes_between("2024-01-11", "2024-01-12")]
    found = gaps.find_gaps(ts, ts)
    assert kinds(found) == ["hole"]
    assert found.loc[0, ["minutes", "lost_minutes", "filler_minutes"]].tolist() == [1440, 1440, 0]


def test_hole_running_into_a_weekend_counts_only_trading_time_as_lost():
    ts = np.r_[minutes_between("2024-01-08", "2024-01-12 10:00"), minutes_between("2024-01-14 22:00", "2024-01-15 12:00")]
    found = gaps.find_gaps(ts, ts)
    assert kinds(found) == ["hole"]
    assert found.loc[0, "lost_minutes"] == 12 * 60


def test_removed_filler_is_counted():
    raw = minutes_between("2024-01-08", "2024-01-10")
    clean = raw[(raw < ms("2024-01-09 03:00")) | (raw >= ms("2024-01-09 09:00"))]
    found = gaps.find_gaps(clean, raw)
    assert kinds(found) == ["hole"]
    assert found.loc[0, ["minutes", "filler_minutes"]].tolist() == [360, 360]
