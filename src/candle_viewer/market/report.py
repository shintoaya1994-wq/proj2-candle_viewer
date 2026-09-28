"""Human-readable report of a rebuild, written in Chinese for the user of the workbench."""

from __future__ import annotations

from pathlib import Path

import pandas as pd

from . import gaps as gaps_module
from . import quality
from .quality import SymbolReport
from .rebuild import Flag, RebuildConfig
from .sessions import SessionCalendar
from .timeframes import DAY_MS

_WEEKDAYS = "一二三四五六日"
_CONVENTIONS = {
    "utc": "UTC（日线从 UTC 0 点开始，周日晚间时段并入周一）",
    "nyclose": "纽约收盘（日线从纽约时间 17:00 开始，相当于 MT4 常见的 GMT+2/+3 服务器时间）",
}


def _table(headers: list[str], rows: list[list]) -> str:
    if not rows:
        return "（无）\n"
    lines = ["| " + " | ".join(headers) + " |", "|" + "|".join("---" for _ in headers) + "|"]
    lines += ["| " + " | ".join(str(cell) for cell in row) + " |" for row in rows]
    return "\n".join(lines) + "\n"


def _duration(minutes: int) -> str:
    days = minutes / 1440
    if days >= 1:
        return f"{days:.0f} 个交易日" if days >= 10 else f"{days:.1f} 个交易日"
    return f"{minutes / 60:.1f} 小时" if minutes >= 60 else f"{minutes} 分钟"


def _date(ms: int, calendar: SessionCalendar | None = None) -> str:
    chart = int(ms) if calendar is None else int(calendar.to_chart([ms])[0])
    stamp = pd.Timestamp(chart, unit="ms")
    return f"{stamp:%Y-%m-%d} 周{_WEEKDAYS[stamp.weekday()]}"


def _overview(reports: list[SymbolReport]) -> str:
    rows = []
    for report in reports:
        result = report.result
        minutes = result.bars.get("m1")
        span = f"{gaps_module.describe(int(minutes['timestamp'].iloc[0]))[:10]} 至 {gaps_module.describe(int(minutes['timestamp'].iloc[-1]))[:10]}" if minutes is not None else "无"
        origin = quality.daily_origin(report)
        large = quality.large_holes(report)
        rows.append([
            result.symbol.upper(),
            span,
            f"{result.raw_m1_rows:,}",
            f"{result.filled_rows:,}",
            f"{len(large)} 段，共 {_duration(int(large['lost_minutes'].sum()))}" if len(large) else "无",
            origin["rebuilt"],
            origin["rebuilt_partial"],
            origin["from_hourly"],
            origin["original_in_holes"],
            origin["original_before_minutes"],
        ])
    headers = ["品种", "1 分钟线范围", "有成交的分钟数", "补入的无成交分钟", "大段缺失", "日线：由分钟线重构", "其中分钟线不完整", "靠小时线补足", "缺失期沿用下载的日线", "早期沿用下载的日线"]
    return _table(headers, rows)


def _holes(reports: list[SymbolReport]) -> str:
    rows = []
    for report in reports:
        for hole in quality.large_holes(report).itertuples(index=False):
            cause = "下载的数据中没有这段" if hole.filler_minutes == 0 else ("下载的数据中是无成交的填充" if hole.filler_minutes >= hole.lost_minutes else "部分没有数据，部分是填充")
            rows.append([report.result.symbol.upper(), gaps_module.describe(hole.start), gaps_module.describe(hole.end), _duration(int(hole.lost_minutes)), cause])
    return _table(["品种", "开始（UTC）", "结束（UTC）", "缺失的交易时间", "情况"], rows)


def _weekend_edges(reports: list[SymbolReport]) -> str:
    rows = []
    for report in reports:
        edges = gaps_module.weekend_edges(report.gaps)
        if edges.empty:
            continue
        late = edges[edges["late_open_minutes"] >= 30]
        typical = late["late_open_minutes"].value_counts().head(2)
        described = "、".join(f"{int(minutes)} 分钟（{count} 周）" for minutes, count in typical.items()) or "无"
        rows.append([report.result.symbol.upper(), len(edges), len(late), described])
    return _table(["品种", "正常周末数", "开盘数据晚于市场开盘的周数", "典型延迟"], rows)


