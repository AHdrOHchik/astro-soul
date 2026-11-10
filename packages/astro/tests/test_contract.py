"""Соответствие вывода движка контракту `api.openapi.yaml`.

Проверка ловит дрейф: если движок добавит/потеряет поле или отдаст null там,
где контракт его не разрешает, тест упадёт раньше QA.

`nullable: true` в контракте — синтаксис OpenAPI 3.0, формально в 3.1 его нет;
переводим его в JSON Schema 2020-12 (`type: [X, "null"]`) прямо здесь, чтобы
тест проверял смысл. Замена на канонический синтаксис — отдельная правка
контракта (см. отчёт).
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest
import yaml
from jsonschema import Draft202012Validator

from astro import BirthInput, calcChart, transitsFor

CONTRACT_PATH = Path(__file__).resolve().parents[3] / "api.openapi.yaml"

pytestmark = pytest.mark.skipif(
    not CONTRACT_PATH.exists(), reason="контракт не найден рядом с пакетом"
)


def _load_contract() -> dict[str, Any]:
    with CONTRACT_PATH.open(encoding="utf-8") as handle:
        loaded = yaml.safe_load(handle)
    assert isinstance(loaded, dict)
    return loaded


def _resolve(node: Any, root: dict[str, Any]) -> Any:
    """Разворачивает локальные $ref и переводит nullable в JSON Schema 2020-12."""
    if isinstance(node, list):
        return [_resolve(item, root) for item in node]

    if not isinstance(node, dict):
        return node

    if "$ref" in node:
        target: Any = root
        for part in str(node["$ref"]).lstrip("#/").split("/"):
            target = target[part]
        resolved = _resolve(target, root)
        extra = {key: value for key, value in node.items() if key != "$ref"}
        return {**resolved, **_resolve(extra, root)}

    result = {key: _resolve(value, root) for key, value in node.items() if key != "nullable"}

    if node.get("nullable") is True:
        node_type = result.get("type")
        if isinstance(node_type, str):
            result["type"] = [node_type, "null"]

    return result


def test_chart_matches_contract(known_birth: BirthInput) -> None:
    contract = _load_contract()
    schema = _resolve(contract["components"]["schemas"]["Chart"], contract)

    chart = calcChart(known_birth).to_dict()
    # chart_id и created_at добавляет API при сохранении, движок их не знает
    payload = {
        "chart_id": str(uuid.uuid4()),
        "created_at": datetime.now(UTC).isoformat(),
        **chart,
    }

    Draft202012Validator(schema).validate(payload)


def test_chart_without_time_matches_contract(unknown_time_birth: BirthInput) -> None:
    contract = _load_contract()
    schema = _resolve(contract["components"]["schemas"]["Chart"], contract)

    chart = calcChart(unknown_time_birth).to_dict()
    payload = {
        "chart_id": str(uuid.uuid4()),
        "created_at": datetime.now(UTC).isoformat(),
        **chart,
    }

    assert payload["asc"] is None and payload["houses"] is None
    Draft202012Validator(schema).validate(payload)


def test_transits_reference_contract_planet_keys(known_birth: BirthInput) -> None:
    contract = _load_contract()
    allowed = set(
        contract["components"]["schemas"]["PlanetPosition"]["properties"]["key"]["enum"]
    )
    chart = calcChart(known_birth)
    report = transitsFor(known_birth.date, chart).to_dict()

    assert {planet["key"] for planet in report["positions"]} <= allowed
    for aspect in report["aspects"]:
        assert aspect["transit"] in allowed
        assert aspect["natal"] in allowed
