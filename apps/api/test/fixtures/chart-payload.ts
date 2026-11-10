/**
 * Эталонная карта из настоящего движка (`packages/astro`), а не выдуманные числа.
 * Пересобрать: `python -m astro.service` + POST /chart, либо `python -c` из README движка.
 * Дата и место в фикстуре — публичный тестовый пример, не данные пользователя.
 */
export const engineChartPayload = {
  "chart": {
    "birth": {
      "date": "1994-05-17",
      "time": "14:20",
      "time_known": true,
      "place": {
        "name": "Москва",
        "region": null,
        "country": "RU",
        "lat": 55.7558,
        "lon": 37.6173,
        "tz": "Europe/Moscow"
      }
    },
    "asc": {
      "sign": "Дева",
      "degree": 15,
      "minute": 3
    },
    "mc": {
      "sign": "Близнецы",
      "degree": 9,
      "minute": 12
    },
    "planets": [
      {
        "key": "sun",
        "name": "Солнце",
        "sign": "Телец",
        "degree": 26,
        "minute": 17,
        "house": 9,
        "retrograde": false
      },
      {
        "key": "moon",
        "name": "Луна",
        "sign": "Лев",
        "degree": 12,
        "minute": 38,
        "house": 11,
        "retrograde": false
      },
      {
        "key": "mercury",
        "name": "Меркурий",
        "sign": "Близнецы",
        "degree": 14,
        "minute": 18,
        "house": 10,
        "retrograde": false
      },
      {
        "key": "venus",
        "name": "Венера",
        "sign": "Близнецы",
        "degree": 25,
        "minute": 38,
        "house": 10,
        "retrograde": false
      },
      {
        "key": "mars",
        "name": "Марс",
        "sign": "Овен",
        "degree": 25,
        "minute": 6,
        "house": 8,
        "retrograde": false
      },
      {
        "key": "jupiter",
        "name": "Юпитер",
        "sign": "Скорпион",
        "degree": 7,
        "minute": 41,
        "house": 3,
        "retrograde": true
      },
      {
        "key": "saturn",
        "name": "Сатурн",
        "sign": "Рыбы",
        "degree": 11,
        "minute": 19,
        "house": 6,
        "retrograde": false
      },
      {
        "key": "uranus",
        "name": "Уран",
        "sign": "Козерог",
        "degree": 26,
        "minute": 14,
        "house": 5,
        "retrograde": true
      },
      {
        "key": "neptune",
        "name": "Нептун",
        "sign": "Козерог",
        "degree": 23,
        "minute": 13,
        "house": 5,
        "retrograde": true
      },
      {
        "key": "pluto",
        "name": "Плутон",
        "sign": "Скорпион",
        "degree": 26,
        "minute": 42,
        "house": 3,
        "retrograde": true
      },
      {
        "key": "node",
        "name": "Узел",
        "sign": "Скорпион",
        "degree": 23,
        "minute": 47,
        "house": 3,
        "retrograde": true
      }
    ],
    "houses": [
      {
        "house": 1,
        "sign": "Дева",
        "degree": 15
      },
      {
        "house": 2,
        "sign": "Весы",
        "degree": 5
      },
      {
        "house": 3,
        "sign": "Скорпион",
        "degree": 3
      },
      {
        "house": 4,
        "sign": "Стрелец",
        "degree": 9
      },
      {
        "house": 5,
        "sign": "Козерог",
        "degree": 18
      },
      {
        "house": 6,
        "sign": "Водолей",
        "degree": 20
      },
      {
        "house": 7,
        "sign": "Рыбы",
        "degree": 15
      },
      {
        "house": 8,
        "sign": "Овен",
        "degree": 5
      },
      {
        "house": 9,
        "sign": "Телец",
        "degree": 3
      },
      {
        "house": 10,
        "sign": "Близнецы",
        "degree": 9
      },
      {
        "house": 11,
        "sign": "Рак",
        "degree": 18
      },
      {
        "house": 12,
        "sign": "Лев",
        "degree": 20
      }
    ],
    "aspects": [
      {
        "a": "sun",
        "b": "pluto",
        "type": "opposition",
        "orb": 0.41,
        "strength": 0.847
      },
      {
        "a": "sun",
        "b": "uranus",
        "type": "trine",
        "orb": 0.06,
        "strength": 0.792
      },
      {
        "a": "mars",
        "b": "uranus",
        "type": "square",
        "orb": 1.14,
        "strength": 0.689
      },
      {
        "a": "uranus",
        "b": "neptune",
        "type": "conjunction",
        "orb": 3.01,
        "strength": 0.624
      },
      {
        "a": "mars",
        "b": "neptune",
        "type": "square",
        "orb": 1.87,
        "strength": 0.585
      },
      {
        "a": "uranus",
        "b": "pluto",
        "type": "sextile",
        "orb": 0.47,
        "strength": 0.441
      },
      {
        "a": "venus",
        "b": "mars",
        "type": "sextile",
        "orb": 0.55,
        "strength": 0.432
      },
      {
        "a": "mercury",
        "b": "saturn",
        "type": "square",
        "orb": 2.99,
        "strength": 0.426
      },
      {
        "a": "sun",
        "b": "neptune",
        "type": "trine",
        "orb": 3.07,
        "strength": 0.391
      },
      {
        "a": "jupiter",
        "b": "saturn",
        "type": "trine",
        "orb": 3.63,
        "strength": 0.316
      },
      {
        "a": "moon",
        "b": "mercury",
        "type": "sextile",
        "orb": 1.67,
        "strength": 0.291
      },
      {
        "a": "moon",
        "b": "jupiter",
        "type": "square",
        "orb": 4.96,
        "strength": 0.148
      },
      {
        "a": "neptune",
        "b": "pluto",
        "type": "sextile",
        "orb": 3.48,
        "strength": 0.065
      }
    ],
    "balances": {
      "elements": {
        "fire": 25.0,
        "earth": 33.3,
        "air": 16.7,
        "water": 25.0
      },
      "modalities": {
        "cardinal": 25.0,
        "fixed": 50.0,
        "mutable": 25.0
      }
    },
    "engine_version": "1.0.0",
    "omitted_planets": [
      "chiron"
    ]
  },
  "internal": {
    "planets": [
      {
        "key": "sun",
        "longitude": 56.2907,
        "speed": 0.9636
      },
      {
        "key": "moon",
        "longitude": 132.635,
        "speed": 13.1382
      },
      {
        "key": "mercury",
        "longitude": 74.3055,
        "speed": 1.7155
      },
      {
        "key": "venus",
        "longitude": 85.6378,
        "speed": 1.2035
      },
      {
        "key": "mars",
        "longitude": 25.0923,
        "speed": 0.7564
      },
      {
        "key": "jupiter",
        "longitude": 217.678,
        "speed": -0.1154
      },
      {
        "key": "saturn",
        "longitude": 341.3114,
        "speed": 0.058
      },
      {
        "key": "uranus",
        "longitude": 296.2315,
        "speed": -0.0134
      },
      {
        "key": "neptune",
        "longitude": 293.2217,
        "speed": -0.0115
      },
      {
        "key": "pluto",
        "longitude": 236.7051,
        "speed": -0.0278
      },
      {
        "key": "node",
        "longitude": 233.7877,
        "speed": -0.0059
      }
    ],
    "houses": [
      165.0427,
      185.7423,
      213.3293,
      249.1984,
      288.2611,
      320.2537,
      345.0427,
      5.7423,
      33.3293,
      69.1984,
      108.2611,
      140.2537
    ],
    "asc": 165.0427,
    "mc": 69.1984,
    "engine_mode": "fallback",
    "house_system": "placidus"
  },
  "input_hash": "sha256:28a1e6d504b723cd64dedc7071c1f90f907834659a3fac0b76acb7e36b6a5f3b",
  "omitted_planets": [
    "chiron"
  ]
} as const;
