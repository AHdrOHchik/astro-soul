"""Факты дня (итерация 30): детерминизм, состав, правило управителя дня.

Здесь проверяется ровно то, на чём держится продукт: один и тот же вход даёт
один и тот же JSON, факты не выдумываются (орб ≤ 3°, не больше восьми
транзитов), окна времени суток считаются из транзитов Луны, а не из модели.
"""

from __future__ import annotations

import json
from datetime import date, time

import pytest
from fastapi.testclient import TestClient

from astro import BirthInput, GeoPlace, calcChart
from astro.constants import ENGINE_VERSION, SIGNS
from astro.daily import (
    DAY_RULERS,
    DAY_TRANSIT_ORB_MAX,
    DAY_TRANSITS_MAX,
    PHASES,
    day_facts,
    phase_of,
    ruler_of_day,
)
from astro.service import app

client = TestClient(app)

PLACE = GeoPlace(name="Тестоград", country="RU", lat=55.7558, lon=37.6173, tz="Europe/Moscow")
BIRTH = BirthInput(date=date(1994, 5, 17), time=time(14, 20), place=PLACE)

BIRTH_PAYLOAD = {
    "birth_date": "1994-05-17",
    "birth_time": "14:20",
    "birth_place": {
        "name": "Тестоград",
        "region": None,
        "country": "RU",
        "lat": 55.7558,
        "lon": 37.6173,
        "tz": "Europe/Moscow",
    },
}


@pytest.fixture(scope="module")
def chart_data() -> dict:
    response = client.post("/chart", json=BIRTH_PAYLOAD)
    assert response.status_code == 200
    return response.json()


def test_engine_version_is_bumped() -> None:
    # 1.1.0 — сайдкар получил расчёты дня; старая версия не должна молча
    # выдавать себя за новую, иначе сохранённые прогнозы не отличить.
    assert ENGINE_VERSION == "1.1.0"


def test_facts_are_byte_identical_for_same_input(chart_data: dict) -> None:
    first = client.post(
        "/forecast/facts",
        json={"date": "2026-11-20", "timezone": "Europe/Moscow", "data": chart_data},
    )
    second = client.post(
        "/forecast/facts",
        json={"date": "2026-11-20", "timezone": "Europe/Moscow", "data": chart_data},
    )

    assert first.status_code == 200
    assert second.status_code == 200
    # Побайтово: ни времени процесса, ни случайности в ответе нет.
    assert json.dumps(first.json(), sort_keys=True) == json.dumps(second.json(), sort_keys=True)


def test_facts_shape(chart_data: dict) -> None:
    body = client.post(
        "/forecast/facts",
        json={"date": "2026-11-20", "timezone": "Europe/Moscow", "data": chart_data},
    ).json()

    assert set(body) == {
        "date",
        "timezone",
        "timezone_note",
        "engine_version",
        "noon_utc",
        "moon",
        "retrograde",
        "ruler",
        "transits",
        "windows",
    }
    assert body["date"] == "2026-11-20"
    assert body["timezone"] == "Europe/Moscow"
    # Полдень местного дня — это 09:00 UTC для Москвы (UTC+3).
    assert body["noon_utc"] == "2026-11-20T09:00:00Z"
    assert "места рождения" in body["timezone_note"]

    moon = body["moon"]
    assert moon["sign"] in SIGNS
    assert 0 <= moon["degree"] <= 29
    assert moon["phase"] in {name for _limit, name in PHASES}
    assert 0.0 <= moon["illumination"] <= 1.0

    assert isinstance(body["retrograde"], list)
    assert body["ruler"]["key"] in DAY_RULERS


def test_transits_are_capped_sorted_and_within_orb(chart_data: dict) -> None:
    body = client.post(
        "/forecast/facts",
        json={"date": "2026-11-20", "timezone": "Europe/Moscow", "data": chart_data},
    ).json()

    transits = body["transits"]
    assert 0 < len(transits) <= DAY_TRANSITS_MAX
    for transit in transits:
        assert transit["orb"] <= DAY_TRANSIT_ORB_MAX
        assert set(transit) >= {"transit", "natal", "type", "orb", "strength", "type_ru"}
    strengths = [transit["strength"] for transit in transits]
    assert strengths == sorted(strengths, reverse=True)


def test_windows_are_two_to_three_and_ordered(chart_data: dict) -> None:
    body = client.post(
        "/forecast/facts",
        json={"date": "2026-11-21", "timezone": "Europe/Moscow", "data": chart_data},
    ).json()

    windows = body["windows"]
    assert 2 <= len(windows) <= 3
    for window in windows:
        assert window["kind"] in ("ease", "care", "neutral")
        assert window["from"] < window["to"]
        assert window["label"] != ""
    starts = [window["from"] for window in windows]
    assert starts == sorted(starts)


def test_ruler_of_day_follows_the_weekday_rule() -> None:
    # 2026-11-16 — понедельник … 2026-11-22 — воскресенье.
    week = [ruler_of_day(date(2026, 11, 16 + offset))["key"] for offset in range(7)]

    assert week == ["moon", "mars", "mercury", "jupiter", "venus", "saturn", "sun"]


def test_phase_of_known_points() -> None:
    assert phase_of(0)[0] == "новолуние"
    assert phase_of(0)[1] == 0.0
    assert phase_of(180)[0] == "полнолуние"
    assert phase_of(180)[1] == 1.0
    assert phase_of(90)[0] == "первая четверть"
    assert phase_of(270)[0] == "последняя четверть"


def test_unknown_rate_timezone_is_rejected(chart_data: dict) -> None:
    response = client.post(
        "/forecast/facts",
        json={"date": "2026-11-20", "timezone": "Mars/Olympus", "data": chart_data},
    )

    assert response.status_code == 422


def test_facts_do_not_depend_on_noon_of_the_server(chart_data: dict) -> None:
    # Разные пояса дают разный момент полудня — и разные факты. Это не баг:
    # «сегодня» у человека в Москве и в Камчатке начинается в разное время.
    moscow = day_facts(date(2026, 11, 20), "Europe/Moscow", calcChart(BIRTH))
    kamchatka = day_facts(date(2026, 11, 20), "Asia/Kamchatka", calcChart(BIRTH))

    assert moscow["noon_utc"] != kamchatka["noon_utc"]
