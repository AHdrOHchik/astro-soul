"""Движок натальной карты. Прототип `astro/engine.py` удалён из дерева
(его история — в git), чтобы не запускали не тот файл.

Публичный API (имена — как в SPEC и в задаче):
    calcChart(input)             — натальная карта: планеты, дома, аспекты, балансы
    transitsFor(date, chart)     — транзиты на дату (для прогноза)
    llmContext(chart)            — только факты для промпта, без ПДн
    renderWheel(chart)           — SVG-колесо (см. wheel.py)
    hashInput(birth)             — детерминированный ключ идемпотентности

Детерминизм: одинаковый вход → одинаковый JSON. Долготы округляются до
4 знаков, порядок планет и аспектов фиксирован, сортировка аспектов имеет
полный набор ключей (без «стабильной случайности»).

Режимы (`ASTRO_ENGINE`, по умолчанию `fallback`):
    fallback — встроенная эфемерида Moshier, файлы .se1 не нужны;
    swisseph — файлы Swiss Ephemeris из `SE_EPHE_PATH`.
"""

from __future__ import annotations

import hashlib
import json
import os
from datetime import UTC, datetime
from datetime import date as date_type
from datetime import time as time_type
from typing import Any, Final, cast
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import swisseph as swe

from .constants import (
    ASPECT_PLANETS,
    ASPECTS,
    DEFAULT_ENGINE_MODE,
    ELEMENT_NAMES_RU,
    ELEMENTS,
    ENGINE_MODES,
    ENGINE_VERSION,
    LUMINARY_WEIGHT,
    MODALITIES,
    MODALITY_NAMES_RU,
    PLANET_WEIGHT,
    PLANETS,
    TRANSIT_ORBS,
)
from .types import (
    Aspect,
    Balances,
    BirthInput,
    Chart,
    EngineMode,
    PlanetPosition,
    TransitAspect,
    TransitReport,
    degree_of,
    minute_of,
    sign_of,
)

#: Идентификаторы планет в swisseph (SUN, MOON, ...), собраны один раз.
_SWE_IDS: Final[dict[str, int]] = {
    key: getattr(swe, swe_attr) for key, swe_attr, _name, _glyph in PLANETS
}
_PLANET_NAMES: Final[dict[str, str]] = {key: name for key, _id, name, _glyph in PLANETS}
_PLANET_GLYPHS: Final[dict[str, str]] = {key: glyph for key, _id, _name, glyph in PLANETS}

#: Сколько сильнейших аспектов попадает в контекст для LLM.
LLM_TOP_ASPECTS: Final[int] = 8

#: Полдень — момент по умолчанию, если время рождения неизвестно:
#: планеты считаются, дома и Асцендент — нет.
UNKNOWN_TIME_HOUR: Final[int] = 12


class EngineConfigError(RuntimeError):
    """Неверная конфигурация движка (режим, часовой пояс, координаты)."""


def _resolve_mode(engine: str | None) -> EngineMode:
    mode = engine if engine is not None else os.environ.get("ASTRO_ENGINE", DEFAULT_ENGINE_MODE)
    if mode not in ENGINE_MODES:
        raise EngineConfigError(
            f"ASTRO_ENGINE={mode!r}: допустимые значения — {', '.join(ENGINE_MODES)}"
        )
    return cast(EngineMode, mode)


def _ephemeris_flags(mode: EngineMode) -> int:
    base = swe.FLG_SPEED
    return base | (swe.FLG_SWIEPH if mode == "swisseph" else swe.FLG_MOSEPH)


def _configure_ephemeris(mode: EngineMode) -> None:
    """В fallback-режиме путь к файлам не трогаем: расчёт идёт без .se1."""
    if mode != "swisseph":
        return
    path = os.environ.get("SE_EPHE_PATH")
    if path and os.path.isdir(path):
        swe.set_ephe_path(path)


