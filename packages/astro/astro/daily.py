"""Факты дня для прогноза (итерация 30, `POST /forecast/facts`).

Главное правило: **детерминированные факты считает Python, модель только
пишет текст**. Здесь нет ни одного случайного числа, ни одного обращения к
сети и ни одной зависимости от текущего времени процесса: вход — дата, часовой
пояс и сохранённая карта, выход — один и тот же JSON побайтово.

Что считается:

* Луна на **полдень** местного дня (`date` + `timezone` + 12:00): знак, градус,
  фаза (название + доля освещённости);
* ретроградность планет на этот момент;
* транзиты транзитных планет к натальным Солнцу/Луне/Асценденту/МС и к
  управителю дня, орб ≤ 3°, не больше восьми, по убыванию силы;
* «управитель дня» — по дню недели (правило школы зафиксировано в
  `docs/report/geo.md`: воскресенье — Солнце, понедельник — Луна, вторник —
  Марс, среда — Меркурий, четверг — Юпитер, пятница — Венера, суббота — Сатурн);
* `windows` — 2–3 интервала времени суток из транзитов Луны: часы, когда Луна
  в аспекте к натальным Венере/Юпитеру (легче) или к Сатурну/Марсу
  (осторожнее). Считается по шагам в 3 часа, без модели.

Часовой пояс — место рождения, а не текущее местоположение. Это ограничение
написано и в описании маршрута, и в `timezone_note` ответа: оно не техническое,
а смысловое — «сегодня» у человека начинается там, где он родился.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from datetime import date as date_type
from datetime import time as time_type
from math import cos, radians
from typing import Any, Final
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from .constants import ASPECT_PLANETS, DEFAULT_ENGINE_MODE, ENGINE_VERSION, PLANETS, TRANSIT_ORBS
from .engine import (
    _SWE_IDS,
    _aspect_between,
    _configure_ephemeris,
    _julian_day,
    _raw_position,
    _resolve_mode,
)
from .types import Chart, degree_of, minute_of, sign_of

#: Полдень — момент, на который считаются факты дня.
NOON_HOUR: Final[int] = 12

#: Орб транзитов для прогноза дня: строже, чем в отчёте, — день короткий.
DAY_TRANSIT_ORB_MAX: Final[float] = 3.0

#: Сколько транзитов отдаём модели: восемь сильнейших.
DAY_TRANSITS_MAX: Final[int] = 8

#: Шаг, с которым считаются окна времени суток, часы.
WINDOW_STEP_HOURS: Final[int] = 2

#: Максимальная длина одного окна: длинный ровный отрезок режется на части,
#: иначе «два-три интервала» превращаются в «весь день одним куском».
WINDOW_MAX_HOURS: Final[int] = 6

#: Сколько окон отдаём: два-три, не больше.
WINDOWS_MAX: Final[int] = 3

#: Планеты, аспекты Луны к которым считаются «легче» и «осторожнее».
EASE_TARGETS: Final[tuple[str, ...]] = ("venus", "jupiter")
CARE_TARGETS: Final[tuple[str, ...]] = ("saturn", "mars")

#: Дательный падеж для подписи окна: «к Венере», «к Сатурну».
DATIVE: Final[dict[str, str]] = {
    "venus": "Венере",
    "jupiter": "Юпитеру",
    "saturn": "Сатурну",
    "mars": "Марсу",
}

#: Управитель дня по дню недели (понедельник = 0). Правило школы — в geo.md.
DAY_RULERS: Final[tuple[str, ...]] = (
    "moon",  # понедельник
    "mars",  # вторник
    "mercury",  # среда
    "jupiter",  # четверг
    "venus",  # пятница
    "saturn",  # суббота
    "sun",  # воскресенье
)

PLANET_NAMES: Final[dict[str, str]] = {key: name for key, _pid, name, _glyph in PLANETS}

#: Восемь фаз Луны по углу «Луна − Солнце». Порядок — часть детерминизма.
PHASES: Final[tuple[tuple[float, str], ...]] = (
    (22.5, "новолуние"),
    (67.5, "растущий серп"),
    (112.5, "первая четверть"),
    (157.5, "растущая Луна"),
    (202.5, "полнолуние"),
    (247.5, "убывающая Луна"),
    (292.5, "последняя четверть"),
    (337.5, "убывающий серп"),
    (360.0, "новолуние"),
)

TIMEZONE_NOTE: Final[str] = (
    "Часовой пояс места рождения, а не текущего местоположения: «сегодня» "
    "начинается там, где человек родился."
)


class ForecastConfigError(ValueError):
    """Неизвестный часовой пояс или пустая карта."""


def phase_of(angle: float) -> tuple[str, float]:
    """Название фазы и доля освещённости по углу «Луна − Солнце».

    Освещённость — `(1 − cos(угол)) / 2`, то есть 0 в новолуние и 1 в
    полнолуние. Формула, а не таблица: таблица разъехалась бы с астрономией.
    """
    normalized = angle % 360
    for limit, name in PHASES:
        if normalized < limit:
            return name, round((1 - _cos_deg(normalized)) / 2, 4)
    return PHASES[-1][1], 0.0


def _cos_deg(degrees: float) -> float:
    return cos(radians(degrees))


def ruler_of_day(on_date: date_type) -> dict[str, Any]:
    """Управитель дня: планета по дню недели.

    Воскресенье — Солнце, понедельник — Луна, вторник — Марс, среда —
    Меркурий, четверг — Юпитер, пятница — Венера, суббота — Сатурн.
    Правило зафиксировано в `docs/report/geo.md`, чтобы его не искали в коде.
    """
    key = DAY_RULERS[on_date.weekday()]
    return {
        "key": key,
        "name": PLANET_NAMES[key],
        "weekday": on_date.weekday(),
    }


def _noon_utc(on_date: date_type, timezone: str) -> datetime:
    try:
        tzinfo = ZoneInfo(timezone)
    except (ZoneInfoNotFoundError, ValueError) as error:
        raise ForecastConfigError(f"неизвестный часовой пояс: {timezone!r}") from error

    return datetime.combine(on_date, time_type(NOON_HOUR, 0), tzinfo=tzinfo).astimezone(UTC)


def _positions_at(moment: datetime, mode: Any) -> dict[str, tuple[float, float]]:
    """Долгота и скорость всех аспектных планет на момент (UTC)."""
    jd = _julian_day(moment)
    result: dict[str, tuple[float, float]] = {}
    for key in ASPECT_PLANETS:
        try:
            result[key] = _raw_position(jd, _SWE_IDS[key], mode)
        except Exception:  # noqa: BLE001 — Moshier не знает Хирона: планета пропускается
            continue
    return result


def _natal_points(chart: Chart, ruler_key: str) -> dict[str, float]:
    """Натальные точки, к которым ищем транзиты.

    Светила, углы карты (если время рождения известно) и управитель дня.
    Ключи — как в карте: `sun`, `moon`, `asc`, `mc`, `venus`…
    """
    points: dict[str, float] = {}
    for planet in chart.planets:
        if planet.key in ("sun", "moon"):
            points[planet.key] = planet.longitude
    if chart.asc is not None:
        points["asc"] = float(chart.asc)
    if chart.mc is not None:
        points["mc"] = float(chart.mc)
    for planet in chart.planets:
        if planet.key == ruler_key:
            points[ruler_key] = planet.longitude
    return points


def _day_transits(
    transit_positions: dict[str, tuple[float, float]],
    points: dict[str, float],
) -> list[dict[str, Any]]:
    aspects: list[dict[str, Any]] = []
    for transit_key in ASPECT_PLANETS:
        if transit_key not in transit_positions:
            continue
        longitude = transit_positions[transit_key][0]
        for natal_key in points:
            found = _aspect_between(longitude, points[natal_key], TRANSIT_ORBS)
            if found is None:
                continue
            type_en, type_ru, orb, strength = found
            if orb > DAY_TRANSIT_ORB_MAX:
                continue
            aspects.append(
                {
                    "transit": transit_key,
                    "transit_name": PLANET_NAMES[transit_key],
                    "natal": natal_key,
                    "natal_name": _natal_name(natal_key),
                    "type": type_en,
                    "type_ru": type_ru,
                    "orb": orb,
                    "strength": strength,
                }
            )

    aspects.sort(key=lambda item: (-item["strength"], item["orb"], item["transit"], item["natal"]))
    return aspects[:DAY_TRANSITS_MAX]


def _natal_name(key: str) -> str:
    if key == "asc":
        return "Асцендент"
    if key == "mc":
        return "МС"
    return PLANET_NAMES.get(key, key)


def _window_kind(
    transit_positions: dict[str, tuple[float, float]],
    points: dict[str, float],
) -> tuple[str, str] | None:
    """Класс окна на момент: `ease` (Луна к Венере/Юпитеру) или `care`."""
    moon = transit_positions.get("moon")
    if moon is None:
        return None

    for target in EASE_TARGETS:
        if target not in points:
            continue
        found = _aspect_between(moon[0], points[target], TRANSIT_ORBS)
        if found is not None and found[2] <= DAY_TRANSIT_ORB_MAX:
            return "ease", f"легче: транзит Луны к {DATIVE[target]}"

    for target in CARE_TARGETS:
        if target not in points:
            continue
        found = _aspect_between(moon[0], points[target], TRANSIT_ORBS)
        if found is not None and found[2] <= DAY_TRANSIT_ORB_MAX:
            return "care", f"осторожнее: транзит Луны к {DATIVE[target]}"

    return None


def _part_of_day(hour: int) -> str:
    if 5 <= hour < 11:
        return "утро"
    if 11 <= hour < 17:
        return "день"
    if 17 <= hour < 23:
        return "вечер"
    return "ночь"


def _windows(
    on_date: date_type,
    timezone: str,
    points: dict[str, float],
    mode: Any,
) -> list[dict[str, Any]]:
    """2–3 интервала времени суток из транзитов Луны.

    День режется на шаги по `WINDOW_STEP_HOURS`; на каждом шаге смотрим, в каком
    аспекте Луна к натальным Венере/Юпитеру (легче) или Сатурну/Марсу
    (осторожнее). Соседние шаги одного класса сливаются в интервал, но не
    длиннее `WINDOW_MAX_HOURS` — иначе ровный день стал бы одним окном.

    Если значимых интервалов меньше двух, добираем ровные и подписываем их
    частью суток: «ровный фон: утро». Это честнее выдуманного «легче в 15:00»:
    фон действительно ровный, и модель не должна сочинять окно.
    """
    tzinfo = ZoneInfo(timezone)
    slots: list[tuple[int, str, str]] = []

    hour = 0
    while hour < 24:
        moment = datetime.combine(on_date, time_type(hour, 0), tzinfo=tzinfo).astimezone(UTC)
        positions = _positions_at(moment, mode)
        kind = _window_kind(positions, points)
        if kind is None:
            slots.append((hour, "neutral", f"ровный фон: {_part_of_day(hour)}"))
        else:
            slots.append((hour, kind[0], kind[1]))
        hour += WINDOW_STEP_HOURS

    windows: list[dict[str, Any]] = []
    for hour, kind, label in slots:
        start_at = datetime.combine(on_date, time_type(hour, 0), tzinfo=tzinfo)
        current = windows[-1] if windows else None
        length = 0.0 if current is None else (start_at - current["_start"]).total_seconds() / 3600

        if current is not None and current["kind"] == kind and length < WINDOW_MAX_HOURS:
            current["to"] = (start_at + timedelta(hours=WINDOW_STEP_HOURS)).isoformat()
            continue

        windows.append(
            {
                "kind": kind,
                "label": label,
                "from": start_at.isoformat(),
                "to": (start_at + timedelta(hours=WINDOW_STEP_HOURS)).isoformat(),
                "_start": start_at,
            }
        )

    marked = [window for window in windows if window["kind"] != "neutral"]
    if len(marked) < 2:
        neutral = sorted(
            (window for window in windows if window["kind"] == "neutral"),
            key=lambda window: (-_hours_of(window), window["from"]),
        )[: 2 - len(marked)]
        marked = sorted(marked + neutral, key=lambda window: window["from"])

    for window in marked:
        window.pop("_start", None)

    return marked[:WINDOWS_MAX]


def _hours_of(window: dict[str, Any]) -> float:
    start = datetime.fromisoformat(window["from"])
    end = datetime.fromisoformat(window["to"])
    return (end - start).total_seconds() / 3600


def moon_facts(on_date: date_type, timezone: str) -> dict[str, Any]:
    """Луна на полдень дня: знак, градус, фаза, освещённость — без карты.

    Зачем отдельный путь (итерация 37). Карточку «фаза Луны» получает и человек
    без профиля: у него нет ни карты, ни подписки, а натальные данные для
    транзитов нужны только для персональных строк. Считать их ради знака Луны
    значило бы гонять тяжёлый расчёт (транзиты, окна, управитель) впустую и
    требовать от человека данные, которых мы не собираемся показывать.

    Что здесь есть: только положения Солнца и Луны на тот же момент, что и у
    `day_facts` — полдень местного дня. Поэтому знак и фаза совпадают с
    `POST /forecast/facts` на ту же дату и пояс: это проверяется тестом.

    Чего здесь нет намеренно: транзитов, окон, ретро-списка и управителя дня —
    всё это требует натальной карты.
    """
    mode = _resolve_mode(DEFAULT_ENGINE_MODE)
    _configure_ephemeris(mode)

    noon = _noon_utc(on_date, timezone)
    positions = _positions_at(noon, mode)

    if "moon" not in positions or "sun" not in positions:
        raise ForecastConfigError("движок не отдал положения Солнца и Луны")

    moon_longitude = positions["moon"][0] % 360
    sun_longitude = positions["sun"][0] % 360
    phase_name, illumination = phase_of(moon_longitude - sun_longitude)

    return {
        "date": on_date.isoformat(),
        "timezone": timezone,
        "engine_version": ENGINE_VERSION,
        "noon_utc": noon.isoformat().replace("+00:00", "Z"),
        "moon": {
            "sign": sign_of(moon_longitude),
            "degree": degree_of(moon_longitude),
            "minute": minute_of(moon_longitude),
            "phase": phase_name,
            "illumination": illumination,
            "retrograde": positions["moon"][1] < 0,
        },
    }


def day_facts(on_date: date_type, timezone: str, chart: Chart) -> dict[str, Any]:
    """Факты дня: Луна, ретро, транзиты, управитель дня и окна времени."""
    mode = _resolve_mode(chart.engine_mode)
    _configure_ephemeris(mode)

    noon = _noon_utc(on_date, timezone)
    positions = _positions_at(noon, mode)

    if "moon" not in positions or "sun" not in positions:
        raise ForecastConfigError("движок не отдал положения Солнца и Луны")

    moon_longitude = positions["moon"][0] % 360
    sun_longitude = positions["sun"][0] % 360
    phase_name, illumination = phase_of(moon_longitude - sun_longitude)

    ruler = ruler_of_day(on_date)
    points = _natal_points(chart, ruler["key"])

    retrograde = [
        {"key": key, "name": PLANET_NAMES[key]}
        for key in ASPECT_PLANETS
        if key in positions and positions[key][1] < 0
    ]

    return {
        "date": on_date.isoformat(),
        "timezone": timezone,
        "timezone_note": TIMEZONE_NOTE,
        "engine_version": ENGINE_VERSION,
        "noon_utc": noon.isoformat().replace("+00:00", "Z"),
        "moon": {
            "sign": sign_of(moon_longitude),
            "degree": degree_of(moon_longitude),
            "minute": minute_of(moon_longitude),
            "phase": phase_name,
            "illumination": illumination,
            "retrograde": positions["moon"][1] < 0,
        },
        "retrograde": retrograde,
        "ruler": ruler,
        "transits": _day_transits(positions, points),
        "windows": _windows(on_date, timezone, points, mode),
    }
