"""Типы движка.

Внутреннее представление богаче контракта: для колеса и транзитов нужны
долготы и скорость, а в ответ API (см. `to_dict`) попадают только поля из
`Chart` в `api.openapi.yaml`. Ничего лишнего наружу не отдаём.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, time
from typing import Any, Literal

EngineMode = Literal["fallback", "swisseph"]


@dataclass(frozen=True, slots=True)
class GeoPlace:
    """Место рождения. Широта/долгота — в градусах, восточная долгота положительная."""

    name: str
    country: str
    lat: float
    lon: float
    tz: str
    region: str | None = None


@dataclass(frozen=True, slots=True)
class BirthInput:
    """Вход движка. `time = None` означает «время неизвестно»."""

    date: date
    time: time | None
    place: GeoPlace

    @property
    def time_known(self) -> bool:
        return self.time is not None

    def to_dict(self) -> dict[str, Any]:
        return {
            "date": self.date.isoformat(),
            "time": self.time.strftime("%H:%M") if self.time is not None else None,
            "time_known": self.time_known,
            "place": {
                "name": self.place.name,
                "region": self.place.region,
                "country": self.place.country,
                "lat": self.place.lat,
                "lon": self.place.lon,
                "tz": self.place.tz,
            },
        }


@dataclass(frozen=True, slots=True)
class PlanetPosition:
    key: str
    name: str
    glyph: str
    longitude: float
    speed: float
    retrograde: bool
    sign: str
    degree: int
    minute: int
    house: int | None

    def to_dict(self) -> dict[str, Any]:
        """Только поля контракта `PlanetPosition`."""
        return {
            "key": self.key,
            "name": self.name,
            "sign": self.sign,
            "degree": self.degree,
            "minute": self.minute,
            "house": self.house,
            "retrograde": self.retrograde,
        }

    @property
    def position_ru(self) -> str:
        return f"{self.degree}°{self.minute:02d}′ {self.sign}"

    @property
    def position_ru_with_retro(self) -> str:
        return self.position_ru + (" (R)" if self.retrograde else "")


@dataclass(frozen=True, slots=True)
class Aspect:
    a: str
    b: str
    type: str
    orb: float
    strength: float
    type_ru: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "a": self.a,
            "b": self.b,
            "type": self.type,
            "orb": self.orb,
            "strength": self.strength,
        }


@dataclass(frozen=True, slots=True)
class Balances:
    elements: dict[str, float]
    modalities: dict[str, float]

    def to_dict(self) -> dict[str, Any]:
        return {"elements": dict(self.elements), "modalities": dict(self.modalities)}


@dataclass(frozen=True, slots=True)
class Chart:
    birth: BirthInput
    planets: tuple[PlanetPosition, ...]
    houses: tuple[float, ...] | None
    asc: float | None
    mc: float | None
    aspects: tuple[Aspect, ...]
    balances: Balances
    engine_version: str
    engine_mode: EngineMode
    house_system: str | None
    omitted_planets: tuple[str, ...] = ()

    def planet(self, key: str) -> PlanetPosition:
        for planet in self.planets:
            if planet.key == key:
                return planet
        raise KeyError(f"планета {key!r} не рассчитана")

    def to_internal(self) -> dict[str, Any]:
        """Числа, которые не попадают в контракт, но нужны транзитам и колесу."""
        return {
            "planets": [
                {
                    "key": planet.key,
                    "longitude": planet.longitude,
                    "speed": planet.speed,
                }
                for planet in self.planets
            ],
            "houses": list(self.houses) if self.houses is not None else None,
            "asc": self.asc,
            "mc": self.mc,
            "engine_mode": self.engine_mode,
            "house_system": self.house_system,
        }

    def to_dict(self) -> dict[str, Any]:
        """Ответ в форме контракта `Chart` (без chart_id и created_at — их ставит API).

        `asc`, `mc` и `houses` = null, когда время рождения неизвестно:
        без времени Плацидус не определён (SPEC, раздел «Астро-движок»).
        """
        houses = None
        if self.houses is not None:
            houses = [
                {"house": index + 1, "sign": sign_of(cusp), "degree": degree_of(cusp)}
                for index, cusp in enumerate(self.houses)
            ]

        return {
            "birth": self.birth.to_dict(),
            "asc": _angle_dict(self.asc),
            "mc": _angle_dict(self.mc),
            "planets": [planet.to_dict() for planet in self.planets],
            "houses": houses,
            "aspects": [aspect.to_dict() for aspect in self.aspects],
            "balances": self.balances.to_dict(),
            "engine_version": self.engine_version,
            # Планеты, которые движок не считает (Chiron без коммерческой
            # лицензии Swiss Ephemeris). Клиент обязан это показать, а не прятать.
            "omitted_planets": list(self.omitted_planets),
        }


@dataclass(frozen=True, slots=True)
class ChartWire:
    """Транспортная форма: ответ контракта + внутренние числа движка.

    `chart` — ровно то, что уходит клиенту (контракт `Chart`).
    `internal` — то, что нужно движку для транзитов и колеса и что API хранит
    в `charts.data`, но никогда не отдаёт наружу (долготы, режим, система домов).
    """

    chart: dict[str, Any]
    internal: dict[str, Any]
    input_hash: str
    omitted_planets: tuple[str, ...]

    def to_dict(self) -> dict[str, Any]:
        return {
            "chart": self.chart,
            "internal": self.internal,
            "input_hash": self.input_hash,
            "omitted_planets": list(self.omitted_planets),
        }


@dataclass(frozen=True, slots=True)
class TransitAspect:
    transit: str
    natal: str
    type: str
    orb: float
    strength: float
    type_ru: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "transit": self.transit,
            "natal": self.natal,
            "type": self.type,
            "orb": self.orb,
            "strength": self.strength,
        }


@dataclass(frozen=True, slots=True)
class TransitReport:
    date: date
    positions: tuple[PlanetPosition, ...]
    aspects: tuple[TransitAspect, ...]
    engine_version: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "date": self.date.isoformat(),
            "positions": [
                {
                    "key": planet.key,
                    "name": planet.name,
                    "sign": planet.sign,
                    "degree": planet.degree,
                    "minute": planet.minute,
                    "retrograde": planet.retrograde,
                }
                for planet in self.positions
            ],
            "aspects": [aspect.to_dict() for aspect in self.aspects],
            "engine_version": self.engine_version,
        }


def sign_of(longitude: float) -> str:
    from .constants import SIGNS

    return SIGNS[int(longitude % 360 // 30)]


def degree_of(longitude: float) -> int:
    return int(longitude % 30)


def minute_of(longitude: float) -> int:
    x = longitude % 30
    return int(round((x - int(x)) * 60)) % 60


def _angle_dict(longitude: float | None) -> dict[str, Any] | None:
    if longitude is None:
        return None
    return {
        "sign": sign_of(longitude),
        "degree": degree_of(longitude),
        "minute": minute_of(longitude),
    }