def _julian_day(moment_utc: datetime) -> float:
    hours = moment_utc.hour + moment_utc.minute / 60 + moment_utc.second / 3600
    return swe.julday(moment_utc.year, moment_utc.month, moment_utc.day, hours)


def _local_moment(birth: BirthInput) -> datetime:
    try:
        tzinfo = ZoneInfo(birth.place.tz)
    except (ZoneInfoNotFoundError, ValueError) as error:
        raise EngineConfigError(f"неизвестный часовой пояс: {birth.place.tz!r}") from error

    moment = birth.time if birth.time is not None else time_type(UNKNOWN_TIME_HOUR, 0)
    return datetime.combine(birth.date, moment, tzinfo=tzinfo)


def _raw_position(jd: float, swe_id: int, mode: EngineMode) -> tuple[float, float]:
    """Долгота и скорость; Moshier не знает Хирона и бросает swe.Error."""
    coordinates, _flags = swe.calc_ut(jd, swe_id, _ephemeris_flags(mode))
    return float(coordinates[0]), float(coordinates[3])


def _planet_position(
    key: str, longitude: float, speed: float, house: int | None
) -> PlanetPosition:
    lon = round(longitude % 360, 4)
    return PlanetPosition(
        key=key,
        name=_PLANET_NAMES[key],
        glyph=_PLANET_GLYPHS[key],
        longitude=lon,
        speed=round(speed, 4),
        retrograde=speed < 0,
        sign=sign_of(lon),
        degree=degree_of(lon),
        minute=minute_of(lon),
        house=house,
    )


def _compute_planets(
    jd: float, mode: EngineMode, cusps: tuple[float, ...] | None
) -> tuple[tuple[PlanetPosition, ...], tuple[str, ...]]:
    planets: list[PlanetPosition] = []
    omitted: list[str] = []

    for key, _swe_attr, _name, _glyph in PLANETS:
        try:
            longitude, speed = _raw_position(jd, _SWE_IDS[key], mode)
        except swe.Error:
            # Хирон требует файл seas_18.se1 из Swiss Ephemeris: в fallback-режиме
            # его нет, поэтому планета честно отсутствует в карте, а не врёт числом.
            omitted.append(key)
            continue
        house = _house_of(longitude, cusps) if cusps is not None else None
        planets.append(_planet_position(key, longitude, speed, house))

    return tuple(planets), tuple(omitted)


def _houses(
    jd: float, lat: float, lon: float
) -> tuple[tuple[float, ...] | None, float | None, float | None, str | None]:
    """Дома Плацидуса; за полярным кругом Плацидус не определён — равнодомная."""
    if abs(lat) > 90 or abs(lon) > 180:
        raise EngineConfigError(f"координаты вне диапазона: lat={lat}, lon={lon}")

    for system, name in ((b"P", "placidus"), (b"E", "equal")):
        try:
            cusps, ascmc = swe.houses(jd, lat, lon, system)
        except swe.Error:
            continue
        return tuple(round(float(cusp) % 360, 4) for cusp in cusps), float(ascmc[0]), float(
            ascmc[1]
        ), name

    return None, None, None, None


def _house_of(longitude: float, cusps: tuple[float, ...]) -> int:
    """Номер дома по куспидам: [куспид_i, куспид_{i+1}) по часовой стрелке."""
    value = longitude % 360
    for index in range(len(cusps)):
        start = cusps[index]
        end = cusps[(index + 1) % len(cusps)]
        offset = (value - start) % 360
        span = (end - start) % 360
        if span == 0 or offset < span:
            return index + 1
    return 1


def _aspect_between(
    longitude_a: float,
    longitude_b: float,
    orbs: dict[str, float],
) -> tuple[str, str, float, float] | None:
    diff = abs(longitude_a - longitude_b) % 360
    diff = min(diff, 360 - diff)

    best: tuple[str, str, float, float] | None = None
    for type_en, type_ru, angle, _default_orb, weight in ASPECTS:
        orb = orbs.get(type_en, _default_orb)
        delta = abs(diff - angle)
        if delta > orb:
            continue
        strength = round(weight * (1 - delta / orb), 3)
        if best is None or delta < best[2]:
            best = (type_en, type_ru, round(delta, 2), strength)

    return best