def _comparison(reports: list[SymbolReport]) -> str:
    rows = []
    for report in reports:
        for name, item in report.comparisons.items():
            if not item.comparable:
                rows.append([report.result.symbol.upper(), name, item.original, item.rebuilt, "网格不同，无法逐根比较", "", "", "", "", ""])
                continue
            rows.append([report.result.symbol.upper(), name, item.original, item.rebuilt, item.identical, item.changed, item.added, item.removed, item.wider, item.narrower])
    headers = ["品种", "周期", "原始根数", "重构根数", "完全相同", "数值不同", "新增", "去掉", f"重构后范围更宽（>{quality.NOTABLE_PIPS:.0f} 点）", f"原始范围更宽（>{quality.NOTABLE_PIPS:.0f} 点）"]
    return _table(headers, rows)


def _examples(report: SymbolReport, calendar: SessionCalendar, column: str, count: int = 6) -> str:
    daily = report.comparisons.get("d1")
    if daily is None or not daily.comparable or daily.changes.empty:
        return "（无）\n"
    digits = 3 if report.result.pip == 0.01 else 5
    top = daily.changes[daily.changes[column] > quality.NOTABLE_PIPS].sort_values(column, ascending=False).head(count)
    rows = []
    for row in top.itertuples():
        rows.append([
            _date(row.timestamp, calendar),
            f"{row.high_old:.{digits}f}", f"{row.high:.{digits}f}", f"{row.high_pips:+.1f}",
            f"{row.low_old:.{digits}f}", f"{row.low:.{digits}f}", f"{-row.low_pips:+.1f}",
            row.n_m1,
        ])
    return _table(["交易日", "原始最高", "重构最高", "差（点）", "原始最低", "重构最低", "差（点）", "当日分钟数"], rows)


