"""Data quality findings and the comparison of rebuilt bars with the original files."""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from . import gaps as gaps_module
from . import timeframes
from .rawdata import PRICE_COLUMNS
from .rebuild import Flag, RebuildConfig, SymbolResult
from .sessions import SessionCalendar
from .timeframes import DAY_MS

NOTABLE_PIPS = 5.0      # a change of a high or low that matters for price levels
LARGE_HOLE_MINUTES = 1440


@dataclass
class Comparison:
    """Rebuilt bars of one timeframe against the original file."""

    timeframe: str
    comparable: bool
    rebuilt: int = 0
    original: int = 0
    identical: int = 0
    changed: int = 0
    added: int = 0
    removed: int = 0
    wider: int = 0       # rebuilt range exceeds the original by more than NOTABLE_PIPS
    narrower: int = 0    # original range exceeds the rebuilt by more than NOTABLE_PIPS
    changes: pd.DataFrame = field(default=None, repr=False)


@dataclass
class SymbolReport:
    result: SymbolResult
    gaps: pd.DataFrame
    comparisons: dict[str, Comparison]
    original_daily_rows: int


def _period_keys(frame: pd.DataFrame, tf: timeframes.Timeframe, calendar: SessionCalendar | None) -> np.ndarray:
    """Key on which rebuilt and original bars of one timeframe line up."""
    ts = frame["timestamp"].to_numpy()
    if tf.is_intraday:
        return ts
    chart = ts if calendar is None else calendar.to_chart(ts)
    return chart // DAY_MS


def compare(rebuilt: pd.DataFrame, original: pd.DataFrame, tf: timeframes.Timeframe, calendar: SessionCalendar, pip: float) -> Comparison:
    if tf.is_intraday and tf.span > 60 and calendar.convention != "utc":
        # The original four-hour grid is UTC; bars on another grid cannot be matched one to one.
        return Comparison(tf.name, comparable=False, rebuilt=len(rebuilt), original=len(original))

    new = rebuilt.assign(key=_period_keys(rebuilt, tf, calendar)).set_index("key")
    old = original.assign(key=_period_keys(original, tf, None)).set_index("key")
    both = new.join(old[list(PRICE_COLUMNS)], how="inner", rsuffix="_old")
    differs = np.zeros(len(both), dtype=bool)
    for name in PRICE_COLUMNS:
        differs |= both[name].to_numpy() != both[f"{name}_old"].to_numpy()

    changes = both[differs].copy()
    changes["high_pips"] = (changes["high"] - changes["high_old"]) / pip
    changes["low_pips"] = (changes["low_old"] - changes["low"]) / pip     # positive: rebuilt reaches lower
    changes["wider_pips"] = changes[["high_pips", "low_pips"]].max(axis=1)
    changes["narrower_pips"] = -changes[["high_pips", "low_pips"]].min(axis=1)
    return Comparison(
        timeframe=tf.name,
        comparable=True,
        rebuilt=len(new),
        original=len(old),
        identical=int((~differs).sum()),
        changed=int(differs.sum()),
        added=int((~new.index.isin(old.index)).sum()),
        removed=int((~old.index.isin(new.index)).sum()),
        wider=int((changes["wider_pips"] > NOTABLE_PIPS).sum()),
        narrower=int((changes["narrower_pips"] > NOTABLE_PIPS).sum()),
        changes=changes,
    )


def summarize(result: SymbolResult, raw_minutes: pd.DataFrame | None, originals: dict[str, pd.DataFrame], config: RebuildConfig) -> SymbolReport:
    """Collect gaps and compare the rebuilt bars with ``originals``, the files of an earlier dataset."""
    calendar = SessionCalendar(config.convention)
    if "m1" in result.bars and raw_minutes is not None:
        found = gaps_module.find_gaps(result.bars["m1"]["timestamp"].to_numpy(), raw_minutes["timestamp"].to_numpy())
    else:
        found = pd.DataFrame(columns=list(gaps_module.COLUMNS))
    comparisons = {
        tf.name: compare(result.bars[tf.name], originals[tf.name], tf, calendar, result.pip)
        for tf in timeframes.ALL
        if tf.name != "m1" and tf.name in result.bars and tf.name in originals
    }
    return SymbolReport(result, found, comparisons, len(originals.get("d1", ())))


# -- figures used by the report and the manifest ---------------------------------


def flag_counts(frame: pd.DataFrame) -> dict[str, int]:
    bits = frame["bar_flags"].to_numpy()
    return {flag.name.lower(): int(((bits & int(flag)) > 0).sum()) for flag in Flag if ((bits & int(flag)) > 0).any()}


def daily_origin(report: SymbolReport) -> dict[str, int]:
    """How many daily bars come from where."""
    daily = report.result.bars["d1"]
    bits = daily["bar_flags"].to_numpy()
    copied = (bits & int(Flag.COPIED)) > 0
    without_minutes = (bits & int(Flag.ORIGINAL | Flag.MIXED)) > 0
    partial = (bits & int(Flag.PARTIAL)) > 0
    ts = daily["timestamp"].to_numpy()
    before = ts < (ts[~copied].min() if (~copied).any() else np.inf)
    return {
        "rebuilt": int((~without_minutes & ~partial).sum()),
        "rebuilt_partial": int((~without_minutes & partial).sum()),
        "from_hourly": int((without_minutes & ~copied).sum()),
        "original_before_minutes": int((copied & before).sum()),
        "original_in_holes": int((copied & ~before).sum()),
    }


def large_holes(report: SymbolReport) -> pd.DataFrame:
    found = report.gaps
    return found[(found["kind"] == "hole") & (found["lost_minutes"] >= LARGE_HOLE_MINUTES)].reset_index(drop=True)


def small_holes_by_year(report: SymbolReport) -> pd.DataFrame:
    found = report.gaps
    small = found[(found["kind"] == "hole") & (found["lost_minutes"] < LARGE_HOLE_MINUTES)]
    year = pd.to_datetime(small["start"], unit="ms").dt.year
    return small.groupby(year.to_numpy()).agg(count=("minutes", "size"), lost_minutes=("lost_minutes", "sum"))


def manifest_entry(report: SymbolReport) -> dict:
    result = report.result
    entry = {
        "pip": result.pip,
        "data_end": gaps_module.describe(result.data_end),
        "raw_m1_rows": result.raw_m1_rows,
        "untraded_m1_rows_dropped": result.untraded_rows,
        "filler_runs_dropped": int(len(result.filler.minutes)),
        "filler_minutes_dropped": int(result.filler.minutes.sum()),
        "pause_minutes_filled": result.filled_rows,
        "minutes_from_patch": result.patched_rows,
        "repaired_m1_rows": result.repaired_rows,
        "typical_minutes_by_weekday": result.typical_minutes,
        "daily_origin": daily_origin(report),
        "timeframes": {},
    }
    for name, frame in result.bars.items():
        entry["timeframes"][name] = {
            "rows": len(frame),
            "first": gaps_module.describe(int(frame["timestamp"].iloc[0])),
            "last": gaps_module.describe(int(frame["timestamp"].iloc[-1])),
            "flags": flag_counts(frame),
        }
    holes = report.gaps[report.gaps["kind"] == "hole"]
    entry["holes"] = {"count": int(len(holes)), "lost_minutes": int(holes["lost_minutes"].sum()), "large": int(len(large_holes(report)))}
    return entry