def _aspects(planets: tuple[PlanetPosition, ...]) -> tuple[Aspect, ...]:
    by_key = {planet.key: planet for planet in planets}
    keys = [key for key in ASPECT_PLANETS if key in by_key]
    orbs = {type_en: orb for type_en, _ru, _angle, orb, _w in ASPECTS}

    result: list[Aspect] = []
    for index, key_a in enumerate(keys):
        for key_b in keys[index + 1 :]:
            found = _aspect_between(by_key[key_a].longitude, by_key[key_b].longitude, orbs)
            if found is None:
                continue
            type_en, type_ru, orb, strength = found
            result.append(
                Aspect(a=key_a, b=key_b, type=type_en, orb=orb, strength=strength, type_ru=type_ru)
            )

    # Полный набор ключей сортировки: результат не зависит от порядка вставки.
    result.sort(key=lambda aspect: (-aspect.strength, aspect.orb, aspect.a, aspect.b))
    return tuple(result)


def _balances(planets: tuple[PlanetPosition, ...]) -> Balances:
    elements: dict[str, float] = {"fire": 0.0, "earth": 0.0, "air": 0.0, "water": 0.0}
    modalities: dict[str, float] = {"cardinal": 0.0, "fixed": 0.0, "mutable": 0.0}

    for planet in planets:
        if planet.key not in ASPECT_PLANETS:
            continue
        weight = LUMINARY_WEIGHT if planet.key in ("sun", "moon") else PLANET_WEIGHT
        elements[ELEMENTS[planet.sign]] += weight
        modalities[MODALITIES[planet.sign]] += weight

    total = sum(elements.values()) or 1.0
    return Balances(
        elements={key: round(value * 100 / total, 1) for key, value in elements.items()},
        modalities={key: round(value * 100 / total, 1) for key, value in modalities.items()},
    )


def calcChart(birth: BirthInput, *, engine: str | None = None) -> Chart:
    """Натальная карта по дате, времени и месту рождения.

    `birth.time = None` → планеты считаются на полдень места рождения,
    дома и Асцендент = None (SPEC: «дома и ASC = null»).
    """
    mode = _resolve_mode(engine)
    _configure_ephemeris(mode)

    local_moment = _local_moment(birth)
    jd = _julian_day(local_moment.astimezone(UTC))

    cusps, asc, mc, house_system = (None, None, None, None)
    if birth.time_known:
        cusps, asc, mc, house_system = _houses(jd, birth.place.lat, birth.place.lon)

    planets, omitted = _compute_planets(jd, mode, cusps)

    return Chart(
        birth=birth,
        planets=planets,
        houses=cusps,
        asc=round(asc, 4) if asc is not None else None,
        mc=round(mc, 4) if mc is not None else None,
        aspects=_aspects(planets),
        balances=_balances(planets),
        engine_version=ENGINE_VERSION,
        engine_mode=mode,
        house_system=house_system,
        omitted_planets=omitted,
    )


