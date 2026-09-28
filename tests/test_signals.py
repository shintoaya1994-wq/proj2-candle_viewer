import json

import pytest
from fastapi.testclient import TestClient

from candle_viewer.app.main import create_app

from .conftest import ms
from .test_app import PNG, PNG_URL, content


@pytest.fixture
def app(tmp_path):
    return TestClient(create_app(tmp_path, frontend=None)), tmp_path / "signals"


def peak(**changes):
    signal = {"symbol": "testfx", "shape": "point", "timeframe": "d1", "anchors": [{"timestamp": ms("2024-01-10"), "value": 1.2345}]}
    signal.update(changes)
    return signal


def make(client, **changes):
    response = client.post("/api/signals", json=peak(**changes))
    assert response.status_code == 201, response.text
    return response.json()


class TestSignals:
    def test_a_new_signal_has_one_version(self, app):
        client, folder = app
        signal = make(client, models=["模型甲"], basis="partial", knownAt=ms("2024-01-12"))
        assert signal["id"].startswith("s202401100000-")
        assert signal["symbol"] == "testfx" and signal["status"] == "confirmed" and signal["origin"] == "manual"
        assert signal["models"] == ["模型甲"] and signal["basis"] == "partial"
        [version] = signal["versions"]
        assert version == {"version": 1, "reason": "initial", "note": "", "created": signal["created"], "shape": "point", "timeframe": "d1",
                           "knownAt": ms("2024-01-12"), "anchors": [{"timestamp": ms("2024-01-10"), "value": 1.2345}]}
        assert signal["touches"] == [] and signal["note"] == {"tag": "", "comment": "", "studied": False, "updated": None}
        assert client.get(f"/api/signals/{signal['id']}").json() == signal
        stored = json.loads((folder / "testfx" / signal["id"] / "signal.json").read_text(encoding="utf-8"))
        assert stored["models"] == ["模型甲"] and "touches" not in stored and "note" not in stored

    def test_signals_are_listed_by_symbol_in_order_of_time(self, app):
        client, _ = app
        late = make(client, anchors=[{"timestamp": ms("2024-03-01"), "value": 1.3}])
        early = make(client, shape="box", anchors=[{"timestamp": ms("2024-01-02"), "value": 1.2}, {"timestamp": ms("2024-01-20"), "value": 1.1}])
        other = make(client, symbol="otherfx")
        assert [item["id"] for item in client.get("/api/signals", params={"symbol": "testfx"}).json()] == [early["id"], late["id"]]
        assert {item["id"] for item in client.get("/api/signals").json()} == {early["id"], late["id"], other["id"]}
        assert client.get("/api/signals", params={"symbol": "none"}).json() == []
        assert client.get("/api/signals", params={"symbol": "../x"}).json() == []

    @pytest.mark.parametrize("changes", [
        {"shape": "box"},
        {"shape": "point", "anchors": []},
        {"shape": "segment", "anchors": [{"timestamp": 1, "value": 1.0}]},
        {"shape": "circle"},
        {"timeframe": "m7"},
        {"symbol": "../testfx"},
        {"basis": "certain"},
        {"anchors": [{"timestamp": ms("2024-01-10")}]},
    ])
    def test_invalid_signals_are_refused(self, app, changes):
        client, folder = app
        assert client.post("/api/signals", json=peak(**changes)).status_code == 422
        assert not folder.exists() or not any(folder.iterdir())

    def test_a_new_version_keeps_the_earlier_ones(self, app):
        client, _ = app
        signal = make(client)
        moved = {"shape": "level", "timeframe": "h4", "anchors": [{"timestamp": ms("2024-01-15"), "value": 1.2400}], "reason": "market", "note": "出了新高"}
        changed = client.post(f"/api/signals/{signal['id']}/versions", json=moved)
        assert changed.status_code == 201, changed.text
        first, second = changed.json()["versions"]
        assert first == signal["versions"][0]
        assert (second["version"], second["shape"], second["reason"], second["note"]) == (2, "level", "market", "出了新高")
        assert second["anchors"] == moved["anchors"]
        assert client.post(f"/api/signals/{signal['id']}/versions", json={**moved, "reason": "initial"}).status_code == 422

    def test_facts_can_be_corrected_without_a_new_version(self, app):
        client, _ = app
        signal = make(client)
        other = make(client, anchors=[{"timestamp": ms("2024-02-01"), "value": 1.25}])
        changed = client.patch(f"/api/signals/{signal['id']}", json={
            "models": ["模型乙", "模型甲"], "basis": "feeling", "knownAt": ms("2024-01-11 08:00"), "relations": [{"kind": "continues", "target": other["id"]}],
        }).json()
        assert changed["models"] == ["模型乙", "模型甲"] and changed["basis"] == "feeling"
        assert changed["relations"] == [{"kind": "continues", "target": other["id"]}]
        assert len(changed["versions"]) == 1 and changed["versions"][0]["knownAt"] == ms("2024-01-11 08:00")
        kept = client.patch(f"/api/signals/{signal['id']}", json={"status": "rejected"}).json()
        assert kept["status"] == "rejected" and kept["models"] == ["模型乙", "模型甲"] and kept["versions"][0]["knownAt"] == ms("2024-01-11 08:00")
        assert client.patch(f"/api/signals/{signal['id']}", json={"clearKnownAt": True}).json()["versions"][0]["knownAt"] is None

    def test_relations_must_point_to_other_signals(self, app):
        client, _ = app
        signal = make(client)
        assert client.patch(f"/api/signals/{signal['id']}", json={"relations": [{"kind": "related", "target": signal["id"]}]}).status_code == 422
        assert client.patch(f"/api/signals/{signal['id']}", json={"relations": [{"kind": "related", "target": "s202401100000-ffff"}]}).status_code == 404
        assert client.get(f"/api/signals/{signal['id']}").json()["relations"] == []

    def test_delete_moves_to_the_trash(self, app):
        client, folder = app
        signal = make(client)
        client.post(f"/api/signals/{signal['id']}/touches", json={"timestamp": ms("2024-01-20 10:00"), "value": 1.234, "timeframe": "h1"})
        assert client.delete(f"/api/signals/{signal['id']}").status_code == 204
        assert client.get(f"/api/signals/{signal['id']}").status_code == 404
        assert client.get("/api/signals").json() == []
        [trashed] = (folder / ".trash").iterdir()
        assert trashed.name.startswith(signal["id"]) and any((trashed / "touches").iterdir())

    @pytest.mark.parametrize("signal_id", ["s202401100000-ffff", "nonsense", "..%2F..%2Fetc"])
    def test_unknown_signal(self, app, signal_id):
        client, _ = app
        assert client.get(f"/api/signals/{signal_id}").status_code == 404
        assert client.patch(f"/api/signals/{signal_id}", json={}).status_code == 404
        assert client.delete(f"/api/signals/{signal_id}").status_code == 404
        assert client.get(f"/api/signals/{signal_id}/study").status_code == 404


