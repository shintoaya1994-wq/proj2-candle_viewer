from urllib.parse import quote

import pytest
from fastapi.testclient import TestClient

from candle_viewer.app.main import create_app
from candle_viewer.app.projects import InvalidProject, Projects, UnknownProject

from .conftest import ms


def signal(symbol="testfx"):
    return {"symbol": symbol, "shape": "point", "timeframe": "d1", "anchors": [{"timestamp": ms("2024-01-10"), "value": 1.2345}]}


class TestProjects:
    def test_the_main_records_are_the_root_of_the_workspace(self, tmp_path):
        projects = Projects(tmp_path)
        main = projects.get("")
        assert main.root == tmp_path and main.label == "主项目" and main.screen_dirs == [tmp_path / "screens"]

    def test_a_project_has_records_and_screens_of_its_own(self, tmp_path):
        projects = Projects(tmp_path)
        space = projects.create("新想法 1")
        assert space.root == tmp_path / "projects" / "新想法 1" and (space.root / "project.json").is_file()
        assert space.screen_dirs == [space.root / "screens", tmp_path / "screens"]
        assert [item.name for item in projects.list()] == ["", "新想法 1"]
        with pytest.raises(InvalidProject):
            projects.create("新想法 1")
        with pytest.raises(UnknownProject):
            projects.get("nothing")

    @pytest.mark.parametrize("name", ["", "../x", "a/b", ".hidden", "x" * 41])
    def test_bad_names_are_refused(self, tmp_path, name):
        with pytest.raises((InvalidProject, UnknownProject)):
            Projects(tmp_path).create(name)

    def test_deleting_moves_to_the_trash(self, tmp_path):
        projects = Projects(tmp_path)
        projects.create("try")
        projects.delete("try")
        assert [item.name for item in projects.list()] == [""]
        assert any(path.name.startswith("try-") for path in (tmp_path / "projects" / ".trash").iterdir())
        with pytest.raises(UnknownProject):
            projects.delete("")


class TestProjectsApi:
    @pytest.fixture
    def client(self, tmp_path):
        return TestClient(create_app(tmp_path, frontend=None))

    def test_records_are_kept_apart_by_the_project_header(self, client, tmp_path):
        assert client.post("/api/projects", json={"name": "试验"}).status_code == 201
        assert [item["name"] for item in client.get("/api/projects").json()] == ["", "试验"]
        main = client.post("/api/signals", json=signal()).json()
        header = {"x-project": quote("试验")}
        tried = client.post("/api/signals", json=signal(), headers=header).json()
        assert [item["id"] for item in client.get("/api/signals", params={"symbol": "testfx"}).json()] == [main["id"]]
        assert [item["id"] for item in client.get("/api/signals", params={"symbol": "testfx"}, headers=header).json()] == [tried["id"]]
        assert client.get(f"/api/signals/{tried['id']}").status_code == 404
        assert (tmp_path / "projects" / "试验" / "signals" / "testfx" / tried["id"] / "signal.json").is_file()
        listed = {item["name"]: item for item in client.get("/api/projects").json()}
        assert listed["试验"]["signals"] == 1 and listed[""]["signals"] == 1

    def test_an_unknown_project_is_refused(self, client):
        assert client.get("/api/signals", params={"symbol": "testfx"}, headers={"x-project": "nothing"}).status_code == 404
        assert client.post("/api/projects", json={"name": "a/b"}).status_code == 422
        assert client.delete("/api/projects/nothing").status_code == 404

    def test_the_screens_of_a_project_come_first(self, client, tmp_path):
        client.post("/api/projects", json={"name": "p"})
        (tmp_path / "screens").mkdir()
        (tmp_path / "screens" / "shared.py").write_text("from candle_viewer.screens.local_extremes import run\nNAME='shared'\nPARAMS={}\n", encoding="utf-8")
        own = tmp_path / "projects" / "p" / "screens"
        own.mkdir()
        (own / "mine.py").write_text("from candle_viewer.screens.local_extremes import run\nNAME='mine'\nPARAMS={}\n", encoding="utf-8")
        names = {item["name"] for item in client.get("/api/screens", headers={"x-project": "p"}).json()}
        assert {"mine", "shared", "local_extremes"} <= names
        assert "mine" not in {item["name"] for item in client.get("/api/screens").json()}

    def test_the_chat_tells_the_assistant_which_project(self, tmp_path):
        from candle_viewer.ai.chat import Chat, Context
        from candle_viewer.app.bars import BarStore
        from candle_viewer.market import store

        projects = Projects(tmp_path)
        projects.create("p")
        chat = Chat(tmp_path, BarStore(store.dataset_dir(tmp_path, "utc")), projects)
        assert "“p”" in chat.briefing(Context(project="p"), with_bars=False)
        assert "主记录" in chat.briefing(Context(), with_bars=False)
        assert chat._mcp_config("p")["args"][-2:] == ["--project", "p"]
        assert chat._cwd("p") == tmp_path / "projects" / "p"
