# packages/astro — астро-движок

Python-пакет на `pyswisseph`. Считает натальную карту, транзиты, SVG-колесо и
компактный контекст для LLM. Сеть не используется: эфемериды локальные.

Пакет вырос из прототипа `astro/engine.py`, который удалён из дерева,
чтобы никто не запустил не тот движок; история файла остаётся в git.
Вывод приведён к контракту `api.openapi.yaml`.

## Установка

```bash
cd packages/astro
python3 -m pip install -e '.[dev]'   # или: pnpm setup:astro из корня
python3 -m pytest                    # или: pnpm test:astro
python3 -m ruff check .              # или: pnpm lint:astro
```

Python ≥ 3.11. Единственная runtime-зависимость — `pyswisseph==2.10.3.2`.

## Публичный API

Имена — как в SPEC и в задаче (camelCase, исключение из PEP 8 — см. `ruff` N802).

| Функция | Что возвращает |
|---|---|
| `calcChart(birth, engine=None)` | `Chart`: планеты, дома Плацидуса, аспекты, балансы |
| `transitsFor(date, chart, engine=None)` | `TransitReport`: положения на 12:00 UTC и аспекты к натальным |
| `llmContext(chart)` | `dict` фактов на русском — только то, что уходит в промпт |
| `renderWheel(chart, size=560)` | строка SVG |
| `hashInput(birth, engine=None)` | `sha256:...` для `charts.input_hash` |

```python
from datetime import date, time
from astro import BirthInput, GeoPlace, calcChart, hashInput, llmContext, renderWheel

place = GeoPlace(name="Тестоград", country="RU", lat=55.7558, lon=37.6173, tz="Europe/Moscow")
chart = calcChart(BirthInput(date=date(1994, 5, 17), time=time(14, 20), place=place))

chart.to_dict()            # поля контракта Chart (без chart_id и created_at)
hashInput(chart.birth)     # ключ идемпотентности POST /charts
renderWheel(chart)         # SVG
llmContext(chart)          # факты для промпта
```

CLI для QA:

```bash
python -m astro.cli chart --date 1994-05-17 --time 14:20 --lat 55.7558 \
    --lon 37.6173 --tz Europe/Moscow --name Тестоград
python -m astro.cli context  ...      # факты для LLM
python -m astro.cli wheel    ... --out chart.svg
python -m astro.cli transits ... --transit-date 2026-11-11
python -m astro.cli hash     ...
```

## Режимы и лицензия

`ASTRO_ENGINE`:

* `fallback` (по умолчанию) — встроенная эфемерида Moshier (`swe.FLG_MOSEPH`),
  файлы `.se1` не нужны и не читаются;
* `swisseph` — файлы Swiss Ephemeris из `SE_EPHE_PATH` (`swe.FLG_SWIEPH`).

**Хирон в fallback-режиме не считается**: он требует файла
`seas_18.se1` из Swiss Ephemeris (в Moshier его нет). Планета честно
отсутствует в карте (`Chart.omitted_planets`), а не подменяется нулём.
Пока файла нет, в разборе не будет Хирона — это продуктовое ограничение,
о котором нужно помнить.

`pyswisseph` распространяется под AGPL-3.0. Режим `fallback` снимает
зависимость от файлов эфемерид, но не от самой библиотеки: до покупки
коммерческой лицензии Swiss Ephemeris сервис не должен распространяться
как бинарник/контейнер наружу. Решение по лицензии — за владельцем продукта.

## Детерминизм и границы

* Один и тот же вход → побайтно одинаковый JSON: долготы округлены до 4 знаков,
  порядок планет фиксирован, аспекты отсортированы по `(-strength, orb, a, b)`.
* `time = None` → время рождения неизвестно: планеты считаются на **полдень**
  места рождения, `houses`, `asc`, `mc` = `null` (SPEC: «дома и ASC = null»).
* За полярным кругом Плацидус не определён: используется равнодомная система
  (`Chart.house_system = "equal"`), в контракт это поле не отдаётся.
* `hashInput` учитывает дату, время (или его отсутствие), координаты с точностью
  до 4 знаков, часовой пояс, режим и версию движка. Название города не входит:
  «Москва» и «Moscow» — одна карта.
* Аспекты в контракте ссылаются на планеты **ключами** (`sun`, `moon`, ...),
  а `llmContext` — русскими названиями, как их прочитает модель.
* `balances` — проценты (сумма ≈ 100, округление до 0.1).
* В SVG не попадает ничего персонального: ни имя, ни дата/время рождения, ни
  город. Колесо уходит в шаринг (`/charts/{id}/wheel.svg`), поэтому подпись в
  центре нейтральная.

## Связь с API (следующая итерация)

`apps/api` написан на NestJS, движок — Python. Планируемый транспорт — локальный
сервис (`ASTRO_SERVICE_URL`) с двумя вызовами: `POST /chart`, `POST /transits`;
эфемериды при этом остаются локальными. Решение по транспорту принимается
вместе с `POST /charts`.
