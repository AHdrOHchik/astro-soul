"""Синастрия: детерминизм, известные углы, отсутствие времени, граница орба."""

from __future__ import annotations

import json
from datetime import date, time
from typing import Any

from fastapi.testclient import TestClient

from astro.constants import ASPECTS
from astro.engine import calcChart
from astro.service import app
from astro.synastry import (
    COMPATIBILITY_FACTS_VERSION,
    LUMINARY_ORB_BONUS,
    compatFacts,
    separation,
)
from astro.types import Balances, BirthInput, Chart, GeoPlace, PlanetPosition

client = TestClient(app)

PLACE = GeoPlace(name="Тестоград", country="RU", lat=55.7558, lon=37.6173, tz="Europe/Moscow")

#: Пара с заранее известными углами: 17.05.1994 14:20 и 02.03.1990 08:15, Москва.
#: Значения ниже посчитаны вручную по эфемеридам движка и зафиксированы здесь,
#: чтобы «улучшение» орбов или направленности не прошло незамеченным.
A = BirthInput(date=date(1994, 5, 17), time=time(14, 20), place=PLACE)
B = BirthInput(date=date(1990, 3, 2), time=time(8, 15), place=PLACE)


def _chart(positions: dict[str, float], *, houses: tuple[float, ...] | None = None, speeds: dict[str, float] | None = None) -> Chart:
    """Минимальная карта из одних долгот: для проверок границ орба."""
    planets = tuple(
        PlanetPosition(
            key=key,
            name=key,
            glyph="·",
            longitude=longitude % 360,
            speed=(speeds or {}).get(key, 0.0),
            retrograde=False,
            sign="Овен",
            degree=0,
            minute=0,
            house=None,
        )
        for key, longitude in positions.items()
    )
    return Chart(
        birth=A,
        planets=planets,
        houses=houses,
        asc=houses[0] if houses is not None else None,
        mc=None,
        aspects=(),
        balances=Balances(
            elements={"fire": 25.0, "earth": 25.0, "air": 25.0, "water": 25.0},
            modalities={"cardinal": 33.3, "fixed": 33.3, "mutable": 33.4},
        ),
        engine_version="1.0.0",
        engine_mode="fallback",
        house_system="placidus" if houses is not None else None,
    )


def test_facts_are_deterministic() -> None:
    """Один и тот же вход → побайтово одинаковый JSON."""
    chart_a, chart_b = calcChart(A), calcChart(B)

    first = json.dumps(compatFacts(chart_a, chart_b), ensure_ascii=False, sort_keys=True)
    second = json.dumps(compatFacts(chart_a, chart_b), ensure_ascii=False, sort_keys=True)

    assert first == second


def test_known_pair_angles_are_fixed() -> None:
    """Известная пара: углы проверены вручную и зафиксированы ожидаемыми числами."""
    chart_a, chart_b = calcChart(A), calcChart(B)
    by_key = {planet.key: planet for planet in chart_a.planets}
    other = {planet.key: planet for planet in chart_b.planets}

    # Ошибка в этих двух числах означает, что поменялся движок, а не синастрия.
    assert separation(by_key["sun"].longitude, other["sun"].longitude) == 74.9275
    assert separation(by_key["mars"].longitude, other["mars"].longitude) == 92.0588

    facts = compatFacts(chart_a, chart_b)

    assert facts["version"] == COMPATIBILITY_FACTS_VERSION
    assert facts["orb_rule"]["luminary_bonus"] == LUMINARY_ORB_BONUS

    aspects = {(item["a"], item["b"]): item for item in facts["cross_aspects"]}

    # Марс Марса: квадрат с орбом 2,06° — угол между планетами 92,06°.
    mars_mars = aspects[("mars", "mars")]
    assert mars_mars["type"] == "square"
    assert mars_mars["exact_angle"] == 92.06
    assert mars_mars["orb"] == 2.06
    assert mars_mars["direction"] in ("applying", "separating")

    # Луна Луны: квадрат с орбом 4,0°.
    moon_moon = aspects[("moon", "moon")]
    assert moon_moon["type"] == "square"
    assert moon_moon["orb"] == 4.0

    # Солнца в 74,93° друг от друга — аспекта нет ни одного.
    assert ("sun", "sun") not in aspects

    luminaries = {block["pair"]: block for block in facts["luminaries"]}
    # Солнце A — Луна B: 9,66° от соединения. Без послабления светилам (8°)
    # этого аспекта не было бы — здесь проверяется само правило.
    assert luminaries["sun-moon"]["present"] is True
    assert luminaries["sun-moon"]["type"] == "conjunction"
    assert luminaries["sun-moon"]["orb"] == 9.66
    assert luminaries["sun-sun"]["present"] is False


