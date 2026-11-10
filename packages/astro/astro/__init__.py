"""Астро-движок «Разбор личности».

Публичный API — имена из SPEC: `calcChart`, `transitsFor`, `llmContext`,
`renderWheel`, `hashInput`. Всё остальное — внутреннее.
"""

from __future__ import annotations

from .engine import EngineConfigError, calcChart, hashInput, llmContext, transitsFor
from .types import (
    Aspect,
    Balances,
    BirthInput,
    Chart,
    EngineMode,
    GeoPlace,
    PlanetPosition,
    TransitAspect,
    TransitReport,
)
from .wheel import renderWheel

__all__ = [
    "Aspect",
    "Balances",
    "BirthInput",
    "Chart",
    "EngineConfigError",
    "EngineMode",
    "GeoPlace",
    "PlanetPosition",
    "TransitAspect",
    "TransitReport",
    "calcChart",
    "hashInput",
    "llmContext",
    "renderWheel",
    "transitsFor",
]

__version__ = "0.1.0"
