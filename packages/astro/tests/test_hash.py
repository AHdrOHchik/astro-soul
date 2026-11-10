"""hashInput: идемпотентность POST /charts."""

from __future__ import annotations

from datetime import date, time

from astro import BirthInput, GeoPlace, hashInput


def test_hash_is_stable(known_birth: BirthInput) -> None:
    assert hashInput(known_birth) == hashInput(known_birth)
    assert hashInput(known_birth).startswith("sha256:")


def test_hash_ignores_place_name(known_birth: BirthInput) -> None:
    renamed = BirthInput(
        date=known_birth.date,
        time=known_birth.time,
        place=GeoPlace(
            name="Moscow",
            country="RU",
            lat=known_birth.place.lat,
            lon=known_birth.place.lon,
            tz=known_birth.place.tz,
        ),
    )

    assert hashInput(renamed) == hashInput(known_birth)


def test_hash_changes_with_time(known_birth: BirthInput) -> None:
    other_time = BirthInput(date=known_birth.date, time=time(14, 21), place=known_birth.place)

    assert hashInput(other_time) != hashInput(known_birth)


def test_hash_changes_when_time_becomes_unknown(known_birth: BirthInput, unknown_time_birth: BirthInput) -> None:
    assert hashInput(unknown_time_birth) != hashInput(known_birth)


def test_hash_changes_with_coordinates(known_birth: BirthInput) -> None:
    moved = BirthInput(
        date=known_birth.date,
        time=known_birth.time,
        place=GeoPlace(
            name="Тестоград",
            country="RU",
            lat=59.9343,
            lon=30.3351,
            tz="Europe/Moscow",
        ),
    )

    assert hashInput(moved) != hashInput(known_birth)


def test_hash_normalizes_negative_zero() -> None:
    zero = GeoPlace(name="X", country="RU", lat=0.0, lon=0.0, tz="UTC")
    negative_zero = GeoPlace(name="X", country="RU", lat=-0.0, lon=-0.00001, tz="UTC")

    birth_a = BirthInput(date=date(2000, 1, 1), time=time(12, 0), place=zero)
    birth_b = BirthInput(date=date(2000, 1, 1), time=time(12, 0), place=negative_zero)

    assert hashInput(birth_a) == hashInput(birth_b)


def test_hash_depends_on_engine_mode(known_birth: BirthInput) -> None:
    assert hashInput(known_birth, engine="fallback") != hashInput(known_birth, engine="swisseph")