def transitsFor(on_date: date_type, chart: Chart, *, engine: str | None = None) -> TransitReport:
    """Транзиты на дату: положения планет на 12:00 UTC и их аспекты к натальным.

    Один и тот же день всегда даёт один и тот же отчёт — прогноз кэшируется
    по `(chart_id, date)` (SPEC, «Джобы»).
    """
    mode = _resolve_mode(engine if engine is not None else chart.engine_mode)
    _configure_ephemeris(mode)

    moment = datetime.combine(on_date, time_type(UNKNOWN_TIME_HOUR, 0), tzinfo=UTC)
    jd = _julian_day(moment)

    transit_planets: list[PlanetPosition] = []
    for key, _swe_attr, _name, _glyph in PLANETS:
        if key not in ASPECT_PLANETS:
            continue
        try:
            longitude, speed = _raw_position(jd, _SWE_IDS[key], mode)
        except swe.Error:
            continue
        transit_planets.append(_planet_position(key, longitude, speed, None))

    natal = {planet.key: planet for planet in chart.planets if planet.key in ASPECT_PLANETS}

    aspects: list[TransitAspect] = []
    for transit_planet in transit_planets:
        for natal_key, natal_planet in natal.items():
            found = _aspect_between(transit_planet.longitude, natal_planet.longitude, TRANSIT_ORBS)
            if found is None:
                continue
            type_en, type_ru, orb, strength = found
            aspects.append(
                TransitAspect(
                    transit=transit_planet.key,
                    natal=natal_key,
                    type=type_en,
                    orb=orb,
                    strength=strength,
                    type_ru=type_ru,
                )
            )

    aspects.sort(key=lambda aspect: (-aspect.strength, aspect.orb, aspect.transit, aspect.natal))

    return TransitReport(
        date=on_date,
        positions=tuple(transit_planets),
        aspects=tuple(aspects),
        engine_version=ENGINE_VERSION,
    )


def _format_longitude(longitude: float) -> str:
    lon = longitude % 360
    return f"{degree_of(lon)}°{minute_of(lon):02d}′ {sign_of(lon)}"


def llmContext(chart: Chart) -> dict[str, Any]:
    """Факты для промпта. Модель ничего не считает — только переводит.

    Персональных данных здесь нет: ни имени, ни даты/времени рождения,
    ни места и координат. Только то, что выведено из карты.
    """
    by_key = {planet.key: planet for planet in chart.planets}

    facts: dict[str, Any] = {
        "солнце": by_key["sun"].position_ru if "sun" in by_key else None,
        "луна": by_key["moon"].position_ru if "moon" in by_key else None,
        "асцендент": _format_longitude(chart.asc) if chart.asc is not None else None,
        "mc": _format_longitude(chart.mc) if chart.mc is not None else None,
        "планеты": {planet.name: planet.position_ru_with_retro for planet in chart.planets},
        "сильнейшие_аспекты": [
            f"{_PLANET_NAMES[aspect.a]} — {aspect.type_ru} — {_PLANET_NAMES[aspect.b]} "
            f"(орб {aspect.orb}°)"
            for aspect in chart.aspects[:LLM_TOP_ASPECTS]
        ],
        "стихии": {
            ELEMENT_NAMES_RU[key]: value for key, value in chart.balances.elements.items()
        },
        "кресты": {
            MODALITY_NAMES_RU[key]: value for key, value in chart.balances.modalities.items()
        },
    }

    if chart.houses is not None:
        facts["дома"] = {
            str(index + 1): _format_longitude(cusp) for index, cusp in enumerate(chart.houses)
        }
    else:
        facts["дома"] = None
        facts["примечание"] = "Время рождения неизвестно: дома и Асцендент не рассчитаны."

    return facts


def hashInput(birth: BirthInput, *, engine: str | None = None) -> str:
    """Ключ идемпотентности `POST /charts` (`charts.input_hash`).

    В нормализацию входит всё, что меняет результат: дата, время (или его
    отсутствие), координаты с точностью до 4 знаков (~11 м), часовой пояс,
    режим и версия движка. Название города не входит: «Москва» и «Moscow» —
    одна и та же карта.
    """
    mode = _resolve_mode(engine)
    lat = round(float(birth.place.lat), 4)
    lon = round(float(birth.place.lon), 4)

    payload: dict[str, Any] = {
        "v": 1,
        "engine": mode,
        "engine_version": ENGINE_VERSION,
        "date": birth.date.isoformat(),
        "time": birth.time.strftime("%H:%M") if birth.time is not None else None,
        "tz": birth.place.tz,
        # -0.0 и 0.0 должны давать одинаковый хеш
        "lat": 0.0 if lat == 0 else lat,
        "lon": 0.0 if lon == 0 else lon,
    }

    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return "sha256:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()
