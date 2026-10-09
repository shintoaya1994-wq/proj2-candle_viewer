"""Screens: scripts that look for signals and touches in the bars.

A screen is a Python module with::

    NAME = "local_extremes"                      # how it is called and stored as the origin of its signals
    TITLE = "局部高低点"                           # for lists
    PARAMS = {"timeframe": "d1", "window": 20}   # what can be changed, with the defaults

    def run(market: Market, symbol: str, params: dict) -> list[Found]:
        ...

The market hands the script bars only up to a moment it is told (``as_of``),
so a script cannot look past it. Every signal a script returns says when it
became knowable (``known_at``); the look-ahead check in ``runner.check`` runs
the script on cut data and sees whether that claim holds.

Scripts of the user live in ``<workspace>/screens``; the package ships a few
in ``candle_viewer.screens``.
"""

from .market import Bars, Market, atr, rolling_max_before, rolling_min_before
from .model import Found

__all__ = ["Bars", "Found", "Market", "atr", "rolling_max_before", "rolling_min_before"]
