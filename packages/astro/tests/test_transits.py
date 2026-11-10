"""Транзиты: детерминизм, форма, связь с натальной картой."""

from __future__ import annotations

import json
from datetime import date

from astro import BirthInput, calcChart, transitsFor


def test_transit_report_is_deterministic(known_birth: BirthInput) -> None:
    chart = calcChart(known_birth)
    on_date = date(2026, 11, 11)

    first = json.dumps(transitsFor(on_date, chart).to_dict(), sort_keys=True, ensure_ascii=False)
    second = json.dumps(transitsFor(on_date, chart).to_dict(), sort_keys=True, ensure_ascii=False)

    assert first == second


def test_transit_report_shape(known_birth: BirthInput) -> None:
    chart = calcChart(known_birth)
    report = transitsFor(date(2026, 11, 11), chart).to_dict()

    assert report["date"] == "2026-11-11"
    assert report["engine_version"] == chart.engine_version
    assert len(report["positions"]) >= 10
    assert {planet["key"] for planet in report["positions"]} >= {"sun", "moon", "mars"}

    natal_keys = {planet.key for planet in chart.planets}
    for aspect in report["aspects"]:
        assert aspect["transit"] in {planet["key"] for planet in report["positions"]}
        assert aspect["natal"] in natal_keys
        assert aspect["type"] in {"conjunction", "opposition", "trine", "square", "sextile"}
        assert 0 <= aspect["strength"] <= 1

    strengths = [aspect["strength"] for aspect in report["aspects"]]
    assert strengths == sorted(strengths, reverse=True)


def test_different_days_give_different_positions(known_birth: BirthInput) -> None:
    chart = calcChart(known_birth)

    day_one = transitsFor(date(2026, 11, 11), chart).to_dict()
    day_two = transitsFor(date(2026, 12, 11), chart).to_dict()

    moon_one = next(item for item in day_one["positions"] if item["key"] == "moon")
    moon_two = next(item for item in day_two["positions"] if item["key"] == "moon")

    assert (moon_one["sign"], moon_one["degree"]) != (moon_two["sign"], moon_two["degree"])
