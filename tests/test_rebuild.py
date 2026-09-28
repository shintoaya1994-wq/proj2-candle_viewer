import numpy as np
import pandas as pd
import pytest

from candle_viewer.market import rawdata
from candle_viewer.market.rebuild import Flag, RebuildConfig, rebuild_symbol

from .conftest import MINUTE, minutes_between, ms, random_walk, trading_weeks

PRICES = ["open", "high", "low", "close"]
COPIED = Flag.ORIGINAL | Flag.COPIED


def has(frame: pd.DataFrame, flag: Flag) -> pd.Series:
    return (frame["bar_flags"] & int(flag)) > 0


def reference(frame: pd.DataFrame, keys) -> pd.DataFrame:
    """Aggregation written independently of the pipeline."""
    grouped = frame.assign(key=np.asarray(keys)).groupby("key", sort=True)
    return pd.DataFrame({"open": grouped["open"].first(), "high": grouped["high"].max(), "low": grouped["low"].min(), "close": grouped["close"].last(), "n": grouped["open"].size()})


def assert_same_bars(built: pd.DataFrame, expected: pd.DataFrame):
    assert built["timestamp"].tolist() == expected.index.tolist()
    for name in PRICES:
        assert built[name].tolist() == expected[name].tolist(), name
    assert built["n_m1"].tolist() == expected["n"].tolist()


def daily_file(days: dict[str, tuple[float, float, float, float]]) -> pd.DataFrame:
    rows = [(ms(day), *values) for day, values in days.items()]
    return pd.DataFrame(rows, columns=["timestamp", *PRICES])