class TestTouches:
    def touch(self, client, signal, when="2024-01-20 10:00", **more):
        response = client.post(f"/api/signals/{signal['id']}/touches", json={"timestamp": ms(when), "value": 1.2341, "timeframe": "h1", **more})
        assert response.status_code == 201, response.text
        return response.json()

    def test_a_touch_points_to_the_version_it_met(self, app):
        client, folder = app
        signal = make(client)
        first = self.touch(client, signal, rule="最高价进入 5 点以内")
        assert first["id"].startswith("t202401201000-") and first["signalId"] == signal["id"] and first["signalVersion"] == 1
        assert first["symbol"] == "testfx" and first["rule"] == "最高价进入 5 点以内" and first["strategies"] == 0

        client.post(f"/api/signals/{signal['id']}/versions", json={"shape": "point", "timeframe": "d1", "anchors": [{"timestamp": ms("2024-01-25"), "value": 1.25}], "reason": "market"})
        second = self.touch(client, signal, when="2024-02-02 14:00")
        earlier = self.touch(client, signal, when="2024-01-22 09:00", signalVersion=1)
        assert (second["signalVersion"], earlier["signalVersion"]) == (2, 1)

        listed = client.get(f"/api/signals/{signal['id']}").json()["touches"]
        assert [item["id"] for item in listed] == [first["id"], earlier["id"], second["id"]], "in the order of their time"
        assert client.get(f"/api/touches/{first['id']}").json() == first
        assert (folder / "testfx" / signal["id"] / "touches" / first["id"] / "touch.json").is_file()
        assert client.post(f"/api/signals/{signal['id']}/touches", json={"timestamp": 1, "value": 1.0, "timeframe": "h1", "signalVersion": 9}).status_code == 422

    def test_strategies_of_a_touch(self, app):
        client, _ = app
        touch = self.touch(client, make(client))
        assert client.get(f"/api/touches/{touch['id']}/strategies").json() == []
        saved = client.put(f"/api/touches/{touch['id']}/strategies", json=[{"label": "当时的做法", "text": "突破后回踩入场"}, {"label": "现在的想法", "text": ""}]).json()
        assert [item["label"] for item in saved] == ["当时的做法", "现在的想法"] and saved[0]["id"] != saved[1]["id"]

        again = client.put(f"/api/touches/{touch['id']}/strategies", json=[
            {"id": saved[0]["id"], "label": "当时的做法", "text": "突破后回踩入场"},
            {"id": saved[1]["id"], "label": "现在的想法", "text": "等 4 小时收盘确认"},
            {"label": "模型B", "text": "不做"},
        ]).json()
        assert [item["id"] for item in again[:2]] == [saved[0]["id"], saved[1]["id"]]
        assert again[0]["updated"] == saved[0]["updated"], "an unchanged strategy keeps its time"
        assert again[1]["text"] == "等 4 小时收盘确认" and again[1]["created"] == saved[1]["created"]
        assert client.get(f"/api/touches/{touch['id']}").json()["strategies"] == 3
        assert client.put(f"/api/touches/{touch['id']}/strategies", json=[again[2]]).json() == [again[2]], "what is left out is gone"

    def test_delete_moves_to_the_trash_of_the_signal(self, app):
        client, folder = app
        signal = make(client)
        touch = self.touch(client, signal)
        assert client.delete(f"/api/touches/{touch['id']}").status_code == 204
        assert client.get(f"/api/touches/{touch['id']}").status_code == 404
        assert client.get(f"/api/signals/{signal['id']}").json()["touches"] == []
        [trashed] = (folder / "testfx" / signal["id"] / "touches" / ".trash").iterdir()
        assert trashed.name.startswith(touch["id"])


