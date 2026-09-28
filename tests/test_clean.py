import numpy as np

from candle_viewer.market import clean

from .conftest import MINUTE, minutes_between, random_walk


def with_stuck_price(frame, first: int, length: int):
    """Freeze ``length`` bars on the close of the bar before them."""
    frame = frame.copy()
    price = frame.loc[first - 1, "close"]
    frame.loc[first : first + length - 1, ["open", "high", "low", "close"]] = price
    return frame


def arrays(frame):
    return tuple(frame[name].to_numpy() for name in ("timestamp", "open", "high", "low", "close"))


def test_run_of_sixty_minutes_is_filler():
    frame = with_stuck_price(random_walk(minutes_between("2024-01-10", "2024-01-11")), 300, 60)
    runs = clean.find_filler(*arrays(frame), min_minutes=60)
    assert runs.mask.sum() == 60
    assert runs.mask[300:360].all()
    assert runs.minutes.tolist() == [60]
    assert runs.start.tolist() == [frame.loc[300, "timestamp"]]


def test_shorter_run_is_kept():
    frame = with_stuck_price(random_walk(minutes_between("2024-01-10", "2024-01-11")), 300, 59)
    assert not clean.find_filler(*arrays(frame), min_minutes=60).mask.any()


def test_price_change_splits_a_run():
    frame = with_stuck_price(random_walk(minutes_between("2024-01-10", "2024-01-11")), 300, 80)
    frame.loc[340:379, ["open", "high", "low", "close"]] += 0.0001   # 40 + 40 minutes on two prices
    assert not clean.find_filler(*arrays(frame), min_minutes=60).mask.any()


def test_time_gap_splits_a_run():
    frame = with_stuck_price(random_walk(minutes_between("2024-01-10", "2024-01-11")), 300, 80)
    frame.loc[340:, "timestamp"] += 10 * MINUTE
    assert not clean.find_filler(*arrays(frame), min_minutes=60).mask.any()


def test_small_violation_is_widened_and_large_one_is_kept():
    o = np.array([1.00000, 1.00000, 1.00000])
    h = np.array([1.00010, 0.99998, 0.99000])
    l = np.array([0.99990, 0.99990, 0.98000])
    c = np.array([1.00005, 0.99995, 0.98500])
    high, low, fixed = clean.widen_small_violations(o, h, l, c, tolerance=0.0001)
    assert fixed.tolist() == [False, True, False]
    assert high.tolist() == [1.00010, 1.00000, 0.99000]
    assert low.tolist() == [0.99990, 0.99990, 0.98000]
    assert (clean.ohlc_violation(o, high, low, c) > 0).tolist() == [False, False, True]


class TestFillShortGaps:
    ts = np.array([0, 1, 4, 5, 70, 71]) * MINUTE
    close = np.array([1.0, 1.1, 1.2, 1.3, 1.4, 1.5])

    def test_short_pause_is_filled_with_the_price_before_it(self):
        new_ts, price = clean.fill_short_gaps(self.ts, self.close, max_missing=59)
        assert new_ts.tolist() == [2 * MINUTE, 3 * MINUTE]
        assert price.tolist() == [1.1, 1.1]

    def test_long_pause_stays_empty(self):
        new_ts, _ = clean.fill_short_gaps(self.ts, self.close, max_missing=59)
        assert not ((new_ts > 5 * MINUTE) & (new_ts < 70 * MINUTE)).any()

    def test_longest_pause_that_is_still_filled(self):
        new_ts, _ = clean.fill_short_gaps(self.ts, self.close, max_missing=64)
        assert len(new_ts) == 2 + 64

    def test_series_without_pauses(self):
        ts = np.arange(10) * MINUTE
        new_ts, price = clean.fill_short_gaps(ts, np.ones(10), max_missing=59)
        assert len(new_ts) == 0 and len(price) == 0
