"""Общие фикстуры. Данные вымышленные (AGENTS.md §8)."""

from __future__ import annotations

import dataclasses
from datetime import date, time

import pytest

from astro import BirthInput, GeoPlace, calcChart


@pytest.fixture()
def moscow_place() -> GeoPlace:
    return GeoPlace(name="Тестоград", country="RU", lat=55.7558, lon=37.6173, tz="Europe/Moscow")


@pytest.fixture()
def known_birth(moscow_place: GeoPlace) -> BirthInput:
    return BirthInput(date=date(1994, 5, 17), time=time(14, 20), place=moscow_place)


@pytest.fixture()
def unknown_time_birth(moscow_place: GeoPlace) -> BirthInput:
    return BirthInput(date=date(1994, 5, 17), time=None, place=moscow_place)


@pytest.fixture()
def crowded_birth(moscow_place: GeoPlace) -> BirthInput:
    """Дата, на которую планеты толпятся: проверка раскладки в худшем случае."""
    return BirthInput(date=date(2002, 9, 21), time=time(12, 0), place=moscow_place)


@pytest.fixture()
def stacked_chart(known_birth: BirthInput):
    """Стеллиум: четыре светила в 7,5° — самый частый реальный случай скученности."""
    chart = calcChart(known_birth)
    cluster = {"sun": 15.0, "moon": 17.5, "mercury": 20.0, "venus": 22.5}
    planets = tuple(
        dataclasses.replace(planet, longitude=cluster.get(planet.key, planet.longitude))
        for planet in chart.planets
    )
    return dataclasses.replace(chart, planets=planets)
