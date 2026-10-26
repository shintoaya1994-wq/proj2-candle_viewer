"""Regression coverage for moved workspaces and cross-platform AI tools."""

import asyncio
import json
import sys
import tomllib
from pathlib import Path

import pandas as pd
import pytest
from fastapi.testclient import TestClient
from mcp.client.session import ClientSession
from mcp.client.stdio import StdioServerParameters, stdio_client

from candle_viewer import workspace as locations
from candle_viewer.ai import mcp_server
from candle_viewer.ai.chat import Chat, Message, Request
from candle_viewer.app import cli as app_cli
from candle_viewer.app.bars import BarStore
from candle_viewer.app.main import create_app
from candle_viewer.app.projects import Projects
from candle_viewer.market import cli as data_cli, store
from candle_viewer.screen import cli as screen_cli


@pytest.mark.parametrize("platform,shared", [("win32", "F:/candle_workspace"), ("linux", "/mnt/desktop-f/candle_workspace")])
def test_shared_workspace_takes_precedence_over_old_home(monkeypatch, tmp_path, platform, shared):
    monkeypatch.delenv("CANDLE_WORKSPACE", raising=False)
    monkeypatch.setattr(sys, "platform", platform)
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))
    (tmp_path / "candle_workspace").mkdir()
    monkeypatch.setattr(Path, "is_dir", lambda self: self == Path(shared) or self == tmp_path / "candle_workspace")
    assert locations.default_workspace() == Path(shared)


def test_other_computers_keep_the_home_default(monkeypatch, tmp_path):
    monkeypatch.delenv("CANDLE_WORKSPACE", raising=False)
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))
    monkeypatch.setattr(Path, "is_dir", lambda self: False)
    assert locations.default_workspace() == tmp_path / "candle_workspace"


def test_environment_override_is_read_at_startup_and_expands_home(monkeypatch, tmp_path):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("USERPROFILE", str(tmp_path))
    monkeypatch.setenv("CANDLE_WORKSPACE", "~/moved data")
    assert locations.default_workspace() == tmp_path / "moved data"
    monkeypatch.setenv("CANDLE_WORKSPACE", str(tmp_path / "another workspace"))
    assert locations.default_workspace() == tmp_path / "another workspace"


@pytest.mark.parametrize("command", ["app", "mcp", "screen", "check", "rebuild"])
@pytest.mark.parametrize("explicit", [False, True])
def test_every_entry_point_uses_environment_unless_overridden(monkeypatch, tmp_path, command, explicit):
    moved = tmp_path / "moved workspace"
    chosen = tmp_path / "explicit workspace" if explicit else moved
    monkeypatch.setenv("CANDLE_WORKSPACE", str(moved))
    options = ["--workspace", str(chosen)] if explicit else []
    seen = []

    def capture(args):
        seen.append(Path(args.workspace))
        return 0

    if command == "app":
        monkeypatch.setattr(app_cli, "create_app", lambda path, convention: seen.append(path))
        monkeypatch.setattr(app_cli.uvicorn, "run", lambda *args, **kwargs: None)
        assert app_cli.main(options) == 0
    elif command == "mcp":
        class Server:
            def run(self, transport):
                assert transport == "stdio"

        def build(path, convention, project):
            seen.append(path)
            return Server()

        monkeypatch.setattr(mcp_server, "build", build)
        assert mcp_server.main(options) == 0
    elif command == "screen":
        monkeypatch.setattr(screen_cli, "_list", capture)
        assert screen_cli.main([*options, "list"]) == 0
    else:
        monkeypatch.setattr(data_cli, "_" + command, capture)
        source = ["--source", str(tmp_path / "raw")] if command == "rebuild" else []
        assert data_cli.main([command, *source, *options]) == 0
    assert seen == [chosen]


@pytest.mark.parametrize("project", ["", "研究 项目"])
def test_mcp_subprocess_reads_moved_bars_and_writes_signals_for_the_chart(monkeypatch, tmp_path, project):
    monkeypatch.chdir(tmp_path)
    workspace = tmp_path / "moved data"
    dataset = store.dataset_dir(workspace, "utc")
    frame = pd.DataFrame({
        "timestamp": [1704848400000, 1704852000000],
        "open": [1.1, 1.2], "high": [1.3, 1.4], "low": [1.0, 1.1], "close": [1.2, 1.3],
        "volume": [1.0, 2.0], "n_m1": [60, 60], "bar_flags": [0, 0],
    })
    store.write_bars(dataset, "testfx", {"h1": frame})
    projects = Projects(workspace)
    if project:
        projects.create(project)
    chat = Chat(Path("moved data"), BarStore(dataset), projects)
    config = chat._mcp_config(project)
    # An inherited old default must not divert the tools from the web app's workspace.
    old = tmp_path / "old workspace"
    parameters = StdioServerParameters(**config, cwd=chat._cwd(project), env={"CANDLE_WORKSPACE": str(old)})

    async def scenario():
        async with stdio_client(parameters) as (read, write):
            async with ClientSession(read, write, read_timeout_seconds=30) as session:
                await session.initialize()
                bars = await session.call_tool("get_bars", {"symbol": "testfx", "timeframe": "h1", "count": 2})
                assert len(bars.content[0].text.splitlines()) == 3
                paths = await session.call_tool("run_python", {"code": (
                    "import json\nfrom candle_viewer.workspace import default_workspace\n"
                    "print(json.dumps([str(WORKSPACE), str(DATASET), str(default_workspace()), PROJECT, '中文'], ensure_ascii=False))"
                )})
                assert json.loads(paths.content[0].text) == [str(workspace), str(dataset), str(workspace), project, "中文"]
                result = await session.call_tool("create_signal", {
                    "symbol": "testfx", "shape": "point", "timeframe": "h1",
                    "anchors": [{"time": "2024-01-10 02:00", "value": 1.3}], "note": "搬迁后标记",
                })
                return result.content[0].text

    signal_id = asyncio.run(scenario())
    from urllib.parse import quote

    client = TestClient(create_app(Path("moved data"), frontend=None))
    response = client.get("/api/signals", headers={"x-project": quote(project)})
    assert response.status_code == 200
    assert [signal["id"] for signal in response.json()] == [signal_id]
    assert not old.exists()


def test_codex_mcp_configuration_preserves_windows_paths(monkeypatch, tmp_path):
    chat = Chat(tmp_path, BarStore(tmp_path / "market" / "utc"), Projects(tmp_path))
    executable = r"S:\dev\项目 with spaces\.venv\Scripts\python.exe"
    workspace = r"F:\candle_workspace"
    config = {"command": executable, "args": ["-m", "candle_viewer.ai.mcp_server", "--workspace", workspace]}
    monkeypatch.setattr(chat, "_mcp_config", lambda project: config)
    captured = []

    async def run(args, stdin, project):
        captured.extend(args)
        if False:
            yield ""

    monkeypatch.setattr(chat, "_run", run)

    async def scenario():
        request = Request(provider="codex", chat="test", messages=[Message(role="user", content="看看")])
        return [event async for event in chat._codex("unused", request)]

    asyncio.run(scenario())
    overrides = [captured[i + 1] for i, value in enumerate(captured) if value == "-c"]
    parsed = tomllib.loads("\n".join(overrides))["mcp_servers"]["candle-viewer"]
    assert parsed == config
