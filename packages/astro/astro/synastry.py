"""Синастрия: детерминированные факты совместимости двух карт.

Задача этого модуля — **посчитать**, а не объяснить. Модель получает готовые
углы и аспекты (`compatibility_facts` v1.0) и пишет по ним текст, как в разборе
(`llmContext`): если факт не посчитан здесь, его не существует.

Правила, без которых результат «плывёт»:

*   **Орб один и тот же, что у натальной карты** (`constants.ASPECTS`):
    соединение 8°, оппозиция 7°, трин 6°, квадрат 6°, секстиль 4°. Второго
    набора правил не заводим: иначе «аспект есть» в карте и «аспекта нет» в
    совместимости — это один и тот же угол, посчитанный двумя способами.
*   **Светилам — послабление +2°.** Правило одно и описано здесь: если хотя бы
    одна планета пары — Солнце или Луна, орб увеличивается на
    `LUMINARY_ORB_BONUS`. Так «Луна в 7° от трина» остаётся значимой, а
    Плутон в 7° от трина — уже нет.
*   **Хирон не считается.** В fallback-режиме его нет в карте (Swiss Ephemeris
    без коммерческой лицензии), и «иногда считаем, иногда нет» — хуже, чем
    «не считаем».
*   **Оверлеи домов — только когда время рождения известно у обеих карт.**
    Иначе блока нет целиком: дома без времени не определены, а «примерно»
    здесь означает выдумку.
*   Детерминизм: одинаковая пара карт → побайтово одинаковый JSON. Порядок
    списков фиксирован, все числа округлены до фиксированного знака.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Final

from .constants import ASPECTS, ELEMENT_NAMES_RU, MODALITY_NAMES_RU, PLANETS
from .engine import houseOf
from .types import Chart

#: Версия формы `compatibility_facts`. Меняется вместе с контрактом.
COMPATIBILITY_FACTS_VERSION: Final[str] = "1.0"

#: Послабление орба для пар со светилом (Солнце или Луна), градусы.
LUMINARY_ORB_BONUS: Final[float] = 2.0

#: Пары, на которых держится «акцент на светилах»: (ключ, планета A, планета B).
LUMINARY_PAIRS: Final[tuple[tuple[str, str, str], ...]] = (
    ("sun-moon", "sun", "moon"),
    ("moon-moon", "moon", "moon"),
    ("venus-mars", "venus", "mars"),
    ("sun-sun", "sun", "sun"),
)

#: Планеты синастрии: все аспектные, кроме Хирона и узла (узел — не планета).
SYNASTRY_PLANETS: Final[tuple[str, ...]] = tuple(
    key for key, _pid, _ru, _glyph in PLANETS if key not in ("chiron", "node")
)

#: Светила: на них действует послабление орба.
LUMINARIES: Final[frozenset[str]] = frozenset({"sun", "moon"})

_PLANET_NAMES: Final[dict[str, str]] = {key: name for key, _pid, name, _glyph in PLANETS}
_ASPECT_RU: Final[dict[str, str]] = {
    type_en: type_ru for type_en, type_ru, _angle, _orb, _weight in ASPECTS
}
_ASPECT_ANGLES: Final[dict[str, int]] = {
    type_en: angle for type_en, _ru, angle, _orb, _weight in ASPECTS
}


@dataclass(frozen=True, slots=True)
class CrossAspect:
    """Кросс-аспект между планетой A и планетой B."""

    a: str
    b: str
    type: str
    exact_angle: float
    orb: float
    strength: float
    direction: str
    luminary: bool

    def to_dict(self) -> dict[str, Any]:
        return {
            "a": self.a,
            "b": self.b,
            "a_name": _PLANET_NAMES[self.a],
            "b_name": _PLANET_NAMES[self.b],
            "type": self.type,
            "type_ru": _ASPECT_RU[self.type],
            # Точный угол между планетами (0…180°) и угол аспекта — разные
            # числа: «трин с орбом 1,6°» означает 118,4° между планетами.
            "exact_angle": self.exact_angle,
            "aspect_angle": float(_ASPECT_ANGLES[self.type]),
            "orb": self.orb,
            "strength": self.strength,
            "direction": self.direction,
            "luminary": self.luminary,
        }


def _orb_of(type_en: str, luminary: bool) -> float:
    """Орб аспекта: базовый из натального движка плюс послабление светилам."""
    base = next(orb for key, _ru, _angle, orb, _weight in ASPECTS if key == type_en)
    return base + (LUMINARY_ORB_BONUS if luminary else 0.0)


def separation(longitude_a: float, longitude_b: float) -> float:
    """Угол между планетами: 0…180°, без знака. Округление — до 2 знаков."""
    diff = abs(longitude_a - longitude_b) % 360
    return round(min(diff, 360 - diff), 4)


def _direction(
    longitude_a: float,
    speed_a: float,
    longitude_b: float,
    speed_b: float,
    angle: int,
) -> str:
    """`applying` — орб сокращается, `separating` — растёт.

    Считаем производную разноски: относительная скорость `speed_a - speed_b`,
    знак разноски — от `a` к `b`. Точный аспект (`orb = 0`) считается
    `separating`: «сейчас ровно» — это не «идёт к точности».
    """
    diff = (longitude_a - longitude_b + 180.0) % 360.0 - 180.0
    delta = abs(diff) - angle
    rate = (speed_a - speed_b) * (1.0 if diff >= 0 else -1.0)
    if delta == 0 or rate == 0:
        return "separating"
    return "applying" if delta * rate < 0 else "separating"


def _aspect_between(
    key_a: str,
    longitude_a: float,
    speed_a: float,
    key_b: str,
    longitude_b: float,
    speed_b: float,
) -> CrossAspect | None:
    """Сильнейший аспект пары: минимальная разница до точного угла.

    Если пара попадает сразу в два аспекта (такого не бывает при этих орбах,
    но правило нужно зафиксировать), побеждает меньший `orb`, при равенстве —
    порядок `ASPECTS` (соединение первым).
    """
    found: CrossAspect | None = None
    exact = separation(longitude_a, longitude_b)
    luminary = key_a in LUMINARIES or key_b in LUMINARIES

    for type_en, _type_ru, angle, _default_orb, weight in ASPECTS:
        orb_limit = _orb_of(type_en, luminary)
        delta = abs(exact - angle)
        if delta > orb_limit:
            continue
        candidate = CrossAspect(
            a=key_a,
            b=key_b,
            type=type_en,
            exact_angle=round(exact, 2),
            orb=round(delta, 2),
            strength=round(weight * (1 - delta / orb_limit), 3),
            direction=_direction(longitude_a, speed_a, longitude_b, speed_b, angle),
            luminary=luminary,
        )
        if found is None or candidate.orb < found.orb:
            found = candidate

    return found


def cross_aspects(chart_a: Chart, chart_b: Chart) -> tuple[CrossAspect, ...]:
    """Все кросс-аспекты между планетами двух карт (без Хирона и узла)."""
    by_a = {planet.key: planet for planet in chart_a.planets}
    by_b = {planet.key: planet for planet in chart_b.planets}

    result: list[CrossAspect] = []
    for key_a in SYNASTRY_PLANETS:
        planet_a = by_a.get(key_a)
        if planet_a is None:
            continue
        for key_b in SYNASTRY_PLANETS:
            planet_b = by_b.get(key_b)
            if planet_b is None:
                continue
            aspect = _aspect_between(
                key_a,
                planet_a.longitude,
                planet_a.speed,
                key_b,
                planet_b.longitude,
                planet_b.speed,
            )
            if aspect is not None:
                result.append(aspect)

    # Полный набор ключей сортировки: результат не зависит от порядка обхода.
    result.sort(key=lambda item: (-item.strength, item.orb, item.a, item.b))
    return tuple(result)


def _luminaries(aspects: tuple[CrossAspect, ...]) -> list[dict[str, Any]]:
    """Акцент на светилах: есть/нет и тип для четырёх названных пар.

    Пара «Солнце–Луна» направленная: `a.sun × b.moon` и `a.moon × b.sun` —
    разные факты; берём сильнейший из двух и называем, чей это угол.
    """
    blocks: list[dict[str, Any]] = []

    for pair, planet_a, planet_b in LUMINARY_PAIRS:
        candidates = [
            aspect
            for aspect in aspects
            if aspect.a == planet_a and aspect.b == planet_b
        ] or [
            # Обратное направление интересно только для пар из двух разных
            # планет: «Луна–Луна» и «Солнце–Солнце» зеркальны сами себе.
            aspect
            for aspect in aspects
            if planet_a != planet_b and aspect.a == planet_b and aspect.b == planet_a
        ]

        best = min(
            candidates,
            key=lambda item: (-item.strength, item.orb, item.a, item.b),
            default=None,
        )
        blocks.append(
            {
                "pair": pair,
                "present": best is not None,
                "type": best.type if best is not None else None,
                "orb": best.orb if best is not None else None,
                "a": best.a if best is not None else planet_a,
                "b": best.b if best is not None else planet_b,
            }
        )

    return blocks


def _delta(a: dict[str, float], b: dict[str, float]) -> dict[str, float]:
    """Дельта в процентных пунктах: B минус A, округление до 1 знака."""
    return {key: round(b.get(key, 0.0) - a.get(key, 0.0), 1) for key in sorted(a)}


def _balances(chart_a: Chart, chart_b: Chart) -> dict[str, Any]:
    """Стихии и кресты двух карт и их дельта в процентных пунктах.

    Ключи — машинные (`fire`, `cardinal`), а не русские подписи: это данные, а
    не текст. Русские названия подставляет клиент (`compat-facts.ts`) и
    `llmContext` ниже; иначе перевод строки внутри JSON пришлось бы
    разбирать обратно при любом сравнении и в тестах, и в метриках.
    """
    elements_a = {key: round(value, 1) for key, value in chart_a.balances.elements.items()}
    elements_b = {key: round(value, 1) for key, value in chart_b.balances.elements.items()}
    modalities_a = {key: round(value, 1) for key, value in chart_a.balances.modalities.items()}
    modalities_b = {key: round(value, 1) for key, value in chart_b.balances.modalities.items()}

    return {
        "a": {
            "elements": {key: elements_a[key] for key in sorted(elements_a)},
            "modalities": {key: modalities_a[key] for key in sorted(modalities_a)},
        },
        "b": {
            "elements": {key: elements_b[key] for key in sorted(elements_b)},
            "modalities": {key: modalities_b[key] for key in sorted(modalities_b)},
        },
        "delta": {
            "elements": _delta(elements_a, elements_b),
            "modalities": _delta(modalities_a, modalities_b),
        },
    }


def _overlays(one: Chart, other: Chart) -> list[dict[str, Any]] | None:
    """Планеты одной карты в домах другой. `None` — домов нет хотя бы у одной."""
    if one.houses is None or other.houses is None:
        return None

    cusps = tuple(other.houses)
    result: list[dict[str, Any]] = []
    for key in SYNASTRY_PLANETS:
        planet = next((item for item in one.planets if item.key == key), None)
        if planet is None:
            continue
        result.append(
            {
                "planet": key,
                "planet_name": _PLANET_NAMES[key],
                "house": houseOf(planet.longitude, cusps),
            }
        )
    return result


def _house_overlays(chart_a: Chart, chart_b: Chart) -> dict[str, Any] | None:
    """Блок оверлеев домов целиком — или ничего.

    Обе карты обязаны быть с известным временем рождения: дома без времени не
    определены, и «примерный» оверлей читался бы как факт.
    """
    if chart_a.houses is None or chart_b.houses is None:
        return None

    a_in_b = _overlays(chart_a, chart_b)
    b_in_a = _overlays(chart_b, chart_a)
    if a_in_b is None or b_in_a is None:
        return None

    return {"a_in_b": a_in_b, "b_in_a": b_in_a}


def _orb_rule() -> dict[str, Any]:
    return {
        "source": "constants.ASPECTS (орб натальной карты)",
        "base": {
            type_en: orb for type_en, _ru, _angle, orb, _weight in ASPECTS
        },
        "luminary_bonus": LUMINARY_ORB_BONUS,
        "note": (
            "Орб один для всей синастрии; если хотя бы одна планета пары — "
            "Солнце или Луна, орб увеличивается на luminary_bonus."
        ),
    }


def compatFacts(chart_a: Chart, chart_b: Chart) -> dict[str, Any]:
    """`compatibility_facts` v1.0: кросс-аспекты, светила, балансы, оверлеи.

    Один и тот же вход → одинаковый словарь: ключи отсортированы, числа
    округлены, списки упорядочены явными ключами.

    Персональных данных здесь нет: ни даты, ни времени, ни места рождения —
    только то, что выведено из двух карт.
    """
    aspects = cross_aspects(chart_a, chart_b)

    facts: dict[str, Any] = {
        "version": COMPATIBILITY_FACTS_VERSION,
        "engine_version": chart_a.engine_version,
        "orb_rule": _orb_rule(),
        "cross_aspects": [aspect.to_dict() for aspect in aspects],
        "luminaries": _luminaries(aspects),
        "balances": _balances(chart_a, chart_b),
    }

    overlays = _house_overlays(chart_a, chart_b)
    if overlays is not None:
        facts["house_overlays"] = overlays

    return facts


def llmContext(facts: dict[str, Any]) -> dict[str, Any]:
    """Факты для промпта: русские подписи и только значимые углы.

    Модель не считает и не выбирает: сильнейшие кросс-аспекты приходят
    готовым списком (`LLM_TOP_ASPECTS`), остальные — в приложении, если
    понадобится. Персональных данных нет вовсе.
    """
    aspects = facts.get("cross_aspects", [])
    top = aspects[:LLM_TOP_ASPECTS]

    balances = facts["balances"]
    context: dict[str, Any] = {
        "сильнейшие_кросс_аспекты": [
            f"{aspect['a_name']} — {aspect['type_ru']} — {aspect['b_name']} "
            f"(орб {aspect['orb']}°, {aspect['direction']})"
            for aspect in top
        ],
        "светила": {
            block["pair"]: (
                f"{block['type']} (орб {block['orb']}°)" if block["present"] else "нет"
            )
            for block in facts["luminaries"]
        },
        # Русские подписи только здесь: это текст для модели, а не данные.
        "стихии": {
            "партнёр_минус_ты": {
                ELEMENT_NAMES_RU[key]: value
                for key, value in balances["delta"]["elements"].items()
            },
        },
        "кресты": {
            "партнёр_минус_ты": {
                MODALITY_NAMES_RU[key]: value
                for key, value in balances["delta"]["modalities"].items()
            },
        },
        "стихии_ты": {
            ELEMENT_NAMES_RU[key]: value for key, value in balances["a"]["elements"].items()
        },
        "стихии_партнёр": {
            ELEMENT_NAMES_RU[key]: value for key, value in balances["b"]["elements"].items()
        },
        "кресты_ты": {
            MODALITY_NAMES_RU[key]: value for key, value in balances["a"]["modalities"].items()
        },
        "кресты_партнёр": {
            MODALITY_NAMES_RU[key]: value for key, value in balances["b"]["modalities"].items()
        },
    }

    overlays = facts.get("house_overlays")
    if overlays is None:
        context["дома"] = None
        context["примечание"] = (
            "Дома не рассчитаны: время рождения известно не у обеих карт. "
            "Не упоминай дома вообще."
        )
    else:
        context["дома"] = {
            "твои_планеты_в_домах_партнёра": {
                item["planet_name"]: item["house"] for item in overlays["a_in_b"]
            },
            "планеты_партнёра_в_твоих_домах": {
                item["planet_name"]: item["house"] for item in overlays["b_in_a"]
            },
        }

    return context


#: Сколько сильнейших кросс-аспектов попадает в контекст для LLM.
LLM_TOP_ASPECTS: Final[int] = 8
