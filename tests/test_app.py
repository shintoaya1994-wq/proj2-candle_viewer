import base64
import json

import pandas as pd
import pytest
from fastapi.testclient import TestClient

from candle_viewer.app.bars import BarStore, UnknownSeries
from candle_viewer.app.main import create_app
from candle_viewer.market import cli, store

from .conftest import ms, random_walk, trading_weeks

# A valid PNG of one pixel.
PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg==")
PNG_URL = "data:image/png;base64," + base64.b64encode(PNG).decode()


@pytest.fixture(scope="module")
def workspace(tmp_path_factory):
    """A workspace with one symbol of three weeks, stored in small row groups."""
    root = tmp_path_factory.mktemp("workspace")
    source = root / "raw"
    source.mkdir()
    random_walk(trading_weeks("2024-01-07", 3), volumes=True).to_csv(source / "testfx-m1-bid_full.csv", index=False)
    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(store, "ROW_GROUP", 1000)
        assert cli.main(["rebuild", "--source", str(source), "--workspace", str(root)]) == 0
    return root


@pytest.fixture
def client(workspace):
    return TestClient(create_app(workspace, frontend=None))


@pytest.fixture
def minutes(workspace):
    return pd.read_parquet(store.bars_path(store.dataset_dir(workspace, "utc"), "testfx", "m1"))


def bars(client, **query):
    response = client.get("/api/bars", params={"symbol": "testfx", "timeframe": "m1", **query})
    assert response.status_code == 200, response.text
    return response.json()


def timestamps(body):
    return [row[0] for row in body["bars"]]


