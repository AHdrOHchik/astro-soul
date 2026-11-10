"""Контекст для LLM: только факты и никаких персональных данных."""

from __future__ import annotations

import json

from astro import BirthInput, calcChart, llmContext


def test_context_has_required_facts(known_birth: BirthInput) -> None:
    facts = llmContext(calcChart(known_birth))

    assert set(facts) >= {"солнце", "луна", "асцендент", "mc", "планеты", "стихии", "кресты"}
    assert facts["солнце"].endswith("Телец")
    assert facts["асцендент"] is not None
    assert facts["дома"] is not None
    assert len(facts["сильнейшие_аспекты"]) <= 8


def test_context_has_no_personal_data(known_birth: BirthInput) -> None:
    chart = calcChart(known_birth)
    serialized = json.dumps(llmContext(chart), ensure_ascii=False).lower()

    # Название места, дата и время рождения, координаты и telegram_id не уходят в промпт
    assert known_birth.place.name.lower() not in serialized
    assert "1994-05-17" not in serialized
    assert "14:20" not in serialized
    assert "55.7558" not in serialized
    assert "37.6173" not in serialized
    assert "telegram" not in serialized
    for forbidden in ("birth_date", "birth_time", "latitude", "longitude", "telegram_id"):
        assert forbidden not in serialized


def test_context_marks_unknown_houses(unknown_time_birth: BirthInput) -> None:
    facts = llmContext(calcChart(unknown_time_birth))

    assert facts["асцендент"] is None
    assert facts["mc"] is None
    assert facts["дома"] is None
    assert "не рассчитаны" in facts["примечание"]
