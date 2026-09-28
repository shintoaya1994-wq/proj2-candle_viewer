import numpy as np
import pytest

from candle_viewer.market import timeframes
from candle_viewer.market.sessions import SessionCalendar

from .conftest import ms

TF = timeframes.BY_NAME


def start(calendar: SessionCalendar, instant: str, tf: str) -> int:
    return int(calendar.bar_start(np.array([ms(instant)]), TF[tf])[0])


def end(calendar: SessionCalendar, bar: str, tf: str) -> int:
    return int(calendar.bar_end(np.array([ms(bar)]), TF[tf])[0])


def session_end(calendar: SessionCalendar, bar: str, tf: str) -> int:
    return int(calendar.session_end(np.array([ms(bar)]), TF[tf])[0])


def test_unknown_convention_is_rejected():
    with pytest.raises(ValueError):
        SessionCalendar("berlin")


class TestUtc:
    cal = SessionCalendar("utc")

    @pytest.mark.parametrize(
        "tf, expected",
        [("m1", "2024-01-10 13:47"), ("m15", "2024-01-10 13:45"), ("h1", "2024-01-10 13:00"), ("h4", "2024-01-10 12:00"),
         ("d1", "2024-01-10"), ("w1", "2024-01-08"), ("1mo", "2024-01-01"), ("3mo", "2024-01-01")],
    )
    def test_weekday_instant(self, tf, expected):
        assert start(self.cal, "2024-01-10 13:47", tf) == ms(expected)

    def test_sunday_evening_belongs_to_monday(self):
        assert start(self.cal, "2024-01-07 22:30", "d1") == ms("2024-01-08")
        assert start(self.cal, "2024-01-07 22:30", "w1") == ms("2024-01-08")

    def test_sunday_evening_keeps_its_own_intraday_bars(self):
        assert start(self.cal, "2024-01-07 22:30", "h1") == ms("2024-01-07 22:00")
        assert start(self.cal, "2024-01-07 22:30", "h4") == ms("2024-01-07 20:00")

    def test_sunday_evening_before_a_new_year_opens_the_new_periods(self):
        # 2023-12-31 is a Sunday: its session is the first of January and of the first quarter.
        assert start(self.cal, "2023-12-31 22:30", "d1") == ms("2024-01-01")
        assert start(self.cal, "2023-12-31 22:30", "1mo") == ms("2024-01-01")
        assert start(self.cal, "2023-12-31 22:30", "3mo") == ms("2024-01-01")

    def test_quarters_start_in_january_april_july_october(self):
        assert start(self.cal, "2024-06-28 10:00", "3mo") == ms("2024-04-01")
        assert start(self.cal, "2024-09-30 10:00", "3mo") == ms("2024-07-01")
        assert start(self.cal, "1993-11-15 10:00", "3mo") == ms("1993-10-01")

    @pytest.mark.parametrize(
        "tf, bar, expected",
        [("m15", "2024-01-10 13:45", "2024-01-10 14:00"), ("h4", "2024-01-10 20:00", "2024-01-11 00:00"), ("d1", "2024-01-10", "2024-01-11"),
         ("w1", "2024-01-08", "2024-01-15"), ("1mo", "2024-02-01", "2024-03-01"), ("3mo", "2023-10-01", "2024-01-01")],
    )
    def test_bar_end(self, tf, bar, expected):
        assert end(self.cal, bar, tf) == ms(expected)


    def test_periods_reaching_into_the_weekend_are_over_at_the_friday_close(self):
        winter_close, summer_close = ms("2024-01-12 22:00"), ms("2024-07-12 21:00")
        assert session_end(self.cal, "2024-01-12", "d1") == winter_close
        assert session_end(self.cal, "2024-01-08", "w1") == winter_close
        assert session_end(self.cal, "2024-01-12 20:00", "h4") == winter_close
        assert session_end(self.cal, "2024-07-12 20:00", "h4") == summer_close
        assert session_end(self.cal, "2024-07-12 20:00", "h1") == ms("2024-07-12 21:00")
        # August 2024 ends on a Saturday, June 2024 on a Sunday.
        assert session_end(self.cal, "2024-08-01", "1mo") == ms("2024-08-30 21:00")
        assert session_end(self.cal, "2024-04-01", "3mo") == ms("2024-06-28 21:00")

    def test_periods_ending_midweek_run_to_their_nominal_end(self):
        assert session_end(self.cal, "2024-01-10", "d1") == ms("2024-01-11")
        assert session_end(self.cal, "2024-01-01", "1mo") == ms("2024-02-01")
        assert session_end(self.cal, "2024-01-10 12:00", "h4") == ms("2024-01-10 16:00")