class TestBars:
    def test_meta_describes_the_dataset(self, client, minutes):
        meta = client.get("/api/meta").json()
        assert meta["convention"] == "utc"
        [symbol] = meta["symbols"]
        assert symbol["name"] == "testfx" and symbol["digits"] == 5
        assert [tf["name"] for tf in symbol["timeframes"]] == ["m1", "m15", "h1", "h4", "d1", "w1", "1mo", "3mo"]
        first = symbol["timeframes"][0]
        assert first == {"name": "m1", "rows": len(minutes), "first": int(minutes["timestamp"].iloc[0]), "last": int(minutes["timestamp"].iloc[-1])}

    def test_latest_bars_by_default(self, client, minutes):
        body = bars(client, count=300)
        assert body["columns"] == ["timestamp", "open", "high", "low", "close", "volume", "n_m1", "bar_flags"]
        assert timestamps(body) == minutes["timestamp"].tail(300).tolist()
        assert (body["older"], body["newer"]) == (True, False)
        assert body["bars"][-1][1:5] == minutes[["open", "high", "low", "close"]].iloc[-1].tolist()

    def test_bars_before_a_time_cross_row_groups(self, client, minutes):
        edge = int(minutes["timestamp"].iloc[5000])
        body = bars(client, before=edge, count=2500)
        assert timestamps(body) == minutes["timestamp"].iloc[2500:5000].tolist()
        assert (body["older"], body["newer"]) == (True, True)

    def test_bars_before_a_time_inside_a_weekend(self, client, minutes):
        body = bars(client, before=ms("2024-01-13 12:00"), count=10)
        assert timestamps(body)[-1] == ms("2024-01-12 21:59")

    def test_bars_after_a_time(self, client, minutes):
        edge = int(minutes["timestamp"].iloc[-501])
        body = bars(client, after=edge, count=1000)
        assert timestamps(body) == minutes["timestamp"].tail(500).tolist()
        assert (body["older"], body["newer"]) == (True, False)

    def test_bars_around_a_time(self, client, minutes):
        body = bars(client, around=ms("2024-01-17 12:00"), count=600)
        found = timestamps(body)
        assert len(found) == 600 and found.index(ms("2024-01-17 12:00")) == 300

    def test_window_stretched_back_to_an_earlier_time(self, client, minutes):
        body = bars(client, around=ms("2024-01-17 12:00"), since=ms("2024-01-09 06:30"), count=600)
        found = timestamps(body)
        assert found[0] == ms("2024-01-09 06:30") and found[-1] == timestamps(bars(client, around=ms("2024-01-17 12:00"), count=600))[-1]
        assert found == minutes["timestamp"][(minutes["timestamp"] >= found[0]) & (minutes["timestamp"] <= found[-1])].tolist()
        later = bars(client, around=ms("2024-01-17 12:00"), since=ms("2024-01-18 00:00"), count=600)
        assert timestamps(later) == timestamps(bars(client, around=ms("2024-01-17 12:00"), count=600))

    def test_start_of_data(self, client, minutes):
        body = bars(client, before=int(minutes["timestamp"].iloc[100]), count=500)
        assert len(body["bars"]) == 100 and (body["older"], body["newer"]) == (False, True)
        assert bars(client, before=int(minutes["timestamp"].iloc[0]))["bars"] == []

    def test_other_timeframes(self, client, workspace):
        daily = pd.read_parquet(store.bars_path(store.dataset_dir(workspace, "utc"), "testfx", "d1"))
        response = client.get("/api/bars", params={"symbol": "testfx", "timeframe": "d1"})
        assert timestamps(response.json()) == daily["timestamp"].tolist()
        assert (response.json()["older"], response.json()["newer"]) == (False, False)

    @pytest.mark.parametrize("query, status", [
        ({"symbol": "nothere", "timeframe": "m1"}, 404),
        ({"symbol": "testfx", "timeframe": "m7"}, 404),
        ({"symbol": "../testfx", "timeframe": "m1"}, 404),
        ({"symbol": "testfx", "timeframe": "m1", "before": 1, "after": 2}, 422),
        ({"symbol": "testfx", "timeframe": "m1", "count": 0}, 422),
        ({"symbol": "testfx"}, 422),
    ])
    def test_bad_requests(self, client, query, status):
        assert client.get("/api/bars", params=query).status_code == status

    def test_unknown_volume_travels_as_null(self, tmp_path):
        source = tmp_path / "raw"
        source.mkdir()
        random_walk(trading_weeks("2024-01-07", 1)).to_csv(source / "novol-m1-bid_full.csv", index=False)
        assert cli.main(["rebuild", "--source", str(source), "--workspace", str(tmp_path)]) == 0
        body = TestClient(create_app(tmp_path, frontend=None)).get("/api/bars", params={"symbol": "novol", "timeframe": "h1", "count": 5}).json()
        assert [row[5] for row in body["bars"]] == [None] * 5

    def test_a_rebuilt_file_is_read_afresh(self, tmp_path):
        source = tmp_path / "raw"
        source.mkdir()
        full = random_walk(trading_weeks("2024-01-07", 2), volumes=True)
        full.iloc[:7200].to_csv(source / "grow-m1-bid_full.csv", index=False)
        cli.main(["rebuild", "--source", str(source), "--workspace", str(tmp_path)])
        bar_store = BarStore(store.dataset_dir(tmp_path, "utc"))
        assert bar_store.window("grow", "m1", count=1).bars["timestamp"].iloc[0] == full["timestamp"].iloc[7199]
        full.to_csv(source / "grow-m1-bid_full.csv", index=False)
        cli.main(["rebuild", "--source", str(source), "--workspace", str(tmp_path)])
        assert bar_store.window("grow", "m1", count=1).bars["timestamp"].iloc[0] == full["timestamp"].iloc[-1]

    def test_empty_workspace(self, tmp_path):
        bar_store = BarStore(store.dataset_dir(tmp_path, "utc"))
        assert bar_store.meta()["symbols"] == []
        with pytest.raises(UnknownSeries):
            bar_store.window("testfx", "m1")