def _weekday_breakdown(report: SymbolReport, calendar: SessionCalendar) -> str:
    daily = report.comparisons.get("d1")
    if daily is None or not daily.comparable or daily.changes.empty:
        return ""
    wider = daily.changes[daily.changes["wider_pips"] > quality.NOTABLE_PIPS]
    weekday = (calendar.to_chart(wider["timestamp"].to_numpy()) // DAY_MS + 3) % 7
    counts = pd.Series(weekday).value_counts().sort_index()
    return "、".join(f"周{_WEEKDAYS[int(day)]} {count} 天" for day, count in counts.items())


def _symbol_section(report: SymbolReport, calendar: SessionCalendar) -> str:
    result = report.result
    parts = [f"### {result.symbol.upper()}\n"]

    daily = result.bars["d1"]
    bad = int(((daily["bar_flags"] & int(Flag.BAD_OHLC)) > 0).sum())
    unfinished = gaps_module.describe(result.data_end)
    parts.append(f"- 数据截止：{unfinished} UTC，各周期最后一根 K 线尚未走完，已标记。")
    dropped = result.untraded_rows + int(result.filler.minutes.sum())
    parts.append(f"- 去掉无成交的填充 {dropped:,} 分钟；在短暂停顿处补入 {result.filled_rows:,} 根平盘分钟线；修正开收价略微超出高低价的分钟线 {result.repaired_rows} 根。")
    if result.patched_rows:
        parts.append(f"- 分钟线文件缺失的时段中，有 {result.patched_rows:,} 根分钟线由逐笔数据合成后补入。")
    parts.append(f"- 沿用的原始日线中有 {bad} 根开盘价或收盘价落在高低价之外，数值未改动，已标记。" if bad else "- 沿用的原始日线没有发现高低价异常。")

    small = quality.small_holes_by_year(report)
    if not small.empty:
        listed = "、".join(f"{int(year)} 年 {int(row['count'])} 处（{_duration(int(row['lost_minutes']))}）" for year, row in small.iterrows())
        parts.append(f"- 不足一天的零散缺失：{listed}。")

    breakdown = _weekday_breakdown(report, calendar)
    if breakdown:
        parts.append(f"- 重构后日线范围比原始日线宽 {quality.NOTABLE_PIPS:.0f} 点以上的交易日分布：{breakdown}。")

    parts.append("\n重构后范围更宽的日线（原始日线漏掉的极值），差异最大的几天：\n")
    parts.append(_examples(report, calendar, "wider_pips"))
    parts.append("\n原始日线范围更宽的交易日（分钟线可能不完整），差异最大的几天：\n")
    parts.append(_examples(report, calendar, "narrower_pips"))
    return "\n".join(parts) + "\n"


def _rules(config: RebuildConfig) -> str:
    return f"""1. 1 分钟线是基础数据，只保留有成交的分钟。15 分钟线和 1 小时线由它聚合得到。
2. 连续不到 {config.filler_min_minutes} 分钟没有成交时，按前一根收盘价补入平盘分钟线（成交量为 0）。连续 {config.filler_min_minutes} 分钟以上没有成交视为休市或数据缺失，保持空白。补入的分钟线不参与更大周期的开高低收计算。
3. 分钟线的开盘价或收盘价超出高低价不到 {config.repair_tolerance_pips:g} 点时，把高低价放宽到包含开收价；超出更多的不改动，只做标记。
4. 某个小时的分钟线不足 {config.min_coverage:.0%} 而下载的小时线里有这一小时时，直接采用下载的小时线。
5. 4 小时线和日线由 1 小时线聚合。周六、周日产生的数据归入下一个周一的交易日。
6. 某个交易日的数据不足该星期几正常长度的 {config.min_coverage:.0%} 而下载的日线里有这一天时，直接采用下载的日线。小时线开始之前的年份全部如此。
7. 小时线和日线的数据达不到正常长度的 {config.full_coverage:.0%} 时标记为不完整。
8. 周线、月线、季线由日线聚合。
9. 每根 K 线的时间戳是该周期名义起点的 UTC 毫秒时间。
"""


def _flags() -> str:
    meaning = {
        Flag.PARTIAL: "小时线或日线的数据明显少于正常长度",
        Flag.ORIGINAL: "背后没有 1 分钟线，依据的是下载的小时线或日线",
        Flag.MIXED: "只有一部分时间有 1 分钟线",
        Flag.BAD_OHLC: "开盘价或收盘价落在高低价之外，数值未改动",
        Flag.UNFINISHED: "数据截止时该周期尚未走完",
        Flag.REPAIRED: "分钟线的高低价被略微放宽",
        Flag.FILLED: "这根 K 线内没有成交，按前一根收盘价画成平盘",
        Flag.PATCHED: "分钟线文件中没有，由逐笔数据合成后补入",
        Flag.COPIED: "直接取自下载的同周期 K 线，不是聚合得到的",
    }
    return _table(["数值", "名称", "含义"], [[int(flag), flag.name, text] for flag, text in meaning.items()])


def render(reports: list[SymbolReport], config: RebuildConfig, source: Path, dataset: Path, generated: str, baseline: Path | None = None) -> str:
    calendar = SessionCalendar(config.convention)
    baseline = baseline or source
    sections = [
        "# 行情数据重构报告\n",
        f"- 生成时间：{generated}\n- 时间约定：{_CONVENTIONS[config.convention]}\n- 原始数据：`{source}`\n- 重构结果：`{dataset}`\n- 对比基准：`{baseline}`\n",
        "## 一、总览\n",
        _overview(reports),
        "## 二、大段缺失\n",
        "下列时段在 1 分钟线里没有可用数据，15 分钟线在这些时段同样是空的。1 小时线及以上用下载的小时线补上，小时线也没有时用下载的日线，都做了标记。\n",
        _holes(reports),
        "## 三、每周开盘的数据是否完整\n",
        "市场在纽约时间周日 17:00 开盘。下表统计数据比这个时刻晚 30 分钟以上才开始的周数。\n",
        _weekend_edges(reports),
        "## 四、重构结果与对比基准逐根比较\n",
        "“原始”指对比基准目录中的文件。\n",
        _comparison(reports),
        "## 五、各品种详情\n",
        *(_symbol_section(report, calendar) for report in reports),
        "## 六、处理规则\n",
        _rules(config),
        "## 七、`bar_flags` 标记位\n",
        "Parquet 文件中每根 K 线带有 `volume`（成交量，单位百万）、`n_m1`（由多少根分钟线聚合而成）和 `bar_flags`（下列数值之和）。\n",
        _flags(),
    ]
    return "\n".join(sections)
