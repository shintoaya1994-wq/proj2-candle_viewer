import numpy as np
import pytest

from candle_viewer.app.signals import SignalStore
from candle_viewer.market import store
from candle_viewer.market.rebuild import RebuildConfig, rebuild_symbol
from candle_viewer.screen import Market, atr, rolling_max_before, rolling_min_before
from candle_viewer.screen import runner, scripts
from candle_viewer.screen.model import Found

from .conftest import ms, random_walk, trading_weeks


@pytest.fixture(scope="module")
def dataset(tmp_path_factory):
    """Twenty weeks of invented minutes, rebuilt into every timeframe."""
    workspace = tmp_path_factory.mktemp("screen")
    minutes = random_walk(trading_weeks("2024-01-07", 20), seed=5, start_price=1.25, volumes=True)
    result = rebuild_symbol("testfx", minutes, None, RebuildConfig())
    folder = store.dataset_dir(workspace, "utc")
    store.write_bars(folder, "testfx", result.bars)
    store.write_manifest(folder, {"convention": "utc", "symbols": {"testfx": {"pip": 0.0001}}})
    return folder


class TestMarket:
    def test_bars_come_as_arrays_oldest_first(self, dataset):
        bars = Market(dataset).bars("testfx", "h1")
        assert bars.timeframe == "h1" and len(bars) > 2000
        assert (np.diff(bars.timestamp) > 0).all()
        assert bars.index_of(int(bars.timestamp[10])) == 10 and bars.index_of(int(bars.timestamp[10]) + 1) == 10
        assert bars.index_of(int(bars.timestamp[0]) - 1) == -1

    def test_a_cut_hands_out_only_bars_that_have_ended(self, dataset):
        cutoff = ms("2024-02-07 12:30")
        hours = Market(dataset, as_of=cutoff).bars("testfx", "h1")
        assert hours.timestamp[-1] == ms("2024-02-07 11:00"), "the hour of 12:00 has not ended at 12:30"
        days = Market(dataset, as_of=cutoff).bars("testfx", "d1")
        assert days.timestamp[-1] == ms("2024-02-06"), "the day has not ended either"

    def test_a_week_ends_at_the_friday_close(self, dataset):
        market = Market(dataset)
        friday = ms("2024-02-09")
        assert market.ended(np.array([friday]), "d1")[0] == ms("2024-02-09 22:00")
        assert market.ended(np.array([ms("2024-02-05")]), "w1")[0] == ms("2024-02-09 22:00")
        assert market.ended(np.array([ms("2024-02-07 10:00")]), "h1")[0] == ms("2024-02-07 11:00")
        assert Market(dataset, as_of=ms("2024-02-09 22:00")).bars("testfx", "d1").timestamp[-1] == friday

    def test_rolling_helpers_look_only_back(self):
        values = np.array([1.0, 5.0, 2.0, 4.0, 3.0])
        assert np.array_equal(rolling_max_before(values, 2)[2:], [5.0, 5.0, 4.0])
        assert np.isnan(rolling_max_before(values, 2)[:2]).all()
        assert np.array_equal(rolling_min_before(values, 3)[3:], [1.0, 2.0])
        assert np.isnan(rolling_max_before(values, 5)).all()

    def test_atr_follows_wilder(self, dataset):
        bars = Market(dataset).bars("testfx", "h1")
        ranges = atr(bars, 3)
        assert np.isnan(ranges[:2]).all() and not np.isnan(ranges[2])
        true_range = [bars.high[0] - bars.low[0]] + [max(bars.high[i] - bars.low[i], abs(bars.high[i] - bars.close[i - 1]), abs(bars.low[i] - bars.close[i - 1])) for i in range(1, 5)]
        expected = sum(true_range[:3]) / 3
        expected += (true_range[3] - expected) / 3
        expected += (true_range[4] - expected) / 3
        assert ranges[4] == pytest.approx(expected)


