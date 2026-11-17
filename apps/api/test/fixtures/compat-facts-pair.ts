/**
 * Та же форма ответа `POST /synastry`, но посчитанная для **другой пары**:
 * 1994-05-17 14:20 и 1990-03-02 08:15, Москва (обе карты с известным
 * временем). Нужна там, где одной пары «сама с собой» мало: у одинаковых карт
 * разница балансов нулевая, поэтому семейства «баланс» и часть светил в тексте
 * не появляются.
 *
 * Пересобрать: `packages/astro`, `compatFacts(calcChart(a), calcChart(b))`
 * (см. комментарий к `compatFactsPayload`).
 */
export const compatFactsPairPayload = {
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
      "a": "saturn",
      "b": "sun",
      "a_name": "Сатурн",
      "b_name": "Солнце",
      "type": "conjunction",
      "type_ru": "соединение",
      "exact_angle": 0.05,
      "aspect_angle": 0.0,
      "orb": 0.05,
      "strength": 0.995,
      "direction": "separating",
      "luminary": true
    },
    {
      "a": "neptune",
      "b": "mars",
      "a_name": "Нептун",
      "b_name": "Марс",
      "type": "conjunction",
      "type_ru": "соединение",
      "exact_angle": 0.19,
      "aspect_angle": 0.0,
      "orb": 0.19,
      "strength": 0.976,
      "direction": "applying",
      "luminary": false
    },
    {
      "a": "neptune",
      "b": "saturn",
      "a_name": "Нептун",
      "b_name": "Сатурн",
      "type": "conjunction",
      "type_ru": "соединение",
      "exact_angle": 0.99,
      "aspect_angle": 0.0,
      "orb": 0.99,
      "strength": 0.876,
      "direction": "applying",
      "luminary": false
    },
    {
      "a": "pluto",
      "b": "mercury",
      "a_name": "Плутон",
      "b_name": "Меркурий",
      "type": "square",
      "type_ru": "квадрат",
      "exact_angle": 90.78,
      "aspect_angle": 90.0,
      "orb": 0.78,
      "strength": 0.74,
      "direction": "separating",
      "luminary": false
    },
    {
      "a": "sun",
      "b": "mercury",
      "a_name": "Солнце",
      "b_name": "Меркурий",
      "type": "square",
      "type_ru": "квадрат",
      "exact_angle": 88.81,
      "aspect_angle": 90.0,
      "orb": 1.19,
      "strength": 0.724,
      "direction": "separating",
      "luminary": true
    },
    {
      "a": "uranus",
      "b": "venus",
      "a_name": "Уран",
      "b_name": "Венера",
      "type": "conjunction",
      "type_ru": "соединение",
      "exact_angle": 2.75,
      "aspect_angle": 0.0,
      "orb": 2.75,
      "strength": 0.657,
      "direction": "separating",
      "luminary": false
    },
    {
      "a": "uranus",
      "b": "mars",
      "a_name": "Уран",
      "b_name": "Марс",
      "type": "conjunction",
      "type_ru": "соединение",
      "exact_angle": 3.2,
      "aspect_angle": 0.0,
      "orb": 3.2,
      "strength": 0.6,
      "direction": "applying",
      "luminary": false
    },
    {
      "a": "mars",
      "b": "mars",
      "a_name": "Марс",
      "b_name": "Марс",
      "type": "square",
      "type_ru": "квадрат",
      "exact_angle": 92.06,
      "aspect_angle": 90.0,
      "orb": 2.06,
      "strength": 0.558,
      "direction": "separating",
      "luminary": false
    },
    {
      "a": "venus",
      "b": "mercury",
      "a_name": "Венера",
      "b_name": "Меркурий",
      "type": "trine",
      "type_ru": "трин",
      "exact_angle": 118.16,
      "aspect_angle": 120.0,
      "orb": 1.84,
      "strength": 0.554,
      "direction": "separating",
      "luminary": false
    },
    {
      "a": "mercury",
      "b": "sun",
      "a_name": "Меркурий",
      "b_name": "Солнце",
      "type": "square",
      "type_ru": "квадрат",
      "exact_angle": 92.94,
      "aspect_angle": 90.0,
      "orb": 2.94,
      "strength": 0.537,
      "direction": "separating",
      "luminary": true
    },
    {
      "a": "sun",
      "b": "venus",
      "a_name": "Солнце",
      "b_name": "Венера",
      "type": "trine",
      "type_ru": "трин",
      "exact_angle": 117.31,
      "aspect_angle": 120.0,
      "orb": 2.69,
      "strength": 0.531,
      "direction": "applying",
      "luminary": true
    },
    {
      "a": "uranus",
      "b": "saturn",
      "a_name": "Уран",
      "b_name": "Сатурн",
      "type": "conjunction",
      "type_ru": "соединение",
      "exact_angle": 4.0,
      "aspect_angle": 0.0,
      "orb": 4.0,
      "strength": 0.5,
      "direction": "applying",
      "luminary": false
    },
    {
      "a": "sun",
      "b": "mars",
      "a_name": "Солнце",
      "b_name": "Марс",
      "type": "trine",
      "type_ru": "трин",
      "exact_angle": 123.26,
      "aspect_angle": 120.0,
      "orb": 3.26,
      "strength": 0.474,
      "direction": "separating",
      "luminary": true
    },
    {
      "a": "mars",
      "b": "saturn",
      "a_name": "Марс",
      "b_name": "Сатурн",
      "type": "square",
      "type_ru": "квадрат",
      "exact_angle": 92.86,
      "aspect_angle": 90.0,
      "orb": 2.86,
      "strength": 0.444,
      "direction": "separating",
      "luminary": false
    },
    {
      "a": "jupiter",
      "b": "sun",
      "a_name": "Юпитер",
      "b_name": "Солнце",
      "type": "trine",
      "type_ru": "трин",
      "exact_angle": 123.69,
      "aspect_angle": 120.0,
      "orb": 3.69,
      "strength": 0.431,
      "direction": "separating",
      "luminary": true
    },
    {
      "a": "moon",
      "b": "moon",
      "a_name": "Луна",
      "b_name": "Луна",
      "type": "square",
      "type_ru": "квадрат",
      "exact_angle": 86.0,
      "aspect_angle": 90.0,
      "orb": 4.0,
      "strength": 0.425,
      "direction": "separating",
      "luminary": true
    },
    {
      "a": "sun",
      "b": "saturn",
      "a_name": "Солнце",
      "b_name": "Сатурн",
      "type": "trine",
      "type_ru": "трин",
      "exact_angle": 124.06,
      "aspect_angle": 120.0,
      "orb": 4.06,
      "strength": 0.394,
      "direction": "separating",
      "luminary": true
    },
    {
      "a": "jupiter",
      "b": "uranus",
      "a_name": "Юпитер",
      "b_name": "Уран",
      "type": "sextile",
      "type_ru": "секстиль",
      "exact_angle": 61.14,
      "aspect_angle": 60.0,
      "orb": 1.14,
      "strength": 0.357,
      "direction": "separating",
      "luminary": false
    },
    {
      "a": "venus",
      "b": "jupiter",
      "a_name": "Венера",
      "b_name": "Юпитер",
      "type": "conjunction",
      "type_ru": "соединение",
      "exact_angle": 5.22,
      "aspect_angle": 0.0,
      "orb": 5.22,
      "strength": 0.348,
      "direction": "applying",
      "luminary": false
    },
    {
      "a": "moon",
      "b": "pluto",
      "a_name": "Луна",
      "b_name": "Плутон",
      "type": "square",
      "type_ru": "квадрат",
      "exact_angle": 95.12,
      "aspect_angle": 90.0,
      "orb": 5.12,
      "strength": 0.306,
      "direction": "applying",
      "luminary": true
    },
    {
      "a": "mars",
      "b": "venus",
      "a_name": "Марс",
      "b_name": "Венера",
      "type": "square",
      "type_ru": "квадрат",
      "exact_angle": 86.12,
      "aspect_angle": 90.0,
      "orb": 3.88,
      "strength": 0.3,
      "direction": "applying",
      "luminary": false
    },
    {
      "a": "neptune",
      "b": "venus",
      "a_name": "Нептун",
      "b_name": "Венера",
      "type": "conjunction",
      "type_ru": "соединение",
      "exact_angle": 5.76,
      "aspect_angle": 0.0,
      "orb": 5.76,
      "strength": 0.281,
      "direction": "separating",
      "luminary": false
    },
    {
      "a": "pluto",
      "b": "venus",
      "a_name": "Плутон",
      "b_name": "Венера",
      "type": "sextile",
      "type_ru": "секстиль",
      "exact_angle": 62.27,
      "aspect_angle": 60.0,
      "orb": 2.27,
      "strength": 0.216,
      "direction": "separating",
      "luminary": false
    },
    {
      "a": "mars",
      "b": "mercury",
      "a_name": "Марс",
      "b_name": "Меркурий",
      "type": "sextile",
      "type_ru": "секстиль",
      "exact_angle": 57.61,
      "aspect_angle": 60.0,
      "orb": 2.39,
      "strength": 0.201,
      "direction": "separating",
      "luminary": false
    },
    {
      "a": "saturn",
      "b": "uranus",
      "a_name": "Сатурн",
      "b_name": "Уран",
      "type": "sextile",
      "type_ru": "секстиль",
      "exact_angle": 62.49,
      "aspect_angle": 60.0,
      "orb": 2.49,
      "strength": 0.189,
      "direction": "separating",
      "luminary": false
    },
    {
      "a": "saturn",
      "b": "neptune",
      "a_name": "Сатурн",
      "b_name": "Нептун",
      "type": "sextile",
      "type_ru": "секстиль",
      "exact_angle": 57.29,
      "aspect_angle": 60.0,
      "orb": 2.71,
      "strength": 0.162,
      "direction": "applying",
      "luminary": false
    },
    {
      "a": "neptune",
      "b": "moon",
      "a_name": "Нептун",
      "b_name": "Луна",
      "type": "trine",
      "type_ru": "трин",
      "exact_angle": 113.41,
      "aspect_angle": 120.0,
      "orb": 6.59,
      "strength": 0.141,
      "direction": "applying",
      "luminary": true
    },
    {
      "a": "saturn",
      "b": "moon",
      "a_name": "Сатурн",
      "b_name": "Луна",
      "type": "sextile",
      "type_ru": "секстиль",
      "exact_angle": 65.32,
      "aspect_angle": 60.0,
      "orb": 5.32,
      "strength": 0.056,
      "direction": "separating",
      "luminary": true
    },
    {
      "a": "sun",
      "b": "pluto",
      "a_name": "Солнце",
      "b_name": "Плутон",
      "type": "opposition",
      "type_ru": "оппозиция",
      "exact_angle": 171.46,
      "aspect_angle": 180.0,
      "orb": 8.54,
      "strength": 0.046,
      "direction": "separating",
      "luminary": true
    },
    {
      "a": "pluto",
      "b": "mars",
      "a_name": "Плутон",
      "b_name": "Марс",
      "type": "sextile",
      "type_ru": "секстиль",
      "exact_angle": 56.33,
      "aspect_angle": 60.0,
      "orb": 3.67,
      "strength": 0.041,
      "direction": "applying",
      "luminary": false
    },
    {
      "a": "sun",
      "b": "moon",
      "a_name": "Солнце",
      "b_name": "Луна",
      "type": "conjunction",
      "type_ru": "соединение",
      "exact_angle": 9.66,
      "aspect_angle": 0.0,
      "orb": 9.66,
      "strength": 0.034,
      "direction": "applying",
      "luminary": true
    },
    {
      "a": "jupiter",
      "b": "moon",
      "a_name": "Юпитер",
      "b_name": "Луна",
      "type": "opposition",
      "type_ru": "оппозиция",
      "exact_angle": 171.04,
      "aspect_angle": 180.0,
      "orb": 8.96,
      "strength": 0.004,
      "direction": "separating",
      "luminary": true
    }
  ],
  "luminaries": [
    {
      "pair": "sun-moon",
      "present": true,
      "type": "conjunction",
      "orb": 9.66,
      "a": "sun",
      "b": "moon"
    },
    {
      "pair": "moon-moon",
      "present": true,
      "type": "square",
      "orb": 4.0,
      "a": "moon",
      "b": "moon"
    },
    {
      "pair": "venus-mars",
      "present": true,
      "type": "square",
      "orb": 3.88,
      "a": "mars",
      "b": "venus"
    },
    {
      "pair": "sun-sun",
      "present": false,
      "type": null,
      "orb": null,
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
        "air": 8.3,
        "earth": 58.3,
        "fire": 0.0,
        "water": 33.3
      },
      "modalities": {
        "cardinal": 50.0,
        "fixed": 33.3,
        "mutable": 16.7
      }
    },
    "delta": {
      "elements": {
        "air": -8.4,
        "earth": 25.0,
        "fire": -25.0,
        "water": 8.3
      },
      "modalities": {
        "cardinal": 25.0,
        "fixed": -16.7,
        "mutable": -8.3
      }
    }
  },
  "house_overlays": {
    "a_in_b": [
      {
        "planet": "sun",
        "planet_name": "Солнце",
        "house": 1
      },
      {
        "planet": "moon",
        "planet_name": "Луна",
        "house": 5
      },
      {
        "planet": "mercury",
        "planet_name": "Меркурий",
        "house": 2
      },
      {
        "planet": "venus",
        "planet_name": "Венера",
        "house": 3
      },
      {
        "planet": "mars",
        "planet_name": "Марс",
        "house": 1
      },
      {
        "planet": "jupiter",
        "planet_name": "Юпитер",
        "house": 7
      },
      {
        "planet": "saturn",
        "planet_name": "Сатурн",
        "house": 12
      },
      {
        "planet": "uranus",
        "planet_name": "Уран",
        "house": 11
      },
      {
        "planet": "neptune",
        "planet_name": "Нептун",
        "house": 11
      },
      {
        "planet": "pluto",
        "planet_name": "Плутон",
        "house": 7
      }
    ],
    "b_in_a": [
      {
        "planet": "sun",
        "planet_name": "Солнце",
        "house": 6
      },
      {
        "planet": "moon",
        "planet_name": "Луна",
        "house": 9
      },
      {
        "planet": "mercury",
        "planet_name": "Меркурий",
        "house": 6
      },
      {
        "planet": "venus",
        "planet_name": "Венера",
        "house": 5
      },
      {
        "planet": "mars",
        "planet_name": "Марс",
        "house": 5
      },
      {
        "planet": "jupiter",
        "planet_name": "Юпитер",
        "house": 10
      },
      {
        "planet": "saturn",
        "planet_name": "Сатурн",
        "house": 5
      },
      {
        "planet": "uranus",
        "planet_name": "Уран",
        "house": 4
      },
      {
        "planet": "neptune",
        "planet_name": "Нептун",
        "house": 4
      },
      {
        "planet": "pluto",
        "planet_name": "Плутон",
        "house": 3
      }
    ]
  }
} as const;
