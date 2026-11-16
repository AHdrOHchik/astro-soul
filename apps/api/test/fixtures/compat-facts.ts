/**
 * Ответ сайдкара `POST /synastry` на эталонную карту из `chart-payload.ts`,
 * посчитанный настоящим движком (`packages/astro/astro/synastry.py`), а не
 * написанный руками.
 *
 * Пересобрать:
 *   cd packages/astro && .venv/bin/python -c "import json; from astro.wire import
 *   chart_from_wire; from astro.synastry import compatFacts; ..."
 * (см. `docs/qa/reports/` — там же, где эталон разбора).
 *
 * Обе карты одинаковые: подмена движка в тестах возвращает одну и ту же карту
 * на любой вход. Это даёт 36 кросс-аспектов, полный блок светил и дома —
 * достаточно, чтобы проверить и раскладку фактов, и запрет на ПДн.
 */
export const compatFactsPayload = {
  "version": "1.0",
  "engine_version": "1.0.0",
  "orb_rule": {
    "source": "constants.ASPECTS (орб натальной карты)",
    "base": {
      "conjunction": 8.0,
      "opposition": 7.0,
      "trine": 6.0,
      "square": 6.0,
      "sextile": 4.0
    },
    "luminary_bonus": 2.0,
    "note": "Орб один для всей синастрии; если хотя бы одна планета пары — Солнце или Луна, орб увеличивается на luminary_bonus."
  },
  "cross_aspects": [
    {
      "a": "jupiter",
      "b": "jupiter",
      "a_name": "Юпитер",
      "b_name": "Юпитер",
      "type": "conjunction",
      "type_ru": "соединение",
      "exact_angle": 0.0,
      "aspect_angle": 0.0,
      "orb": 0.0,
      "strength": 1.0,
      "direction": "separating",
      "luminary": false
    },
    {
      "a": "mars",
      "b": "mars",
      "a_name": "Марс",
      "b_name": "Марс",
      "type": "conjunction",
      "type_ru": "соединение",
      "exact_angle": 0.0,
      "aspect_angle": 0.0,
      "orb": 0.0,
      "strength": 1.0,
      "direction": "separating",
      "luminary": false
    },
    {
      "a": "mercury",
      "b": "mercury",
      "a_name": "Меркурий",
      "b_name": "Меркурий",
      "type": "conjunction",
      "type_ru": "соединение",
      "exact_angle": 0.0,
      "aspect_angle": 0.0,
      "orb": 0.0,
      "strength": 1.0,
      "direction": "separating",
      "luminary": false
    },
    {
      "a": "moon",
      "b": "moon",
      "a_name": "Луна",
      "b_name": "Луна",
      "type": "conjunction",
      "type_ru": "соединение",
      "exact_angle": 0.0,
      "aspect_angle": 0.0,
      "orb": 0.0,
      "strength": 1.0,
      "direction": "separating",
      "luminary": true
    },
    {
      "a": "neptune",
      "b": "neptune",
      "a_name": "Нептун",
      "b_name": "Нептун",
      "type": "conjunction",
      "type_ru": "соединение",
      "exact_angle": 0.0,
      "aspect_angle": 0.0,
      "orb": 0.0,
      "strength": 1.0,
      "direction": "separating",
      "luminary": false
    },
    {
      "a": "pluto",
      "b": "pluto",
      "a_name": "Плутон",
      "b_name": "Плутон",
      "type": "conjunction",
      "type_ru": "соединение",
      "exact_angle": 0.0,
      "aspect_angle": 0.0,
      "orb": 0.0,
      "strength": 1.0,
      "direction": "separating",
      "luminary": false
    },
    {
      "a": "saturn",
      "b": "saturn",
      "a_name": "Сатурн",
      "b_name": "Сатурн",
      "type": "conjunction",
      "type_ru": "соединение",
      "exact_angle": 0.0,
      "aspect_angle": 0.0,
      "orb": 0.0,
      "strength": 1.0,
      "direction": "separating",
      "luminary": false
    },
    {
      "a": "sun",
      "b": "sun",
      "a_name": "Солнце",
      "b_name": "Солнце",
      "type": "conjunction",
      "type_ru": "соединение",
      "exact_angle": 0.0,
      "aspect_angle": 0.0,
      "orb": 0.0,
      "strength": 1.0,
      "direction": "separating",
      "luminary": true
    },
    {
      "a": "uranus",
      "b": "uranus",
      "a_name": "Уран",
      "b_name": "Уран",
      "type": "conjunction",
      "type_ru": "соединение",
      "exact_angle": 0.0,
      "aspect_angle": 0.0,
      "orb": 0.0,
      "strength": 1.0,
      "direction": "separating",
      "luminary": false
    },
    {
      "a": "venus",
      "b": "venus",
      "a_name": "Венера",
      "b_name": "Венера",
      "type": "conjunction",
      "type_ru": "соединение",
      "exact_angle": 0.0,
      "aspect_angle": 0.0,
      "orb": 0.0,
      "strength": 1.0,
      "direction": "separating",
      "luminary": false
    },
    {
      "a": "pluto",
      "b": "sun",
      "a_name": "Плутон",
      "b_name": "Солнце",
      "type": "opposition",
      "type_ru": "оппозиция",
      "exact_angle": 179.59,
      "aspect_angle": 180.0,
      "orb": 0.41,
      "strength": 0.859,
      "direction": "applying",
      "luminary": true
    },
    {
      "a": "sun",
      "b": "pluto",
      "a_name": "Солнце",
      "b_name": "Плутон",
      "type": "opposition",
      "type_ru": "оппозиция",
      "exact_angle": 179.59,
      "aspect_angle": 180.0,
      "orb": 0.41,
      "strength": 0.859,
      "direction": "applying",
      "luminary": true
    },
    {
      "a": "sun",
      "b": "uranus",
      "a_name": "Солнце",
      "b_name": "Уран",
      "type": "trine",
      "type_ru": "трин",
      "exact_angle": 120.06,
      "aspect_angle": 120.0,
      "orb": 0.06,
      "strength": 0.794,
      "direction": "separating",
      "luminary": true
    },
    {
      "a": "uranus",
      "b": "sun",
      "a_name": "Уран",
      "b_name": "Солнце",
      "type": "trine",
      "type_ru": "трин",
      "exact_angle": 120.06,
      "aspect_angle": 120.0,
      "orb": 0.06,
      "strength": 0.794,
      "direction": "separating",
      "luminary": true
    },
    {
      "a": "mars",
      "b": "uranus",
      "a_name": "Марс",
      "b_name": "Уран",
      "type": "square",
      "type_ru": "квадрат",
      "exact_angle": 88.86,
      "aspect_angle": 90.0,
      "orb": 1.14,
      "strength": 0.689,
      "direction": "applying",
      "luminary": false
    },
    {
      "a": "uranus",
      "b": "mars",
      "a_name": "Уран",
      "b_name": "Марс",
      "type": "square",
      "type_ru": "квадрат",
      "exact_angle": 88.86,
      "aspect_angle": 90.0,
      "orb": 1.14,
      "strength": 0.689,
      "direction": "applying",
      "luminary": false
    },
    {
      "a": "neptune",
      "b": "uranus",
      "a_name": "Нептун",
      "b_name": "Уран",
      "type": "conjunction",
      "type_ru": "соединение",
      "exact_angle": 3.01,
      "aspect_angle": 0.0,
      "orb": 3.01,
      "strength": 0.624,
      "direction": "applying",
      "luminary": false
    },
    {
      "a": "uranus",
      "b": "neptune",
      "a_name": "Уран",
      "b_name": "Нептун",
      "type": "conjunction",
      "type_ru": "соединение",
      "exact_angle": 3.01,
      "aspect_angle": 0.0,
      "orb": 3.01,
      "strength": 0.624,
      "direction": "applying",
      "luminary": false
    },
    {
      "a": "mars",
      "b": "neptune",
      "a_name": "Марс",
      "b_name": "Нептун",
      "type": "square",
      "type_ru": "квадрат",
      "exact_angle": 91.87,
      "aspect_angle": 90.0,
      "orb": 1.87,
      "strength": 0.585,
      "direction": "separating",
      "luminary": false
    },
    {
      "a": "neptune",
      "b": "mars",
      "a_name": "Нептун",
      "b_name": "Марс",
      "type": "square",
      "type_ru": "квадрат",
      "exact_angle": 91.87,
      "aspect_angle": 90.0,
      "orb": 1.87,
      "strength": 0.585,
      "direction": "separating",
      "luminary": false
    },
    {
      "a": "neptune",
      "b": "sun",
      "a_name": "Нептун",
      "b_name": "Солнце",
      "type": "trine",
      "type_ru": "трин",
      "exact_angle": 123.07,
      "aspect_angle": 120.0,
      "orb": 3.07,
      "strength": 0.493,
      "direction": "separating",
      "luminary": true
    },
    {
      "a": "sun",
      "b": "neptune",
      "a_name": "Солнце",
      "b_name": "Нептун",
      "type": "trine",
      "type_ru": "трин",
      "exact_angle": 123.07,
      "aspect_angle": 120.0,
      "orb": 3.07,
      "strength": 0.493,
      "direction": "separating",
      "luminary": true
    },
    {
      "a": "pluto",
      "b": "uranus",
      "a_name": "Плутон",
      "b_name": "Уран",
      "type": "sextile",
      "type_ru": "секстиль",
      "exact_angle": 59.53,
      "aspect_angle": 60.0,
      "orb": 0.47,
      "strength": 0.441,
      "direction": "applying",
      "luminary": false
    },
    {
      "a": "uranus",
      "b": "pluto",
      "a_name": "Уран",
      "b_name": "Плутон",
      "type": "sextile",
      "type_ru": "секстиль",
      "exact_angle": 59.53,
      "aspect_angle": 60.0,
      "orb": 0.47,
      "strength": 0.441,
      "direction": "applying",
      "luminary": false
    },
    {
      "a": "mars",
      "b": "venus",
      "a_name": "Марс",
      "b_name": "Венера",
      "type": "sextile",
      "type_ru": "секстиль",
      "exact_angle": 60.55,
      "aspect_angle": 60.0,
      "orb": 0.55,
      "strength": 0.432,
      "direction": "separating",
      "luminary": false
    },
    {
      "a": "venus",
      "b": "mars",
      "a_name": "Венера",
      "b_name": "Марс",
      "type": "sextile",
      "type_ru": "секстиль",
      "exact_angle": 60.55,
      "aspect_angle": 60.0,
      "orb": 0.55,
      "strength": 0.432,
      "direction": "separating",
      "luminary": false
    },
    {
      "a": "mercury",
      "b": "saturn",
      "a_name": "Меркурий",
      "b_name": "Сатурн",
      "type": "square",
      "type_ru": "квадрат",
      "exact_angle": 92.99,
      "aspect_angle": 90.0,
      "orb": 2.99,
      "strength": 0.426,
      "direction": "separating",
      "luminary": false
    },
    {
      "a": "saturn",
      "b": "mercury",
      "a_name": "Сатурн",
      "b_name": "Меркурий",
      "type": "square",
      "type_ru": "квадрат",
      "exact_angle": 92.99,
      "aspect_angle": 90.0,
      "orb": 2.99,
      "strength": 0.426,
      "direction": "separating",
      "luminary": false
    },
    {
      "a": "mercury",
      "b": "moon",
      "a_name": "Меркурий",
      "b_name": "Луна",
      "type": "sextile",
      "type_ru": "секстиль",
      "exact_angle": 58.33,
      "aspect_angle": 60.0,
      "orb": 1.67,
      "strength": 0.361,
      "direction": "applying",
      "luminary": true
    },
    {
      "a": "moon",
      "b": "mercury",
      "a_name": "Луна",
      "b_name": "Меркурий",
      "type": "sextile",
      "type_ru": "секстиль",
      "exact_angle": 58.33,
      "aspect_angle": 60.0,
      "orb": 1.67,
      "strength": 0.361,
      "direction": "applying",
      "luminary": true
    },
    {
      "a": "jupiter",
      "b": "moon",
      "a_name": "Юпитер",
      "b_name": "Луна",
      "type": "square",
      "type_ru": "квадрат",
      "exact_angle": 85.04,
      "aspect_angle": 90.0,
      "orb": 4.96,
      "strength": 0.323,
      "direction": "separating",
      "luminary": true
    },
    {
      "a": "moon",
      "b": "jupiter",
      "a_name": "Луна",
      "b_name": "Юпитер",
      "type": "square",
      "type_ru": "квадрат",
      "exact_angle": 85.04,
      "aspect_angle": 90.0,
      "orb": 4.96,
      "strength": 0.323,
      "direction": "separating",
      "luminary": true
    },
    {
      "a": "jupiter",
      "b": "saturn",
      "a_name": "Юпитер",
      "b_name": "Сатурн",
      "type": "trine",
      "type_ru": "трин",
      "exact_angle": 123.63,
      "aspect_angle": 120.0,
      "orb": 3.63,
      "strength": 0.316,
      "direction": "separating",
      "luminary": false
    },
    {
      "a": "saturn",
      "b": "jupiter",
      "a_name": "Сатурн",
      "b_name": "Юпитер",
      "type": "trine",
      "type_ru": "трин",
      "exact_angle": 123.63,
      "aspect_angle": 120.0,
      "orb": 3.63,
      "strength": 0.316,
      "direction": "separating",
      "luminary": false
    },
    {
      "a": "neptune",
      "b": "pluto",
      "a_name": "Нептун",
      "b_name": "Плутон",
      "type": "sextile",
      "type_ru": "секстиль",
      "exact_angle": 56.52,
      "aspect_angle": 60.0,
      "orb": 3.48,
      "strength": 0.065,
      "direction": "applying",
      "luminary": false
    },
    {
      "a": "pluto",
      "b": "neptune",
      "a_name": "Плутон",
      "b_name": "Нептун",
      "type": "sextile",
      "type_ru": "секстиль",
      "exact_angle": 56.52,
      "aspect_angle": 60.0,
      "orb": 3.48,
      "strength": 0.065,
      "direction": "applying",
      "luminary": false
    }
  ],
  "luminaries": [
    {
      "pair": "sun-moon",
      "present": false,
      "type": null,
      "orb": null,
      "a": "sun",
      "b": "moon"
    },
    {
      "pair": "moon-moon",
      "present": true,
      "type": "conjunction",
      "orb": 0.0,
      "a": "moon",
      "b": "moon"
    },
    {
      "pair": "venus-mars",
      "present": true,
      "type": "sextile",
      "orb": 0.55,
      "a": "venus",
      "b": "mars"
    },
    {
      "pair": "sun-sun",
      "present": true,
      "type": "conjunction",
      "orb": 0.0,
      "a": "sun",
      "b": "sun"
    }
  ],
  "balances": {
    "a": {
      "elements": {
        "air": 16.7,
        "earth": 33.3,
        "fire": 25.0,
        "water": 25.0
      },
      "modalities": {
        "cardinal": 25.0,
        "fixed": 50.0,
        "mutable": 25.0
      }
    },
    "b": {
      "elements": {
        "air": 16.7,
        "earth": 33.3,
        "fire": 25.0,
        "water": 25.0
      },
      "modalities": {
        "cardinal": 25.0,
        "fixed": 50.0,
        "mutable": 25.0
      }
    },
    "delta": {
      "elements": {
        "air": 0.0,
        "earth": 0.0,
        "fire": 0.0,
        "water": 0.0
      },
      "modalities": {
        "cardinal": 0.0,
        "fixed": 0.0,
        "mutable": 0.0
      }
    }
  },
  "house_overlays": {
    "a_in_b": [
      {
        "planet": "sun",
        "planet_name": "Солнце",
        "house": 9
      },
      {
        "planet": "moon",
        "planet_name": "Луна",
        "house": 11
      },
      {
        "planet": "mercury",
        "planet_name": "Меркурий",
        "house": 10
      },
      {
        "planet": "venus",
        "planet_name": "Венера",
        "house": 10
      },
      {
        "planet": "mars",
        "planet_name": "Марс",
        "house": 8
      },
      {
        "planet": "jupiter",
        "planet_name": "Юпитер",
        "house": 3
      },
      {
        "planet": "saturn",
        "planet_name": "Сатурн",
        "house": 6
      },
      {
        "planet": "uranus",
        "planet_name": "Уран",
        "house": 5
      },
      {
        "planet": "neptune",
        "planet_name": "Нептун",
        "house": 5
      },
      {
        "planet": "pluto",
        "planet_name": "Плутон",
        "house": 3
      }
    ],
    "b_in_a": [
      {
        "planet": "sun",
        "planet_name": "Солнце",
        "house": 9
      },
      {
        "planet": "moon",
        "planet_name": "Луна",
        "house": 11
      },
      {
        "planet": "mercury",
        "planet_name": "Меркурий",
        "house": 10
      },
      {
        "planet": "venus",
        "planet_name": "Венера",
        "house": 10
      },
      {
        "planet": "mars",
        "planet_name": "Марс",
        "house": 8
      },
      {
        "planet": "jupiter",
        "planet_name": "Юпитер",
        "house": 3
      },
      {
        "planet": "saturn",
        "planet_name": "Сатурн",
        "house": 6
      },
      {
        "planet": "uranus",
        "planet_name": "Уран",
        "house": 5
      },
      {
        "planet": "neptune",
        "planet_name": "Нептун",
        "house": 5
      },
      {
        "planet": "pluto",
        "planet_name": "Плутон",
        "house": 3
      }
    ]
  }
} as const;