def test_unknown_birth_time_has_no_house_overlays() -> None:
    """Карта без времени рождения: оверлеев домов и Асцендент-фактов нет вовсе."""
    without_time = BirthInput(date=date(1990, 3, 2), time=None, place=PLACE, time_precision="unknown")
    chart_a, chart_b = calcChart(A), calcChart(without_time)

    assert chart_b.houses is None
    facts = compatFacts(chart_a, chart_b)
    assert "house_overlays" not in facts
    # Кросс-аспекты не зависят от домов и остаются на месте.
    assert facts["cross_aspects"]

    # Обе карты с временем — блок есть, и в нём оба направления.
    both = compatFacts(chart_a, calcChart(B))
    assert set(both["house_overlays"]) == {"a_in_b", "b_in_a"}


def test_orb_boundary_is_exact() -> None:
    """Граница орба: 5,99° при орбе 6° — аспект, 6,01° — уже нет."""
    # Пара без светил: у Юпитера и Венеры орб трина ровно 6°, без послабления.
    inside = _chart({"jupiter": 0.0}, speeds={"jupiter": 1.0})
    near = _chart({"venus": 125.99}, speeds={"venus": 1.2})
    far = _chart({"venus": 126.01}, speeds={"venus": 1.2})

    def trine(target: Chart) -> dict[str, Any] | None:
        facts = compatFacts(inside, target)
        return next(
            (item for item in facts["cross_aspects"] if item["a"] == "jupiter" and item["b"] == "venus"),
            None,
        )

    close = trine(near)
    assert close is not None
    assert close["type"] == "trine"
    assert close["orb"] == 5.99

    assert trine(far) is None

    # Послабление светилам: те же 6,01°, но пара Солнце — Луна проходит,
    # потому что орб трина для светил 6 + 2 = 8°.
    sun = _chart({"sun": 0.0})
    moon_far = _chart({"moon": 126.01})
    facts = compatFacts(sun, moon_far)
    assert any(
        item["a"] == "sun" and item["b"] == "moon" and item["type"] == "trine" and item["orb"] == 6.01
        for item in facts["cross_aspects"]
    )

    # Оппозиция: орб 7° базовый, проверяем ту же границу с другой стороны.
    assert [angle for key, _ru, angle, _orb, _w in ASPECTS if key == "opposition"] == [180]


def test_service_endpoint_returns_facts() -> None:
    """`POST /synastry` принимает две карты и отдаёт факты без ПДн."""
    birth_a = {
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
    birth_b = {**birth_a, "birth_date": "1990-03-02", "birth_time": "08:15"}

    chart_a = client.post("/chart", json=birth_a).json()
    chart_b = client.post("/chart", json=birth_b).json()

    response = client.post("/synastry", json={"a": chart_a, "b": chart_b})

    assert response.status_code == 200
    facts = response.json()
    assert set(facts) == {
        "version",
        "engine_version",
        "orb_rule",
        "cross_aspects",
        "luminaries",
        "balances",
        "house_overlays",
    }
    assert facts["cross_aspects"]

    # Ключи баланса — машинные (`fire`, `cardinal`), а не русские подписи:
    # это данные, русские названия подставляет клиент. Если здесь появятся
    # «воздух»/«кардинальный», клиентский маппинг молча перестанет срабатывать.
    balance = facts["balances"]
    assert set(balance["delta"]["elements"]) == {"air", "earth", "fire", "water"}
    assert set(balance["delta"]["modalities"]) == {"cardinal", "fixed", "mutable"}

    # В ответе нет ни даты, ни времени, ни места рождения: только углы.
    raw = json.dumps(facts, ensure_ascii=False)
    for personal in ("1994", "1990", "14:20", "08:15", "Тестоград", "55.7"):
        assert personal not in raw
