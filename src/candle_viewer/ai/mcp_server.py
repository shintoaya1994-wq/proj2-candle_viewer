"""An MCP server (stdio) that lets Claude Code and Codex read the bars and work with the records.

Started by ``candle-viewer-mcp --workspace <dir>``. Everything it does goes
through the same stores as the interface, so what an assistant marks shows
up in the windows at once.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from mcp.server.mcpserver import MCPServer

from ..app.bars import BarStore
from ..app.signals import Anchor, Changes, NewSignal, NewTouch, SignalStore
from ..app.studies import StudyStore
from ..market import store
from ..market.cli import DEFAULT_WORKSPACE
from ..screen import runner, scripts

MAX_BARS = 2000


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


def build(workspace: Path, convention: str = "utc") -> MCPServer:
    workspace = Path(workspace).expanduser()
    dataset = store.dataset_dir(workspace, convention)
    bars = BarStore(dataset)
    signals = SignalStore(workspace / "signals")
    studies = StudyStore(workspace / "studies")
    server = MCPServer(
        "candle-viewer",
        instructions=(
            "Market bars and research records of a discretionary FX trader. Times are UTC. "
            "Signals, touches of signals and strategies after a touch are three separate records. "
            "A screen is a Python script that looks for signals; what it finds becomes candidate signals the user confirms or rejects. "
            "Write screens into the workspace with save_screen and run check_screen before run_screen. See the screens guide (resource guide://screens)."
        ),
    )

    @server.tool()
    def list_symbols() -> str:
        """Symbols in the dataset, with the timeframes and the span of each."""
        return json.dumps(bars.meta(), ensure_ascii=False)

    @server.tool()
    def get_bars(symbol: str, timeframe: str, before: str | None = None, after: str | None = None, around: str | None = None, count: int = 300) -> str:
        """Bars of a symbol as CSV lines (time, open, high, low, close, volume), at most 2000.

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
        return json.dumps([{"name": s.name, "title": s.title, "params": s.params, "source": str(s.source)} for s in scripts.discover(workspace).values()], ensure_ascii=False)

    @server.tool()
    def read_screen(name: str) -> str:
        """The source of a screen."""
        return scripts.get(workspace, name).source.read_text(encoding="utf-8")

    @server.tool()
    def save_screen(name: str, source: str) -> str:
        """Writes a screen into the workspace (screens/<name>.py) and loads it once to see that it is well formed."""
        if not scripts._NAME.match(name):
            raise ValueError("name: lowercase letters, digits and underscores")
        folder = workspace / "screens"
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / f"{name}.py"
        path.write_text(source, encoding="utf-8")
        try:
            screen = scripts.get(workspace, name)
        except Exception as error:
            path.unlink(missing_ok=True)
            raise ValueError(f"the screen does not load: {error}") from error
        return f"saved {path}; params {screen.params}"

    @server.tool()
    def run_screen(name: str, symbol: str, params: dict | None = None, dry_run: bool = False) -> str:
        """Runs a screen on a symbol. Without dry_run what it finds becomes candidate signals."""
        screen = scripts.get(workspace, name)
        found = runner.run(screen, dataset, symbol, params)
        if dry_run:
            lines = [f"{item.key} {item.shape} {item.timeframe} {_when(item.anchors[0][0])} known {_when(item.known_at)} {item.note}" for item in found[:200]]
            return f"{len(found)} found\n" + "\n".join(lines)
        outcome = runner.publish(found, signals, screen, symbol)
        return f"{outcome.found} found, {len(outcome.created)} new candidates, {outcome.known} known already"

    @server.tool()
    def check_screen(name: str, symbol: str, params: dict | None = None) -> str:
        """Reruns a screen on cut data to see whether it looks ahead. Run this before run_screen."""
        report = runner.check(scripts.get(workspace, name), dataset, symbol, params)
        lines = [f"{item.kind} at {_when(item.cutoff)}: {item.key} {item.detail}" for item in report.differences[:50]]
        return f"{'passed' if report.passed else 'FAILED: the screen looks ahead'}; {report.found} found, {report.cutoffs} cutoffs\n" + "\n".join(lines)

    @server.resource("guide://screens")
    def screens_guide() -> str:
        """How to write a screen."""
        guide = Path(__file__).resolve().parents[3] / "docs" / "screens.md"
        return guide.read_text(encoding="utf-8") if guide.is_file() else "see docs/screens.md"

    return server


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="candle-viewer-mcp", description="MCP server over the bars and records, on stdio.")
    parser.add_argument("--workspace", default=str(DEFAULT_WORKSPACE))
    parser.add_argument("--convention", default="utc")
    args = parser.parse_args(argv)
    build(Path(args.workspace), args.convention).run("stdio")
    return 0


if __name__ == "__main__":
    sys.exit(main())