class TestNyClose:
    cal = SessionCalendar("nyclose")

    def test_week_is_over_at_the_friday_close(self):
        assert session_end(self.cal, "2024-01-07 22:00", "w1") == ms("2024-01-12 22:00")
        assert session_end(self.cal, "2024-01-11 22:00", "d1") == ms("2024-01-12 22:00")
        assert session_end(self.cal, "2024-07-12 17:00", "h4") == ms("2024-07-12 21:00")

    def test_day_starts_at_new_york_close_in_winter(self):
        # 17:00 in New York is 22:00 UTC while standard time applies.
        assert start(self.cal, "2024-01-10 21:59", "d1") == ms("2024-01-09 22:00")
        assert start(self.cal, "2024-01-10 22:00", "d1") == ms("2024-01-10 22:00")

    def test_day_starts_at_new_york_close_in_summer(self):
        # 17:00 in New York is 21:00 UTC during daylight saving time.
        assert start(self.cal, "2024-07-10 20:59", "d1") == ms("2024-07-09 21:00")
        assert start(self.cal, "2024-07-10 21:00", "d1") == ms("2024-07-10 21:00")

    def test_week_opens_with_the_sunday_session(self):
        assert start(self.cal, "2024-01-07 22:30", "d1") == ms("2024-01-07 22:00")
        assert start(self.cal, "2024-01-07 22:30", "w1") == ms("2024-01-07 22:00")
        assert start(self.cal, "2024-01-12 21:59", "w1") == ms("2024-01-07 22:00")

    def test_four_hour_bars_divide_the_trading_day(self):
        assert start(self.cal, "2024-01-07 22:30", "h4") == ms("2024-01-07 22:00")
        assert start(self.cal, "2024-01-08 02:00", "h4") == ms("2024-01-08 02:00")
        assert start(self.cal, "2024-07-08 00:59", "h4") == ms("2024-07-07 21:00")

    def test_hourly_bars_are_the_same_as_in_utc(self):
        assert start(self.cal, "2024-07-10 13:47", "h1") == ms("2024-07-10 13:00")

    def test_month_starts_at_the_close_before_its_first_day(self):
        assert start(self.cal, "2024-03-15 12:00", "1mo") == ms("2024-02-29 22:00")
        assert start(self.cal, "2024-07-15 12:00", "3mo") == ms("2024-06-30 21:00")

    def test_bar_end_across_the_switch_to_daylight_saving(self):
        # US clocks change on Sunday 2024-03-10; the week before ends an hour earlier in UTC.
        assert end(self.cal, "2024-03-07 22:00", "d1") == ms("2024-03-08 22:00")
        assert end(self.cal, "2024-03-03 22:00", "w1") == ms("2024-03-10 21:00")
        assert end(self.cal, "2024-03-10 21:00", "d1") == ms("2024-03-11 21:00")

    def test_round_trip(self):
        instants = np.array([ms("2024-01-10 13:47"), ms("2024-07-10 13:47"), ms("2024-03-08 21:30"), ms("2024-11-04 02:15")])
        assert (self.cal.to_utc(self.cal.to_chart(instants)) == instants).all()