class TestFound:
    def test_shapes_have_their_anchors(self):
        Found("k", "box", "d1", ((1, 1.0), (2, 2.0)), known_at=3)
        with pytest.raises(ValueError):
            Found("k", "point", "d1", ((1, 1.0), (2, 2.0)), known_at=3)
        with pytest.raises(ValueError):
            Found("k", "circle", "d1", ((1, 1.0),), known_at=3)

    def test_nothing_is_known_before_its_anchors(self):
        with pytest.raises(ValueError):
            Found("k", "point", "d1", ((10, 1.0),), known_at=9)


PEEKING = '''
from candle_viewer.screen import Found

NAME = "peeking"
TITLE = "a screen that looks ahead"
PARAMS = {}

def run(market, symbol, params):
    bars = market.bars(symbol, "d1")
    found = []
    for i in range(len(bars) - 5):
        # claims to know at the end of the bar, but needs the five bars after it
        if bars.close[i] > bars.close[i + 1:i + 6].max():
            found.append(Found(f"p-{bars.timestamp[i]}", "point", "d1", ((int(bars.timestamp[i]), float(bars.close[i])),), int(market.ended(bars.timestamp[i:i + 1], "d1")[0])))
    return found
'''


class TestScreens:
    def test_the_user_screens_come_before_the_shipped_ones(self, tmp_path):
        (tmp_path / "screens").mkdir()
        (tmp_path / "screens" / "peeking.py").write_text(PEEKING, encoding="utf-8")
        (tmp_path / "screens" / "_helper.py").write_text("x = 1", encoding="utf-8")
        found = scripts.discover(tmp_path)
        assert "peeking" in found and "local_extremes" in found and "_helper" not in found
        assert not found["peeking"].shipped and found["local_extremes"].shipped
        with pytest.raises(scripts.UnknownScreen):
            scripts.get(tmp_path, "nothing")

    def test_a_screen_without_a_run_function_is_refused(self, tmp_path):
        (tmp_path / "screens").mkdir()
        (tmp_path / "screens" / "broken.py").write_text("NAME = 'broken'\n", encoding="utf-8")
        with pytest.raises(scripts.BadScreen):
            scripts.discover(tmp_path)

    def test_local_extremes_find_the_planted_peak(self, dataset, tmp_path):
        screen = scripts.get(tmp_path, "local_extremes")
        found = runner.run(screen, dataset, "testfx", {"window": 10})
        assert found, "a random walk of twenty weeks has local extremes"
        market = Market(dataset)
        days = market.bars("testfx", "d1")
        for item in found:
            i = days.index_of(item.anchors[0][0])
            assert item.known_at == market.ended(days.timestamp[i + 10:i + 11], "d1")[0], "known once the ten bars after it have closed"
        assert runner.check(screen, dataset, "testfx", {"window": 10}).passed

    def test_the_check_catches_a_screen_that_looks_ahead(self, dataset, tmp_path):
        (tmp_path / "screens").mkdir()
        (tmp_path / "screens" / "peeking.py").write_text(PEEKING, encoding="utf-8")
        report = runner.check(scripts.get(tmp_path, "peeking"), dataset, "testfx")
        assert report.found > 0
        assert not report.passed
        assert any(item.kind == "early" for item in report.differences)

    def test_what_is_found_becomes_candidate_signals_once(self, dataset, tmp_path):
        screen = scripts.get(tmp_path, "local_extremes")
        signals = SignalStore(tmp_path / "signals")
        found = runner.run(screen, dataset, "testfx", {"window": 10})
        first = runner.publish(found, signals, screen, "testfx")
        assert first.found == len(found) and len(first.created) == len(found) and first.known == 0
        signal = signals.get(first.created[0])
        assert signal.status == "candidate" and signal.origin == "local_extremes" and signal.basis == "model"
        assert signal.key == found[0].key and signal.versions[0].note == found[0].note
        assert signal.versions[0].known_at == found[0].known_at
        # The user rejects one; a second run leaves it rejected and adds nothing.
        from candle_viewer.app.signals import Changes

        signals.change(first.created[0], Changes(status="rejected"))
        again = runner.publish(found, signals, screen, "testfx")
        assert again.created == [] and again.known == len(found)
        assert signals.get(first.created[0]).status == "rejected"
