"""Сайдкар: контракт эндпоинтов и согласованность с движком."""

from __future__ import annotations

from fastapi.testclient import TestClient

from astro.service import app

client = TestClient(app)

BIRTH = {
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


def test_health_reports_engine_version() -> None:
    response = client.get("/health")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["engine_version"]
    assert body["engine_mode"] in ("fallback", "swisseph")


def test_chart_returns_contract_internal_and_hash() -> None:
    response = client.post("/chart", json=BIRTH)

    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"chart", "internal", "input_hash", "omitted_planets"}
    assert body["input_hash"].startswith("sha256:")
    assert body["chart"]["planets"]
    assert body["internal"]["planets"][0]["longitude"] > 0
    assert body["chart"]["birth"]["time_known"] is True


def test_chart_is_idempotent_by_hash() -> None:
    first = client.post("/chart", json=BIRTH).json()
    second = client.post("/chart", json=BIRTH).json()

    assert first["input_hash"] == second["input_hash"]
    assert first["chart"] == second["chart"]


def test_unknown_time_gives_null_houses() -> None:
    payload = {**BIRTH, "birth_time": None}

    body = client.post("/chart", json=payload).json()

    assert body["chart"]["asc"] is None
    assert body["chart"]["houses"] is None
    assert body["internal"]["houses"] is None


def test_transits_use_saved_chart() -> None:
    chart = client.post("/chart", json=BIRTH).json()

    response = client.post(
        "/transits",
        json={
            "date": "2026-11-11",
            "data": {
                "chart": chart["chart"],
                "internal": chart["internal"],
                "omitted_planets": chart["omitted_planets"],
            },
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["date"] == "2026-11-11"
    assert {item["key"] for item in body["positions"]} >= {"sun", "moon"}
    for aspect in body["aspects"]:
        assert aspect["natal"] in {planet["key"] for planet in chart["chart"]["planets"]}


def test_wheel_supports_both_themes() -> None:
    chart = client.post("/chart", json=BIRTH).json()
    data = {
        "chart": chart["chart"],
        "internal": chart["internal"],
        "omitted_planets": chart["omitted_planets"],
    }

    for theme in ("dark", "light"):
        response = client.post("/wheel", json={"data": data, "theme": theme})
        assert response.status_code == 200
        svg = response.json()["svg"]
        assert svg.startswith("<svg ")
        assert "#ffffff" in svg if theme == "light" else "#0b1020" in svg

    assert client.post("/wheel", json={"data": data, "theme": "neon"}).status_code == 422


def test_invalid_input_is_rejected() -> None:
    bad_lat = {**BIRTH, "birth_place": {**BIRTH["birth_place"], "lat": 120.0}}
    assert client.post("/chart", json=bad_lat).status_code == 422

    bad_tz = {**BIRTH, "birth_place": {**BIRTH["birth_place"], "tz": "Mars/Olympus"}}
    assert client.post("/chart", json=bad_tz).status_code == 422