def content(**changes):
    study = {
        "symbol": "testfx",
        "focus": ms("2024-01-10 12:00"),
        "tag": "箱体·待突破",
        "comment": "第一段\n\n感觉这次上涨没有结束。",
        "drawings": [
            {"id": "d1", "name": "segment", "symbol": "testfx", "timeframe": "h1", "points": [{"timestamp": ms("2024-01-09 03:00"), "value": 1.2012}, {"timestamp": ms("2024-01-10 08:00"), "value": 1.1987}], "styles": {"line": {"color": "#e11d48"}}},
            {"id": "d2", "name": "box", "symbol": "testfx", "timeframe": "h1", "points": [{"timestamp": ms("2024-01-10 00:00"), "value": 1.2050}, {"timestamp": ms("2024-02-01 00:00"), "value": 1.1950}], "extendData": {"text": "延伸到未来"}},
            {"id": "d3", "name": "horizontalStraightLine", "points": [{"value": 1.2}]},
        ],
        "panes": [
            {"symbol": "testfx", "timeframe": "h1", "indicators": [{"name": "MA", "pane": "candle", "params": [20, 60]}, {"name": "MACD", "pane": "own", "params": [12, 26, 9]}],
             "view": {"barSpace": 8.5, "offsetRight": 40, "rightTimestamp": ms("2024-01-11 00:00")}},
            {"symbol": "testfx", "timeframe": "d1"},
        ],
        "layout": {"columns": 2, "rows": 1},
    }
    study.update(changes)
    return study


@pytest.fixture
def studies(tmp_path):
    return TestClient(create_app(tmp_path, frontend=None)), tmp_path / "studies"