def test_intraday_bars_match_an_independent_aggregation(two_weeks):
    bars = rebuild_symbol("test", two_weeks, None).bars
    ts = two_weeks["timestamp"]
    for name, step in (("m15", 15), ("h1", 60), ("h4", 240)):
        assert_same_bars(bars[name], reference(two_weeks, ts // (step * MINUTE) * (step * MINUTE)))


def test_daily_bars_include_the_sunday_session(two_weeks):
    bars = rebuild_symbol("test", two_weeks, None).bars
    day = pd.to_datetime(two_weeks["timestamp"], unit="ms")
    trading_day = day.dt.normalize() + pd.to_timedelta((day.dt.weekday == 6).astype(int), unit="D")
    expected = reference(two_weeks, (trading_day.astype("datetime64[ms]").astype("int64")))
    assert_same_bars(bars["d1"], expected)
    monday = bars["d1"].iloc[0]
    assert monday["timestamp"] == ms("2024-01-08")
    assert monday["open"] == two_weeks["open"].iloc[0]
    assert monday["n_m1"] == 26 * 60


def test_every_timeframe_nests_in_the_next(two_weeks):
    bars = rebuild_symbol("test", two_weeks, None).bars
    week = bars["w1"]
    assert week["timestamp"].tolist() == [ms("2024-01-08"), ms("2024-01-15")]
    first_week = bars["d1"][bars["d1"]["timestamp"] < ms("2024-01-15")]
    assert week["open"].iloc[0] == first_week["open"].iloc[0]
    assert week["high"].iloc[0] == first_week["high"].max()
    assert week["low"].iloc[0] == first_week["low"].min()
    assert week["close"].iloc[0] == first_week["close"].iloc[-1]
    assert week["n_m1"].iloc[0] == 5 * 24 * 60
    for name in ("1mo", "3mo"):
        assert bars[name]["timestamp"].tolist() == [ms("2024-01-01")]
        assert bars[name]["high"].iloc[0] == two_weeks["high"].max()
        assert bars[name]["n_m1"].iloc[0] == len(two_weeks)


def test_rebuilt_bars_are_valid_candles(two_weeks):
    for frame in rebuild_symbol("test", two_weeks, None).bars.values():
        assert (frame["high"] >= frame[["open", "close"]].max(axis=1)).all()
        assert (frame["low"] <= frame[["open", "close"]].min(axis=1)).all()
        assert not has(frame, Flag.BAD_OHLC).any()
        assert frame["timestamp"].is_monotonic_increasing and frame["timestamp"].is_unique


def test_filler_is_removed_from_every_timeframe(two_weeks):
    stuck = two_weeks.copy()
    rows = stuck.index[(stuck["timestamp"] >= ms("2024-01-10 03:00")) & (stuck["timestamp"] < ms("2024-01-10 06:00"))]
    stuck.loc[rows, PRICES] = stuck.loc[rows[0] - 1, "close"]
    result = rebuild_symbol("test", stuck, None)
    assert result.filler.minutes.tolist() == [180]
    assert len(result.bars["m1"]) == len(two_weeks) - 180
    hours = set(result.bars["h1"]["timestamp"])
    assert ms("2024-01-10 02:00") in hours and ms("2024-01-10 06:00") in hours
    assert not hours & {ms("2024-01-10 03:00"), ms("2024-01-10 04:00"), ms("2024-01-10 05:00")}
    four_hours = result.bars["h4"].set_index("timestamp")["n_m1"]
    assert four_hours[ms("2024-01-10 00:00")] == 180 and four_hours[ms("2024-01-10 04:00")] == 120
    day = result.bars["d1"].set_index("timestamp").loc[ms("2024-01-10")]
    assert day["n_m1"] == 1440 - 180 and day["bar_flags"] == 0


class TestSplice:
    original = daily_file({
        "2024-01-04": (1.10, 1.11, 1.09, 1.105),   # before the minutes start
        "2024-01-05": (1.105, 1.12, 1.10, 1.11),
        "2024-01-08": (9.0, 9.0, 9.0, 9.0),        # fully covered by minutes: must lose
        "2024-01-10": (1.30, 1.31, 1.29, 1.30),    # minutes missing on this day
        "2024-01-11": (1.40, 1.41, 1.39, 1.40),    # minutes cover two hours only
    })

    @pytest.fixture
    def result(self, two_weeks):
        ts = two_weeks["timestamp"]
        hole = (ts >= ms("2024-01-10")) & (ts < ms("2024-01-11"))
        mostly_missing = (ts >= ms("2024-01-11 02:00")) & (ts < ms("2024-01-12"))
        return rebuild_symbol("test", two_weeks[~hole & ~mostly_missing].reset_index(drop=True), self.original)

    def test_days_before_the_minutes_come_from_the_original(self, result):
        daily = result.bars["d1"].set_index("timestamp")
        assert daily.index[0] == ms("2024-01-04")
        assert daily.loc[ms("2024-01-05"), PRICES].tolist() == [1.105, 1.12, 1.10, 1.11]
        assert daily.loc[ms("2024-01-05"), "bar_flags"] == COPIED
        assert daily.loc[ms("2024-01-05"), "n_m1"] == 0

    def test_covered_days_are_rebuilt(self, result):
        monday = result.bars["d1"].set_index("timestamp").loc[ms("2024-01-08")]
        assert monday["bar_flags"] == 0 and monday["high"] < 2

    def test_days_without_minutes_fall_back_to_the_original(self, result):
        daily = result.bars["d1"].set_index("timestamp")
        assert daily.loc[ms("2024-01-10"), PRICES].tolist() == [1.30, 1.31, 1.29, 1.30]
        assert daily.loc[ms("2024-01-10"), "bar_flags"] == COPIED

    def test_thinly_covered_day_prefers_the_original(self, result):
        daily = result.bars["d1"].set_index("timestamp")
        assert daily.loc[ms("2024-01-11"), PRICES].tolist() == [1.40, 1.41, 1.39, 1.40]
        assert daily.loc[ms("2024-01-11"), "bar_flags"] == COPIED
        # The two hours that exist are still present in the intraday bars.
        assert ms("2024-01-11 01:00") in set(result.bars["h1"]["timestamp"])

    def test_weekly_and_monthly_bars_are_marked_as_mixed(self, result):
        weeks = result.bars["w1"].set_index("timestamp")
        assert weeks.loc[ms("2024-01-01"), "bar_flags"] == Flag.ORIGINAL
        assert has(weeks, Flag.MIXED).loc[ms("2024-01-08")]
        assert not has(weeks, Flag.ORIGINAL).loc[ms("2024-01-08")]
        assert weeks.loc[ms("2024-01-08"), "high"] == 1.41
        assert weeks.loc[ms("2024-01-15"), "bar_flags"] == 0
        assert has(result.bars["1mo"], Flag.MIXED).all()


def test_partly_covered_day_without_original_is_marked_partial(two_weeks):
    ts = two_weeks["timestamp"]
    hole = (ts >= ms("2024-01-10 12:00")) & (ts < ms("2024-01-10 20:00"))
    daily = rebuild_symbol("test", two_weeks[~hole].reset_index(drop=True), None).bars["d1"].set_index("timestamp")
    assert daily.loc[ms("2024-01-10"), "bar_flags"] == Flag.PARTIAL
    assert daily.loc[ms("2024-01-10"), "n_m1"] == 16 * 60
    assert daily.loc[ms("2024-01-09"), "bar_flags"] == 0


def test_day_in_progress_stays_rebuilt_and_is_unfinished(two_weeks):
    cut = two_weeks[two_weeks["timestamp"] < ms("2024-01-17 02:00")]
    original = daily_file({"2024-01-17": (5.0, 5.0, 5.0, 5.0)})
    result = rebuild_symbol("test", cut, original)
    assert result.data_end == ms("2024-01-17 02:00")
    last = result.bars["d1"].iloc[-1]
    assert last["timestamp"] == ms("2024-01-17") and last["high"] < 2
    assert last["bar_flags"] == Flag.PARTIAL | Flag.UNFINISHED
    for name in ("h4", "w1", "1mo", "3mo"):
        assert has(result.bars[name], Flag.UNFINISHED).tolist()[-1]
        assert not has(result.bars[name], Flag.UNFINISHED).tolist()[:-1].count(True)
    assert not has(result.bars["h1"], Flag.UNFINISHED).any()


def test_week_ending_at_the_friday_close_is_finished(two_weeks):
    result = rebuild_symbol("test", two_weeks, None)
    assert result.data_end == ms("2024-01-19 22:00")
    for name in ("m15", "h1", "h4", "d1", "w1"):
        assert not has(result.bars[name], Flag.UNFINISHED).any(), name
    assert has(result.bars["1mo"], Flag.UNFINISHED).all()


def test_small_overshoot_is_repaired_and_flagged(two_weeks):
    broken = two_weeks.copy()
    broken.loc[500, "high"] = broken.loc[500, ["open", "close"]].max() - 0.00002
    result = rebuild_symbol("test", broken, None)
    assert result.repaired_rows == 1
    minute = result.bars["m1"].iloc[500]
    assert minute["bar_flags"] == Flag.REPAIRED
    assert minute["high"] == max(minute["open"], minute["close"])
    assert not has(result.bars["h1"], Flag.REPAIRED).any()


def test_daily_data_alone_is_enough():
    original = daily_file({"2024-01-04": (1.10, 1.11, 1.09, 1.105), "2024-01-05": (1.105, 1.12, 1.10, 1.11), "2024-01-08": (1.11, 1.13, 1.10, 1.12)})
    bars = rebuild_symbol("test", None, original).bars
    assert "m1" not in bars and "h1" not in bars
    assert bars["w1"]["timestamp"].tolist() == [ms("2024-01-01"), ms("2024-01-08")]
    assert bars["w1"]["high"].tolist() == [1.12, 1.13]
    assert (bars["d1"]["bar_flags"] == COPIED).all()
    assert bars["w1"]["bar_flags"].tolist() == [Flag.ORIGINAL, Flag.ORIGINAL | Flag.UNFINISHED]


def test_new_york_close_convention_gives_five_full_days(two_weeks):
    bars = rebuild_symbol("test", two_weeks, None, RebuildConfig(convention="nyclose")).bars
    daily = bars["d1"]
    assert len(daily) == 10
    assert daily["timestamp"].iloc[0] == ms("2024-01-07 22:00")
    assert (daily["n_m1"] == 1440).all()
    assert (bars["h4"]["n_m1"] == 240).all()
    assert bars["w1"]["timestamp"].tolist() == [ms("2024-01-07 22:00"), ms("2024-01-14 22:00")]


class TestVolumes:
    def test_minutes_without_trades_are_dropped(self, two_weeks_with_volume):
        raw = two_weeks_with_volume.copy()
        closed = (raw["timestamp"] >= ms("2024-01-10 03:00")) & (raw["timestamp"] < ms("2024-01-10 06:00"))
        raw.loc[closed, "volume"] = 0.0
        result = rebuild_symbol("test", raw, None)
        assert result.untraded_rows == 180
        assert result.filled_rows == 0
        assert len(result.bars["m1"]) == len(raw) - 180
        assert ms("2024-01-10 04:00") not in set(result.bars["h1"]["timestamp"])

    def test_short_pause_is_filled_at_the_previous_close(self, two_weeks_with_volume):
        raw = two_weeks_with_volume
        pause = (raw["timestamp"] >= ms("2024-01-10 03:00")) & (raw["timestamp"] < ms("2024-01-10 03:20"))
        result = rebuild_symbol("test", raw[~pause].reset_index(drop=True), None)
        assert result.filled_rows == 20
        minutes = result.bars["m1"].set_index("timestamp")
        assert len(minutes) == len(raw)
        before = minutes.loc[ms("2024-01-10 02:59"), "close"]
        filled = minutes.loc[ms("2024-01-10 03:00") : ms("2024-01-10 03:19")]
        assert (filled[PRICES] == before).all().all()
        assert (filled["volume"] == 0).all()
        assert (filled["bar_flags"] == Flag.FILLED).all()

    def test_inserted_minutes_do_not_move_the_prices_of_coarser_bars(self, two_weeks_with_volume):
        raw = two_weeks_with_volume.set_index("timestamp")
        pause = (raw.index >= ms("2024-01-10 03:00")) & (raw.index < ms("2024-01-10 03:20"))
        bars = rebuild_symbol("test", raw[~pause].reset_index(), None).bars
        before = raw.loc[ms("2024-01-10 02:59"), "close"]
        traded = raw.loc[ms("2024-01-10 03:20") : ms("2024-01-10 03:59")]

        hour = bars["h1"].set_index("timestamp").loc[ms("2024-01-10 03:00")]
        assert hour[PRICES].tolist() == [traded["open"].iloc[0], traded["high"].max(), traded["low"].min(), traded["close"].iloc[-1]]
        assert hour["n_m1"] == 60 and hour["bar_flags"] == 0
        assert hour["volume"] == pytest.approx(traded["volume"].sum())

        quarters = bars["m15"].set_index("timestamp")
        silent = quarters.loc[ms("2024-01-10 03:00")]
        assert silent[PRICES].tolist() == [before] * 4 and silent["volume"] == 0
        assert silent["bar_flags"] == Flag.FILLED and silent["n_m1"] == 15
        partly = quarters.loc[ms("2024-01-10 03:15")]
        assert partly["open"] == traded["open"].iloc[0] and partly["bar_flags"] == 0 and partly["n_m1"] == 15
        assert has(quarters, Flag.FILLED).sum() == 1

    def test_volume_adds_up_through_the_timeframes(self, two_weeks_with_volume):
        bars = rebuild_symbol("test", two_weeks_with_volume, None).bars
        total = two_weeks_with_volume["volume"].sum()
        for name in ("m15", "h1", "h4", "d1", "w1", "1mo", "3mo"):
            assert bars[name]["volume"].sum() == pytest.approx(total), name

    def test_original_daily_bars_carry_their_volume(self, two_weeks_with_volume):
        original = daily_file({"2024-01-04": (1.10, 1.11, 1.09, 1.105)}).assign(volume=[1234.5])
        daily = rebuild_symbol("test", two_weeks_with_volume, original).bars["d1"]
        assert daily["volume"].iloc[0] == 1234.5 and daily["bar_flags"].iloc[0] == COPIED

    def test_files_without_volume_give_unknown_volume(self, two_weeks):
        bars = rebuild_symbol("test", two_weeks, None).bars
        assert bars["m1"]["volume"].isna().all() and bars["d1"]["volume"].isna().all()


class TestPatch:
    def test_patch_fills_only_what_the_main_file_lacks(self, two_weeks_with_volume):
        raw = two_weeks_with_volume
        hole = (raw["timestamp"] >= ms("2024-01-10 03:00")) & (raw["timestamp"] < ms("2024-01-10 09:00"))
        patch = raw[(raw["timestamp"] >= ms("2024-01-10 02:00")) & (raw["timestamp"] < ms("2024-01-10 10:00"))].copy()
        patch[PRICES] += 0.5   # different on purpose: overlapping rows must come from the main file
        merged = rawdata.apply_patch(raw[~hole].reset_index(drop=True), patch)
        assert len(merged) == len(raw) and merged["timestamp"].is_monotonic_increasing
        assert merged["patched"].sum() == 360
        result = rebuild_symbol("test", merged, None)
        minutes = result.bars["m1"].set_index("timestamp")
        assert result.patched_rows == 360
        assert (minutes.loc[ms("2024-01-10 03:00") : ms("2024-01-10 08:59"), "bar_flags"] == Flag.PATCHED).all()
        assert minutes.loc[ms("2024-01-10 02:30"), "bar_flags"] == 0
        assert minutes.loc[ms("2024-01-10 02:30"), "high"] < 1.5 < minutes.loc[ms("2024-01-10 03:30"), "high"]
        assert not has(result.bars["h1"], Flag.PATCHED).any()

    def test_without_patch_nothing_changes(self, two_weeks_with_volume):
        merged = rawdata.apply_patch(two_weeks_with_volume, None)
        assert not merged["patched"].any() and len(merged) == len(two_weeks_with_volume)

    def test_patch_must_match_the_layout_of_the_main_file(self, two_weeks, two_weeks_with_volume):
        with pytest.raises(rawdata.RawDataError):
            rawdata.apply_patch(two_weeks, two_weeks_with_volume)


def hourly_file(first: str, hours: int, seed: int = 3) -> pd.DataFrame:
    """Hourly candles with volumes, far away in price from the minute data so that they can be told apart."""
    frame = random_walk(ms(first) + np.arange(hours) * 60 * MINUTE, seed=seed, start_price=3.0, volumes=True)
    return frame


class TestHourlyFallback:
    def test_hourly_candles_alone(self):
        hourly = hourly_file("2024-01-08 00:00", 48)
        bars = rebuild_symbol("test", None, None, original_hourly=hourly).bars
        assert set(bars) == {"h1", "h4", "d1", "w1", "1mo", "3mo"}
        assert bars["h1"][PRICES].to_numpy().tolist() == hourly[PRICES].to_numpy().tolist()
        assert (bars["h1"]["bar_flags"] == COPIED).all() and (bars["h1"]["n_m1"] == 0).all()
        assert has(bars["h4"], Flag.ORIGINAL).all() and not has(bars["h4"], Flag.COPIED).any()
        assert bars["d1"]["timestamp"].tolist() == [ms("2024-01-08"), ms("2024-01-09")]
        assert bars["d1"]["high"].tolist() == [hourly["high"][:24].max(), hourly["high"][24:].max()]
        assert bars["d1"]["volume"].sum() == pytest.approx(hourly["volume"].sum())

    def test_hours_the_minutes_lack_are_copied(self, two_weeks_with_volume):
        raw = two_weeks_with_volume
        hole = (raw["timestamp"] >= ms("2024-01-10 02:00")) & (raw["timestamp"] < ms("2024-01-10 07:00"))
        hourly = hourly_file("2024-01-10 00:00", 12)
        bars = rebuild_symbol("test", raw[~hole].reset_index(drop=True), None, original_hourly=hourly).bars

        hours = bars["h1"].set_index("timestamp")
        copied = hours.loc[ms("2024-01-10 02:00") : ms("2024-01-10 06:00")]
        assert (copied["bar_flags"] == COPIED).all() and (copied["low"] > 2).all()
        assert hours.loc[ms("2024-01-10 01:00"), "bar_flags"] == 0 and hours.loc[ms("2024-01-10 01:00"), "high"] < 2
        assert hours.loc[ms("2024-01-10 07:00"), "bar_flags"] == 0
        assert ms("2024-01-10 03:00") not in set(bars["m15"]["timestamp"])

        four = bars["h4"].set_index("timestamp")
        assert four.loc[ms("2024-01-10 00:00"), "bar_flags"] == Flag.MIXED
        assert four.loc[ms("2024-01-10 08:00"), "bar_flags"] == 0
        day = bars["d1"].set_index("timestamp").loc[ms("2024-01-10")]
        assert day["bar_flags"] == Flag.MIXED and day["high"] > 2
        assert day["n_m1"] == 19 * 60
        assert has(bars["w1"], Flag.MIXED).tolist() == [True, False]

    def test_thinly_covered_hour_prefers_the_downloaded_candle(self, two_weeks_with_volume):
        raw = two_weeks_with_volume
        hole = (raw["timestamp"] >= ms("2024-01-10 02:10")) & (raw["timestamp"] < ms("2024-01-10 04:40"))
        hourly = hourly_file("2024-01-10 00:00", 12)
        hours = rebuild_symbol("test", raw[~hole].reset_index(drop=True), None, original_hourly=hourly).bars["h1"].set_index("timestamp")
        assert hours.loc[ms("2024-01-10 02:00"), "bar_flags"] == COPIED           # ten minutes of sixty
        assert hours.loc[ms("2024-01-10 03:00"), "bar_flags"] == COPIED           # nothing
        assert hours.loc[ms("2024-01-10 04:00"), "bar_flags"] == COPIED           # twenty minutes
        assert hours.loc[ms("2024-01-10 05:00"), "bar_flags"] == 0

    def test_partly_covered_hour_without_candle_is_partial(self, two_weeks_with_volume):
        raw = two_weeks_with_volume
        hole = (raw["timestamp"] >= ms("2024-01-10 02:40")) & (raw["timestamp"] < ms("2024-01-10 05:00"))
        hours = rebuild_symbol("test", raw[~hole].reset_index(drop=True), None).bars["h1"].set_index("timestamp")
        assert hours.loc[ms("2024-01-10 02:00"), "bar_flags"] == Flag.PARTIAL
        assert hours.loc[ms("2024-01-10 02:00"), "n_m1"] == 40
        assert hours.loc[ms("2024-01-10 01:00"), "bar_flags"] == 0

    def test_days_before_the_hourly_candles_come_from_the_daily_file(self):
        hourly = hourly_file("2024-01-08 00:00", 48)
        daily = daily_file({"2024-01-04": (1.10, 1.11, 1.09, 1.105), "2024-01-05": (1.105, 1.12, 1.10, 1.11), "2024-01-08": (9.0, 9.0, 9.0, 9.0)})
        days = rebuild_symbol("test", None, daily, original_hourly=hourly).bars["d1"].set_index("timestamp")
        assert days.index.tolist() == [ms("2024-01-04"), ms("2024-01-05"), ms("2024-01-08"), ms("2024-01-09")]
        assert days.loc[ms("2024-01-05"), "bar_flags"] == COPIED
        assert days.loc[ms("2024-01-08"), "high"] < 9 and not has(days, Flag.COPIED).loc[ms("2024-01-08")]

    def test_hourly_candles_off_the_hour_are_rejected(self):
        hourly = hourly_file("2024-01-08 00:30", 4)
        with pytest.raises(ValueError):
            rebuild_symbol("test", None, None, original_hourly=hourly)