class TestStudiesOfSignals:
    def test_the_study_of_a_signal_lives_in_its_folder(self, app):
        client, folder = app
        signal = make(client)
        assert client.get(f"/api/signals/{signal['id']}/study").json() is None
        saved = client.put(f"/api/signals/{signal['id']}/study", json=content(screenshot=PNG_URL, tag="模型甲", comment="感觉如此"))
        assert saved.status_code == 200, saved.text
        study = saved.json()
        assert study["id"] == signal["id"] and study["subject"] == {"kind": "signal", "id": signal["id"]}
        assert client.get(f"/api/signals/{signal['id']}/study").json() == study
        assert client.get(f"/api/signals/{signal['id']}/screenshot").content == PNG
        assert sorted(p.name for p in (folder / "testfx" / signal["id"]).iterdir()) == ["notes.md", "screenshot.png", "signal.json", "study.json"]

        listed = client.get("/api/signals", params={"symbol": "testfx"}).json()[0]
        assert listed["note"] == {"tag": "模型甲", "comment": "感觉如此", "studied": True, "updated": study["updated"]}
        assert client.get("/api/studies").json() == [], "studies of signals are not studies on their own"

    def test_the_study_of_a_touch(self, app):
        client, folder = app
        signal = make(client)
        touch = client.post(f"/api/signals/{signal['id']}/touches", json={"timestamp": ms("2024-01-20 10:00"), "value": 1.2341, "timeframe": "h1"}).json()
        first = client.put(f"/api/touches/{touch['id']}/study", json=content(tag="第一次触及")).json()
        assert first["subject"] == {"kind": "touch", "id": touch["id"]}
        second = client.put(f"/api/touches/{touch['id']}/study", json=content(tag="第一次触及·假突破")).json()
        assert second["created"] == first["created"]
        home = folder / "testfx" / signal["id"] / "touches" / touch["id"]
        assert len(list((home / "history").iterdir())) == 1
        [listed] = client.get(f"/api/signals/{signal['id']}").json()["touches"]
        assert listed["note"]["tag"] == "第一次触及·假突破" and listed["note"]["studied"]
        assert client.get(f"/api/touches/{touch['id']}/screenshot").status_code == 404

    def test_a_long_comment_is_cut_for_lists_only(self, app):
        client, _ = app
        signal = make(client)
        client.put(f"/api/signals/{signal['id']}/study", json=content(comment="长" * 5000))
        assert len(client.get(f"/api/signals/{signal['id']}").json()["note"]["comment"]) == 4000
        assert len(client.get(f"/api/signals/{signal['id']}/study").json()["comment"]) == 5000
