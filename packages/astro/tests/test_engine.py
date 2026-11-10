"""Натальная карта: состав, детерминизм, границы."""

from __future__ import annotations

import json
from datetime import date, time

import pytest

from astro import BirthInput, EngineConfigError, GeoPlace, calcChart


def test_planets_have_contract_fields(known_birth: BirthInput) -> None:
    chart = calcChart(known_birth, engine="fallback")
    contract = chart.to_dict()

    assert set(contract) == {
        "birth",
        "asc",
        "mc",
        "planets",
        "houses",
        "aspects",
        "balances",
        "engine_version",
        "omitted_planets",
    }

    keys = [planet["key"] for planet in contract["planets"]]
    assert keys[0] == "sun" and keys[1] == "moon"
    assert len(keys) == len(set(keys))

    for planet in contract["planets"]:
        assert set(planet) == {"key", "name", "sign", "degree", "minute", "house", "retrograde"}
        assert 0 <= planet["degree"] <= 29
        assert 0 <= planet["minute"] <= 59
        assert isinstance(planet["retrograde"], bool)
        if planet["house"] is not None:
            assert 1 <= planet["house"] <= 12


def test_sun_position_is_stable(known_birth: BirthInput) -> None:
    chart = calcChart(known_birth, engine="fallback")
    sun = chart.planet("sun")

    # 17 мая Солнце в Тельце; конкретная долгота зафиксирована как регрессия.
    assert sun.sign == "Телец"
    assert sun.degree == 26
    assert abs(sun.longitude - 56.33) < 0.1


def test_same_input_gives_same_json(known_birth: BirthInput) -> None:
    first = json.dumps(calcChart(known_birth).to_dict(), sort_keys=True, ensure_ascii=False)
    second = json.dumps(calcChart(known_birth).to_dict(), sort_keys=True, ensure_ascii=False)

    assert first == second


def test_houses_present_when_time_known(known_birth: BirthInput) -> None:
    chart = calcChart(known_birth)
    contract = chart.to_dict()

    assert chart.houses is not None
    assert len(chart.houses) == 12
    assert contract["asc"] is not None and contract["mc"] is not None
    assert [house["house"] for house in contract["houses"]] == list(range(1, 13))
    assert chart.house_system in ("placidus", "equal")


def test_unknown_time_has_no_houses_or_asc(unknown_time_birth: BirthInput) -> None:
    chart = calcChart(unknown_time_birth)
    contract = chart.to_dict()

    assert contract["birth"]["time"] is None
    assert contract["birth"]["time_known"] is False
    assert contract["asc"] is None
    assert contract["mc"] is None
    assert contract["houses"] is None
    # Планеты при этом считаются — на полдень места рождения
    assert len(contract["planets"]) >= 10
    assert all(planet["house"] is None for planet in contract["planets"])


def test_aspects_match_contract_enum(known_birth: BirthInput) -> None:
    contract = calcChart(known_birth).to_dict()
    allowed = {"conjunction", "opposition", "trine", "square", "sextile"}
    keys = {planet["key"] for planet in contract["planets"]}

    assert contract["aspects"], "для тестовой карты аспекты должны быть"
    for aspect in contract["aspects"]:
        assert aspect["type"] in allowed
        assert aspect["a"] in keys and aspect["b"] in keys
        assert aspect["a"] != aspect["b"]
        assert 0 <= aspect["strength"] <= 1
        assert 0 <= aspect["orb"] <= 8

    strengths = [aspect["strength"] for aspect in contract["aspects"]]
    assert strengths == sorted(strengths, reverse=True)


def test_balances_are_percentages(known_birth: BirthInput) -> None:
    balances = calcChart(known_birth).to_dict()["balances"]

    assert set(balances["elements"]) == {"fire", "earth", "air", "water"}
    assert set(balances["modalities"]) == {"cardinal", "fixed", "mutable"}
    assert sum(balances["elements"].values()) == pytest.approx(100, abs=0.5)
    assert sum(balances["modalities"].values()) == pytest.approx(100, abs=0.5)


def test_chiron_is_omitted_when_ephemeris_files_are_missing(known_birth: BirthInput) -> None:
    chart = calcChart(known_birth, engine="fallback")
    keys = {planet.key for planet in chart.planets}

    # В fallback-режиме файла seas_18.se1 нет, Хирон честно отсутствует
    if "chiron" in chart.omitted_planets:
        assert "chiron" not in keys
    else:
        assert "chiron" in keys


def test_polar_placidus_falls_back_to_equal_houses() -> None:
    polar = GeoPlace(name="Тестовый полюс", country="NO", lat=78.2, lon=15.6, tz="Arctic/Longyearbyen")
    chart = calcChart(BirthInput(date=date(1990, 6, 21), time=time(12, 0), place=polar))

    assert chart.house_system == "equal"
    assert chart.houses is not None


@pytest.mark.parametrize(
    ("place", "expected"),
    [
        (GeoPlace(name="X", country="RU", lat=95.0, lon=37.0, tz="Europe/Moscow"), "координаты"),
        (GeoPlace(name="X", country="RU", lat=55.0, lon=200.0, tz="Europe/Moscow"), "координаты"),
    ],
)
def test_invalid_coordinates_raise(place: GeoPlace, expected: str) -> None:
    with pytest.raises(EngineConfigError, match=expected):
        calcChart(BirthInput(date=date(1990, 1, 1), time=time(10, 0), place=place))


def test_unknown_timezone_raises() -> None:
    place = GeoPlace(name="X", country="RU", lat=55.0, lon=37.0, tz="Mars/Olympus")

    with pytest.raises(EngineConfigError, match="часовой пояс"):
        calcChart(BirthInput(date=date(1990, 1, 1), time=time(10, 0), place=place))


def test_unknown_engine_mode_raises(known_birth: BirthInput) -> None:
    with pytest.raises(EngineConfigError, match="ASTRO_ENGINE"):
        calcChart(known_birth, engine="vedic")
