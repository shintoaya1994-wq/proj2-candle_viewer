from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class Found:
    """A signal a screen found.

    ``key`` names it among the findings of the screen for the symbol, so that
    a second run finds it again instead of adding it twice. ``known_at`` is
    the first moment the signal could be known, as UTC milliseconds; for a
    pattern that needs later bars to complete, it is the end of the last
    of them.
    """

    key: str
    shape: str                      # point, level, segment, box
    timeframe: str
    anchors: tuple[tuple[int, float], ...]
    known_at: int
    models: tuple[str, ...] = ()
    note: str = ""
    details: dict = field(default_factory=dict)

    def __post_init__(self) -> None:
        wanted = {"point": 1, "level": 1, "segment": 2, "box": 2}.get(self.shape)
        if wanted is None:
            raise ValueError(f"unknown shape {self.shape}")
        if len(self.anchors) != wanted:
            raise ValueError(f"a {self.shape} has {wanted} anchors, not {len(self.anchors)}")
        if any(self.known_at < int(ts) for ts, _ in self.anchors):
            raise ValueError("a signal cannot be known before its anchors")
