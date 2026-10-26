"""An MCP server (stdio) that lets Claude Code and Codex read the bars and work with the records.

Started by ``candle-viewer-mcp --workspace <dir>``. Everything it does goes
through the same stores as the interface, so what an assistant marks shows
up in the windows at once.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

from mcp.server.mcpserver import MCPServer

from ..app.bars import BarStore
from ..app.projects import Projects
from ..app.signals import Anchor, Changes, NewSignal, NewTouch
from ..market import store
from ..workspace import default_workspace
from ..screen import runner, scripts

MAX_BARS = 5000
PYTHON_TIMEOUT = 300
MAX_OUTPUT = 40_000


def _when(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, timezone.utc).strftime("%Y-%m-%d %H:%M")


def _ms(text: str | int | None) -> int | None:
    """A moment given as UTC milliseconds or as '2024-01-10 13:00' / '2024-01-10'."""
    if text is None or text == "":
        return None
    if isinstance(text, int) or str(text).isdigit():
        return int(text)
    stamp = str(text).strip().replace("T", " ")
    if len(stamp) == 10:
        stamp += " 00:00"
    return int(datetime.strptime(stamp, "%Y-%m-%d %H:%M").replace(tzinfo=timezone.utc).timestamp() * 1000)


def build(workspace: Path, convention: str = "utc", project: str = "") -> MCPServer:
    workspace = Path(workspace).expanduser().resolve()
    dataset = store.dataset_dir(workspace, convention)
    bars = BarStore(dataset)
    space = Projects(workspace).get(project)
    signals = space.signals
    studies = space.studies
    folders = space.screen_dirs
    server = MCPServer(
        "candle-viewer",
        instructions=(
            "Market bars and research records of a discretionary FX trader. Times are UTC. "
            "Signals, touches of signals and strategies after a touch are three separate records. "
            "A screen is a Python script that looks for signals; what it finds becomes candidate signals the user confirms or rejects. "
            "Write screens with save_screen and run check_screen before run_screen. See the screens guide (resource guide://screens). "
            "For any question over the whole data (all bars of a symbol, statistics, finding bars with some property) use run_python. "
            + (f"The records in use are those of the project '{space.label}'." if project else "The records in use are the user's main ones.")
        ),
    )

    @server.tool()
    def list_symbols() -> str:
        """Symbols in the dataset, with the timeframes and the span of each."""
        return json.dumps(bars.meta(), ensure_ascii=False)

    @server.tool()
    def get_bars(symbol: str, timeframe: str, before: str | None = None, after: str | None = None, around: str | None = None, count: int = 300) -> str:
        """Bars of a symbol as CSV lines (time, open, high, low, close, volume), at most 5000 per call; run_python sees all of them.

        timeframe: m1, m15, h1, h4, d1, w1, 1mo, 3mo. Give one of before/after/around as
        '2024-01-10 13:00' (UTC) or omit all three for the latest bars.
        """
        count = max(1, min(int(count), MAX_BARS))
        found = bars.window(symbol, timeframe, before=_ms(before), after=_ms(after), around=_ms(around), count=count)
        lines = ["time,open,high,low,close,volume"]
        for row in found.bars.itertuples(index=False):
            volume = "" if row.volume != row.volume else f"{row.volume:.2f}"
            lines.append(f"{_when(int(row.timestamp))},{row.open},{row.high},{row.low},{row.close},{volume}")
        return "\n".join(lines)

    @server.tool()
    def list_signals(symbol: str, status: str | None = None) -> str:
        """Signals of a symbol: id, status, origin, shape, timeframe, anchors, tag, models, known_at, touches. status: confirmed, candidate or rejected."""
        listed = []
        for signal in signals.list(symbol):
            if status and signal.status != status:
                continue
            current = signal.current
            listed.append({
                "id": signal.id, "status": signal.status, "origin": signal.origin, "shape": current.shape, "timeframe": current.timeframe,
                "anchors": [{"time": _when(a.timestamp), "value": a.value} for a in current.anchors],
                "knownAt": _when(current.known_at) if current.known_at else None,
                "tag": signal.note.tag, "models": signal.models, "basis": signal.basis, "note": current.note,
                "touches": len(signal.touches), "versions": len(signal.versions),
            })
        return json.dumps(listed, ensure_ascii=False)

    @server.tool()
    def get_signal(signal_id: str) -> str:
        """Everything about a signal: versions, touches with their tags, the comment of its study."""
        signal = signals.get(signal_id)
        study = signals.study("signal", signal_id)
        return json.dumps({**signal.model_dump(by_alias=True), "comment": study.comment if study else ""}, ensure_ascii=False, default=str)

    @server.tool()
    def create_signal(symbol: str, shape: str, timeframe: str, anchors: list[dict], models: list[str] | None = None, note: str = "", known_at: str | None = None, status: str = "candidate") -> str:
        """Marks a signal. shape: point, level (1 anchor), segment, box (2 anchors). anchors: [{"time": "2024-01-10 13:00", "value": 1.2345}].

        known_at: when it could first be known. Signals of an assistant are candidates unless the user asked otherwise.
        """
        new = NewSignal(
            symbol=symbol, shape=shape, timeframe=timeframe,
            anchors=[Anchor(timestamp=_ms(a["time"]) or 0, value=float(a["value"])) for a in anchors],
            known_at=_ms(known_at), models=list(models or []), basis="model" if models else "unset",
            origin="assistant", status=status, note=note,
        )
        return signals.create(new).id

    @server.tool()
    def change_signal(signal_id: str, status: str | None = None, models: list[str] | None = None, known_at: str | None = None) -> str:
        """Confirms or rejects a signal (status), or corrects its models or the time it became knowable."""
        changes = Changes(status=status, models=models, known_at=_ms(known_at))
        return signals.change(signal_id, changes).status

    @server.tool()
    def add_touch(signal_id: str, time: str, value: float, timeframe: str, rule: str = "") -> str:
        """Records that the price came to the signal at a moment. rule says by which rule."""
        return signals.add_touch(signal_id, NewTouch(timestamp=_ms(time) or 0, value=value, timeframe=timeframe, rule=rule, origin="assistant")).id

    @server.tool()
    def read_study(kind: str, subject_id: str) -> str:
        """The study of a signal or a touch (kind: signal or touch): tag, comment, drawings, panes."""
        study = signals.study(kind, subject_id) if kind in ("signal", "touch") else studies.get(subject_id)
        if study is None:
            return "no study yet"
        return json.dumps(study.model_dump(by_alias=True, exclude={"screenshot"}), ensure_ascii=False, default=str)

    @server.tool()
    def list_screens() -> str:
        """The screens that can be run: name, title, params, where the source is."""
        return json.dumps([{"name": s.name, "title": s.title, "params": s.params, "source": str(s.source)} for s in scripts.discover(workspace, folders).values()], ensure_ascii=False)

    @server.tool()
    def read_screen(name: str) -> str:
        """The source of a screen."""
        return scripts.get(workspace, name, folders).source.read_text(encoding="utf-8")

    @server.tool()
    def save_screen(name: str, source: str) -> str:
        """Writes a screen into the workspace (screens/<name>.py) and loads it once to see that it is well formed."""
        if not scripts._NAME.match(name):
            raise ValueError("name: lowercase letters, digits and underscores")
        folder = folders[0]
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / f"{name}.py"
        path.write_text(source, encoding="utf-8")
        try:
            screen = scripts.get(workspace, name, folders)
        except Exception as error:
            path.unlink(missing_ok=True)
            raise ValueError(f"the screen does not load: {error}") from error
        return f"saved {path}; params {screen.params}"

    @server.tool()
    def run_screen(name: str, symbol: str, params: dict | None = None, dry_run: bool = False) -> str:
        """Runs a screen on a symbol. Without dry_run what it finds becomes candidate signals."""
        screen = scripts.get(workspace, name, folders)
        found = runner.run(screen, dataset, symbol, params)
        if dry_run:
            lines = [f"{item.key} {item.shape} {item.timeframe} {_when(item.anchors[0][0])} known {_when(item.known_at)} {item.note}" for item in found[:200]]
            return f"{len(found)} found\n" + "\n".join(lines)
        outcome = runner.publish(found, signals, screen, symbol)
        return f"{outcome.found} found, {len(outcome.created)} new candidates, {outcome.known} known already"

    @server.tool()
    def check_screen(name: str, symbol: str, params: dict | None = None) -> str:
        """Reruns a screen on cut data to see whether it looks ahead. Run this before run_screen."""
        report = runner.check(scripts.get(workspace, name, folders), dataset, symbol, params)
        lines = [f"{item.kind} at {_when(item.cutoff)}: {item.key} {item.detail}" for item in report.differences[:50]]
        return f"{'passed' if report.passed else 'FAILED: the screen looks ahead'}; {report.found} found, {report.cutoffs} cutoffs\n" + "\n".join(lines)

    @server.tool()
    def run_python(code: str) -> str:
        """Runs Python code over the whole market data and returns what it prints (stdout and stderr, at most 40000 characters, 300 s).

        The code runs in the environment of the application, in the folder of the project. Load bars with::

            from candle_viewer.screen import Market, atr, rolling_max_before
            market = Market(DATASET)                 # DATASET is set; Market(DATASET, as_of=ms) cuts the data at a moment
            bars = market.bars("eurusd", "h1")       # numpy arrays: bars.timestamp (UTC ms), .open, .high, .low, .close
            day = market.bar_start(bars.timestamp, "d1")

        numpy and pandas are available. Timeframes: m1, m15, h1, h4, d1, w1, 1mo, 3mo. Print what you find; keep the output short.
        """
        prelude = f"from pathlib import Path\nDATASET = Path({str(dataset)!r})\nWORKSPACE = Path({str(workspace)!r})\nPROJECT = {project!r}\n"
        env = {**os.environ, "CANDLE_WORKSPACE": str(workspace), "CANDLE_DATASET": str(dataset), "CANDLE_PROJECT": project, "PYTHONIOENCODING": "utf-8"}
        try:
            done = subprocess.run([sys.executable, "-"], input=prelude + code, capture_output=True, text=True, encoding="utf-8", timeout=PYTHON_TIMEOUT, cwd=space.root, env=env)
        except subprocess.TimeoutExpired:
            return f"stopped after {PYTHON_TIMEOUT} s"
        output = done.stdout + (f"\n[stderr]\n{done.stderr}" if done.stderr.strip() else "")
        if done.returncode != 0:
            output += f"\n[exit code {done.returncode}]"
        return output[-MAX_OUTPUT:] if len(output) > MAX_OUTPUT else output

    @server.resource("guide://screens")
    def screens_guide() -> str:
        """How to write a screen."""
        guide = Path(__file__).resolve().parents[3] / "docs" / "screens.md"
        return guide.read_text(encoding="utf-8") if guide.is_file() else "see docs/screens.md"

    return server


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="candle-viewer-mcp", description="MCP server over the bars and records, on stdio.")
    parser.add_argument("--workspace", default=str(default_workspace()))
    parser.add_argument("--convention", default="utc")
    parser.add_argument("--project", default="", help="project whose records to work on")
    args = parser.parse_args(argv)
    build(Path(args.workspace), args.convention, args.project).run("stdio")
    return 0


if __name__ == "__main__":
    sys.exit(main())