class TestStudies:
    def test_save_and_reopen(self, studies):
        client, folder = studies
        created = client.post("/api/studies", json=content(screenshot=PNG_URL))
        assert created.status_code == 201, created.text
        saved = created.json()
        reopened = client.get(f"/api/studies/{saved['id']}").json()
        assert reopened == saved
        for key in ("symbol", "focus", "tag", "comment", "layout"):
            assert reopened[key] == content()[key], key
        assert reopened["timezone"] == "UTC" and reopened["subject"] is None and reopened["schemaVersion"] == 2
        assert reopened["panes"] == [
            {"symbol": "testfx", "timeframe": "h1", "view": {"barSpace": 8.5, "offsetRight": 40, "rightTimestamp": ms("2024-01-11 00:00")}, "indicators": [
                {"name": "MA", "pane": "candle", "params": [20, 60], "visible": True},
                {"name": "MACD", "pane": "own", "params": [12, 26, 9], "visible": True},
            ]},
            {"symbol": "testfx", "timeframe": "d1", "view": {"barSpace": None, "offsetRight": None, "rightTimestamp": None}, "indicators": []},
        ]
        assert [d["points"] for d in reopened["drawings"]] == [
            [{"timestamp": ms("2024-01-09 03:00"), "value": 1.2012}, {"timestamp": ms("2024-01-10 08:00"), "value": 1.1987}],
            [{"timestamp": ms("2024-01-10 00:00"), "value": 1.2050}, {"timestamp": ms("2024-02-01 00:00"), "value": 1.1950}],
            [{"timestamp": None, "value": 1.2}],
        ]
        assert reopened["drawings"][1]["extendData"] == {"text": "延伸到未来"}
        assert reopened["hasScreenshot"] and reopened["screenshot"] is None
        assert client.get(f"/api/studies/{saved['id']}/screenshot").content == PNG

    def test_files_on_disk_are_plain(self, studies):
        client, folder = studies
        study_id = client.post("/api/studies", json=content(screenshot=PNG_URL)).json()["id"]
        assert sorted(p.name for p in (folder / study_id).iterdir()) == ["notes.md", "screenshot.png", "study.json"]
        assert (folder / study_id / "notes.md").read_text(encoding="utf-8") == "第一段\n\n感觉这次上涨没有结束。"
        stored = json.loads((folder / study_id / "study.json").read_text(encoding="utf-8"))
        assert stored["tag"] == "箱体·待突破" and "comment" not in stored and "screenshot" not in stored
        assert "箱体·待突破" in (folder / study_id / "study.json").read_text(encoding="utf-8")

    def test_comment_edited_by_hand_is_picked_up(self, studies):
        client, folder = studies
        study_id = client.post("/api/studies", json=content()).json()["id"]
        (folder / study_id / "notes.md").write_text("在别的编辑器里改过", encoding="utf-8")
        assert client.get(f"/api/studies/{study_id}").json()["comment"] == "在别的编辑器里改过"

    def test_update_keeps_what_was_there_before(self, studies):
        client, folder = studies
        first = client.post("/api/studies", json=content(screenshot=PNG_URL)).json()
        changed = client.put(f"/api/studies/{first['id']}", json=content(tag="已突破", comment="第二版", drawings=[]))
        assert changed.status_code == 200, changed.text
        second = changed.json()
        assert second["tag"] == "已突破" and second["comment"] == "第二版" and second["drawings"] == []
        assert second["created"] == first["created"] and second["updated"] >= first["updated"]
        assert second["hasScreenshot"], "a save without a new screenshot keeps the old one"
        [kept] = (folder / first["id"] / "history").iterdir()
        assert json.loads((kept / "study.json").read_text(encoding="utf-8"))["tag"] == "箱体·待突破"
        assert (kept / "notes.md").read_text(encoding="utf-8").startswith("第一段")
        assert (kept / "screenshot.png").read_bytes() == PNG

    def test_list_shows_the_latest_first(self, studies):
        client, _ = studies
        first = client.post("/api/studies", json=content(tag="甲")).json()
        second = client.post("/api/studies", json=content(tag="乙", symbol="other", comment="  多行\n评论  ")).json()
        listed = client.get("/api/studies").json()
        assert {item["id"] for item in listed} == {first["id"], second["id"]}
        assert listed[0]["updated"] >= listed[1]["updated"]
        other = next(item for item in listed if item["id"] == second["id"])
        assert other == {"id": second["id"], "symbol": "other", "timeframes": ["h1", "d1"], "focus": ms("2024-01-10 12:00"), "tag": "乙", "excerpt": "多行 评论",
                         "drawings": 3, "created": second["created"], "updated": second["updated"], "hasScreenshot": False}

    def test_delete_moves_to_the_trash(self, studies):
        client, folder = studies
        study_id = client.post("/api/studies", json=content()).json()["id"]
        assert client.delete(f"/api/studies/{study_id}").status_code == 204
        assert client.get(f"/api/studies/{study_id}").status_code == 404
        assert client.get("/api/studies").json() == []
        [trashed] = (folder / ".trash").iterdir()
        assert trashed.name.startswith(study_id) and (trashed / "study.json").is_file()

    @pytest.mark.parametrize("study_id", ["20240110-120000-abcd", "nonsense", "..%2F..%2Fetc"])
    def test_unknown_study(self, studies, study_id):
        client, _ = studies
        assert client.get(f"/api/studies/{study_id}").status_code == 404
        assert client.put(f"/api/studies/{study_id}", json=content()).status_code == 404
        assert client.delete(f"/api/studies/{study_id}").status_code == 404
        assert client.get(f"/api/studies/{study_id}/screenshot").status_code == 404

    @pytest.mark.parametrize("changes", [
        {"screenshot": "data:image/png;base64,AAAA"},
        {"screenshot": "data:image/jpeg;base64," + base64.b64encode(PNG).decode()},
        {"screenshot": "data:image/png;base64,not base64"},
        {"unknownField": 1},
        {"drawings": [{"id": "x", "name": "segment"}]},
        {"symbol": None},
        {"panes": []},
        {"panes": [{"symbol": "testfx"}]},
        {"layout": {"columns": 9, "rows": 1}},
    ])
    def test_invalid_content_is_refused(self, studies, changes):
        client, folder = studies
        assert client.post("/api/studies", json=content(**changes)).status_code == 422
        assert not folder.exists() or not any(folder.iterdir())

    def test_empty_list(self, studies):
        client, _ = studies
        assert client.get("/api/studies").json() == []

    def test_study_of_the_first_version_opens_as_one_pane(self, studies):
        """Studies saved before there were panes described their single chart themselves."""
        client, folder = studies
        old = folder / "20260928-224423-b226"
        old.mkdir(parents=True)
        (old / "notes.md").write_text("旧记录的评论", encoding="utf-8")
        (old / "screenshot.png").write_bytes(PNG)
        first = {
            "symbol": "testfx", "timeframe": "d1", "focus": ms("2024-01-10 07:00"), "tag": "旧记录", "timezone": "Asia/Shanghai",
            "drawings": [{"id": "dx", "name": "box", "points": [{"timestamp": ms("2024-01-08"), "value": 1.21}, {"timestamp": ms("2024-01-12"), "value": 1.19}],
                          "timeframe": "d1", "styles": None, "extendData": {"color": "#2563eb"}, "lock": False, "visible": True, "zLevel": 0}],
            "indicators": [{"name": "MA", "pane": "candle", "params": [20.0], "visible": True}],
            "view": {"barSpace": 25.7, "offsetRight": -1.89, "rightTimestamp": ms("2024-01-15")},
            "id": "20260928-224423-b226", "created": "2026-09-28T22:44:23Z", "updated": "2026-09-28T22:50:00Z", "schemaVersion": 1,
        }
        (old / "study.json").write_text(json.dumps(first, ensure_ascii=False), encoding="utf-8")
        before = (old / "study.json").read_bytes()

        [listed] = client.get("/api/studies").json()
        assert listed["tag"] == "旧记录" and listed["timeframes"] == ["d1"] and listed["excerpt"] == "旧记录的评论"
        opened = client.get("/api/studies/20260928-224423-b226").json()
        assert opened["panes"] == [{"symbol": "testfx", "timeframe": "d1", "indicators": first["indicators"], "view": first["view"]}]
        assert opened["layout"] == {"columns": 1, "rows": 1}
        assert opened["drawings"][0]["symbol"] == "testfx" and opened["drawings"][0]["points"] == first["drawings"][0]["points"]
        assert opened["comment"] == "旧记录的评论" and opened["timezone"] == "Asia/Shanghai" and opened["hasScreenshot"]
        assert (old / "study.json").read_bytes() == before, "opening a study must not rewrite it"

        saved = client.put("/api/studies/20260928-224423-b226", json={key: opened[key] for key in ("symbol", "focus", "tag", "comment", "drawings", "panes", "layout", "timezone")})
        assert saved.status_code == 200, saved.text
        assert saved.json()["created"] == "2026-09-28T22:44:23Z"
        [kept] = (old / "history").iterdir()
        assert (kept / "study.json").read_bytes() == before, "the study as it was is kept"


class TestVersion:
    def test_the_interface_can_tell_which_program_it_talks_to(self, client):
        assert client.get("/api/meta").json()["api"] == 3


class TestFrontend:
    def test_built_frontend_is_served(self, tmp_path):
        built = tmp_path / "dist"
        built.mkdir()
        (built / "index.html").write_text("<title>built</title>", encoding="utf-8")
        client = TestClient(create_app(tmp_path, frontend=built))
        assert "built" in client.get("/").text
        assert client.get("/api/studies").json() == []

    def test_missing_frontend_explains_how_to_build_it(self, tmp_path):
        client = TestClient(create_app(tmp_path, frontend=tmp_path / "nothing"))
        response = client.get("/")
        assert response.status_code == 200 and "npm run build" in response.text
        assert client.get("/api/studies").json() == []
