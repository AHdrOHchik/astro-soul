"""Сборка и разбор транспортного представления карты.

API (NestJS) хранит в `charts.data` оба блока: `chart` — ответ контракта,
`internal` — числа движка. Для транзитов карта собирается обратно из этого
JSON, поэтому движок остаётся без состояния, а БД — единственным источником.
"""

from __future__ import annotations

from datetime import date, time
from typing import Any

from .constants import ASPECTS, PLANETS
from .engine import hashInput
from .types import (
    Aspect,
    Balances,
    BirthInput,
    Chart,
    GeoPlace,
    PlanetPosition,
    degree_of,
    minute_of,
    sign_of,
)

_ASPECT_RU = {type_en: type_ru for type_en, type_ru, _angle, _orb, _weight in ASPECTS}
_PLANET_NAME = {key: name for key, _id, name, _glyph in PLANETS}
_PLANET_GLYPH = {key: glyph for key, _id, _name, glyph in PLANETS}


def chart_to_wire(chart: Chart, *, engine_mode: str) -> dict[str, Any]:
    """Карта → JSON для API: контракт, внутренние числа и ключ идемпотентности."""
    return {
        "chart": chart.to_dict(),
        "internal": {**chart.to_internal(), "engine_mode": engine_mode},
        "input_hash": hashInput(chart.birth, engine=engine_mode),
        "omitted_planets": list(chart.omitted_planets),
    }


def chart_from_wire(payload: dict[str, Any]) -> Chart:
    """JSON из `charts.data` → `Chart` для `transitsFor` и колеса."""
    chart_data = payload["chart"]
    internal = payload["internal"]
    birth_data = chart_data["birth"]

    place = birth_data["place"]
    birth = BirthInput(
        date=date.fromisoformat(birth_data["date"]),
        time=time.fromisoformat(birth_data["time"]) if birth_data["time"] else None,
        place=GeoPlace(
            name=place["name"],
            country=place["country"],
            lat=float(place["lat"]),
            lon=float(place["lon"]),
            tz=place["tz"],
            region=place.get("region"),
        ),
    )

    planets: list[PlanetPosition] = []
    for planet_data, numbers in zip(chart_data["planets"], internal["planets"], strict=True):
        longitude = float(numbers["longitude"])
        planets.append(
            PlanetPosition(
                key=planet_data["key"],
                name=planet_data["name"],
                glyph=_PLANET_GLYPH[planet_data["key"]],
                longitude=longitude,
                speed=float(numbers["speed"]),
                retrograde=bool(planet_data["retrograde"]),
                sign=planet_data["sign"],
                degree=int(planet_data["degree"]),
                minute=int(planet_data["minute"]),
                house=planet_data["house"],
            )
        )

    balances = chart_data["balances"]
    return Chart(
        birth=birth,
        planets=tuple(planets),
        houses=tuple(internal["houses"]) if internal["houses"] is not None else None,
        asc=internal["asc"],
        mc=internal["mc"],
        aspects=tuple(
            Aspect(
                a=aspect["a"],
                b=aspect["b"],
                type=aspect["type"],
                orb=float(aspect["orb"]),
                strength=float(aspect["strength"]),
                type_ru=_ASPECT_RU[aspect["type"]],
            )
            for aspect in chart_data["aspects"]
        ),
        balances=Balances(
            elements={key: float(value) for key, value in balances["elements"].items()},
            modalities={key: float(value) for key, value in balances["modalities"].items()},
        ),
        engine_version=chart_data["engine_version"],
        engine_mode=internal["engine_mode"],
        house_system=internal["house_system"],
        omitted_planets=tuple(payload.get("omitted_planets") or ()),
    )


def planet_summary(longitude: float) -> dict[str, Any]:
    """Короткая форма позиции — для ответа `POST /transits`."""
    return {
        "sign": sign_of(longitude),
        "degree": degree_of(longitude),
        "minute": minute_of(longitude),
    }


def planet_name(key: str) -> str:
    return _PLANET_NAME[key]
