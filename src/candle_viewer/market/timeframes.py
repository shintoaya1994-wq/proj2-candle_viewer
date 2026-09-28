"""Timeframe definitions shared by the data pipeline and the application."""

from __future__ import annotations

from dataclasses import dataclass

MINUTE_MS = 60_000
HOUR_MS = 3_600_000
DAY_MS = 86_400_000


@dataclass(frozen=True)
class Timeframe:
    """One bar size.

    ``kind`` decides how bars are aligned:

    * ``intraday`` – fixed length of ``span`` minutes on the chart clock
    * ``day``      – one trading day
    * ``week``     – Monday to Friday trading days
    * ``month``    – ``span`` calendar months of trading days
    """

    name: str
    kind: str
    span: int

    @property
    def is_intraday(self) -> bool:
        return self.kind == "intraday"

    @property
    def minutes(self) -> int:
        """Nominal length in minutes (intraday only)."""
        if not self.is_intraday:
            raise ValueError(f"{self.name} has no fixed length in minutes")
        return self.span


# Ordered from finest to coarsest. Names match the tokens used in raw file names.
ALL: tuple[Timeframe, ...] = (
    Timeframe("m1", "intraday", 1),
    Timeframe("m15", "intraday", 15),
    Timeframe("h1", "intraday", 60),
    Timeframe("h4", "intraday", 240),
    Timeframe("d1", "day", 1),
    Timeframe("w1", "week", 1),
    Timeframe("1mo", "month", 1),
    Timeframe("3mo", "month", 3),
)

BY_NAME: dict[str, Timeframe] = {tf.name: tf for tf in ALL}

BASE = BY_NAME["m1"]
DAILY = BY_NAME["d1"]


def get(name: str) -> Timeframe:
    try:
        return BY_NAME[name]
    except KeyError:
        raise ValueError(f"unknown timeframe {name!r}; expected one of {list(BY_NAME)}") from None
