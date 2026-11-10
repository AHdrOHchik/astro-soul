"""Общие фикстуры. Данные вымышленные (AGENTS.md §8)."""

from __future__ import annotations

from datetime import date, time

import pytest

from astro import BirthInput, GeoPlace


@pytest.fixture()
def moscow_place() -> GeoPlace:
    return GeoPlace(name="Тестоград", country="RU", lat=55.7558, lon=37.6173, tz="Europe/Moscow")


@pytest.fixture()
def known_birth(moscow_place: GeoPlace) -> BirthInput:
    return BirthInput(date=date(1994, 5, 17), time=time(14, 20), place=moscow_place)


@pytest.fixture()
def unknown_time_birth(moscow_place: GeoPlace) -> BirthInput:
    return BirthInput(date=date(1994, 5, 17), time=None, place=moscow_place)
