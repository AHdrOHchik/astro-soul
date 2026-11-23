# Итерация 37 — три карточки сторис (контракт 1.6.12)

Контракт **1.6.11 → 1.6.12**, аддитивно: `ShareCardKind` получил `identity` и
`moon`, у `POST /share/card` появилось необязательное `tz`, в
`x-analytics-events` добавлено `share_saved`, `share_sent.kind` расширен,
`share_card_created` получил `template_version`, в `/admin/metrics` —
`share_cards_created_24h`. Ни одно существующее поле не изменено, `required`
нигде не тронут.

Прогон (sandbox): Postgres 5433 (`astro_soul_test`), API 59 файлов / 719 тестов,
web 49 / 900, astro 107 (pytest), `pnpm build` — зелёный.
Сборка: **21.9 s wall, 38.0 s CPU** (user 35.99 + sys 1.94), web
**127.8 kB gzip** из бюджета 350 kB, 160 модулей.

---

## 1. Что сделано

### Задача 0 — общий шаблон сторис

`packages/astro/astro/cards.py`: `STORIES_KINDS = ('day', 'identity', 'moon')`,
`SAFE_TOP = 250`, `SAFE_BOTTOM = 1670`, `TEMPLATE_VERSION = "stories-1"`,
`TextBlock`, `StoriesLayout`, `storiesLayout()`, `_drawStories()`; `renderCard` /
`renderCardPng` принимают `brand_name`, `brand_hint`, `disclaimer`, `prompt`.

| Элемент | Где | Размер |
|---|---|---|
| имя продукта | верх безопасной зоны | 34 px bold |
| подсказка для поиска | низ безопасной зоны | 25 px |
| дисклеймер (тот же текст, что у прогноза) | низ безопасной зоны | 25 px |
| подвал со ссылкой `t.me/…` | низ безопасной зоны | 26 px |
| приглашение `identity` | низ безопасной зоны | 30 px bold |
| заголовок | верх полосы | 5.8 % высоты, bold |
| строки | центр | 38 → 22 px с сокращением |

Имя продукта — `BRAND_NAME` (≤ 60 символов), подсказка — `BRAND_SEARCH_HINT`
(≤ 80, по умолчанию «ищи в Telegram: `<BRAND_NAME>`»). Пустой `BRAND_NAME` —
`503 brand_name_missing`; значение по умолчанию не подставляется.

Кэш: колонка `share_cards.template_version`, ключ
`(kind, content_hash, template_version)`, `template_version` в событии
`share_card_created`.

### Задача 1 — `day`

`day` переехал на шаблон (безопасные зоны, имя продукта, подсказка, дисклеймер,
крупная фаза, дата, «сегодня хорошо для…»). Доступ не изменился: нужна карта,
подписка не нужна.

### Задача 2 — `identity`

Три фразы из главы «Ядро» оплаченного разбора + приглашение. Отбор
`identityPhrases()`: 40–120 символов, обязательно второе лицо (без учёта
регистра), без терминов, процентов и родовых форм; порядок — как в разборе.
Модель не вызывается. `403 report_not_paid` без разбора, `422
not_enough_identity_lines` при менее трёх фраз.

### Задача 3 — `moon`

Знак, фаза, освещённость, дата + «чего сегодня лучше не начинать» из
`MOON_ADVICE` (8 фаз + нейтральный запасной). Карта и подписка не нужны,
авторизация нужна. Новый лёгкий путь сайдкара `POST /moon/facts` (без
натальных транзитов). `tz` в теле `POST /share/card`, неизвестный пояс —
`422 share_tz_unknown`.

### Задача 4 — метрики и события

`share_cards_created_24h` по видам (все пять ключей всегда); `share_card_created`
+ `template_version`; `share_sent.kind` — пять значений; новое клиентское
`share_saved {kind, target}` (`gallery | telegram_story`).

### Задача 5 — контракт и inline

`INLINE_KINDS` (`share.repository.ts`) — inline отдаёт все пять видов по
`sh_<short_id>`; неподдерживаемый вид — пустой ответ + `share_inline_unsupported_kind`
в логе.

---

## 2. Тесты

| Что | Файл | Тестов | Что доказывает |
|---|---|---|---|
| шаблон сторис (Python) | `packages/astro/tests/test_cards.py` | 36 | безопасные зоны по видам, обязательные роли `brand`/`disclaimer`/`hint`, пиксельная проверка «вне `250…1670` ни один пиксель не отличается от фона», детерминизм PNG, `ValueError` для `wheel`, `TEMPLATE_VERSION == "stories-1"`, `/card/build` для `identity`/`moon` → 1080×1920, `/moon/facts` (200/422) и совпадение `moon` + `noon_utc` с `/forecast/facts` |
| карточки-сторис (API) | `apps/api/test/share-cards-stories.spec.ts` | 22 | см. ниже |
| список событий | `apps/api/test/events.spec.ts` | 39 событий | контракт и код не разъезжаются |
| карточки (API, существовал) | `apps/api/test/share-cards.spec.ts` | — | прежние гарантии; ожидание `props` дополнено `template_version` |

`share-cards-stories.spec.ts` по пунктам:

1. `day`/`identity`/`moon` несут имя продукта, подсказку, дисклеймер и подвал;
   `wheel`/`insight` — нет (старая вёрстка).
2. Размеры: три карточки 1080×1920, `insight` — 1080×1080.
3. Пустой `BRAND_NAME` → `503 brand_name_missing`, строк в `share_cards` нет.
4. `templateVersionOf`: сторис → `stories-1`, `wheel`/`insight` → `classic-1`;
   константа `TEMPLATE_VERSION` читается из Python-файла и совпадает.
5. `INLINE_KINDS` — все пять видов.
6. `identity`: три фразы, длина 40–120, второе лицо, без терминов/процентов/
   родовых форм; приманки отброшены; `prompt` = приглашение.
7. `identity` детерминизм: два запроса — одна строка, один рендер, тот же файл;
   строки совпадают с `identityPhrases()`.
8. `identity` без оплаты → `403 report_not_paid`, рендера нет.
9. `identity` с двумя подходящими фразами → `422 not_enough_identity_lines`.
10. Чужой разбор не уходит в карточку (`403`).
11. `moon` без карты и подписки → `200`; в БД нет ни `charts`, ни
    `subscriptions`.
12. `moon` совпадает с `/moon/facts` эталонного движка: заголовок
    (`Луна в <предложный>`), строка фазы, освещённость, дата.
13. `tz` учитывается: дата — по поясу, а не по UTC сервера.
14. Неизвестный `tz` → `422 share_tz_unknown`, `field_errors[0].field == "tz"`.
15. Анонимно нельзя: без initData — `401`.
16. Кэш версионирован: строка `legacy-0` не отдаётся, строится `stories-1`;
    третий запрос — `cached: true`.
17. ПДн: в том, что ушло в рендерер, и в байтах файла нет ни даты, ни времени,
    ни места рождения, ни координат — для трёх видов.
18. `share_sent kind:"identity"`/`"moon"` → `202`; `"compat"` → `422`.
19. `share_saved` без `target` → `422`; с `target` → `202`, лишние ключи
    вырезаны.
20. `/admin/metrics`: `share_cards_created_24h` = `{day, wheel, insight,
    identity, moon}` с нулями.

Сборка карточек на этом CPU (три прогона, среднее — в скобках):

| Вид | Байт | мс |
|---|---|---|
| `day` | 69 498 | 148 (160) |
| `identity` | 92 409 | 183 (197) |
| `moon` | 68 192 | 152 (157) |

Было в итерации 32 (`day`): 48 131 Б / 147 мс — вырос размер (имя продукта,
дисклеймер, подсказка), время практически не изменилось.

---

## 3. Контракт (1.6.12, аддитивно)

- `ShareCardKind`: `enum [day, wheel, insight, identity, moon]`; описание
  разбито на «сторис» и «старую вёрстку».
- `POST /share/card`: необязательное `tz` (описано, для каких видов
  применяется); `403` — `report_not_paid` теперь и для `identity`;
  `422` — три причины; `503` — `brand_name_missing` и `astro_unavailable`.
- `x-analytics-events` += `share_saved` (39 событий); `x-event-strict-props`:
  `share_sent.kind` — пять значений, `share_saved` — `{kind, target}`.
- `x-analytics-server-events`: `share_card_created` + `template_version`.
- `/admin/metrics`: `share_cards_created_24h` (object, integer по видам).
- `gen:contracts:check` и `gen:api:check` — без расхождений.

---

## 4. Миграция

`migrations/0032_share_cards_template_version.sql` (единственная):

- `share_cards.template_version text not null default 'classic-1'` +
  бэкфилл: `day` → `legacy-0` (старая вёрстка), остальные — `classic-1`;
- `CHECK` на `kind` пересоздан: `day, wheel, insight, identity, moon`;
- уникальный индекс `(kind, content_hash)` заменён на
  `share_cards_content_version_idx (kind, content_hash, template_version)` —
  две версии одной карточки теперь допустимы;
- `short_id` остаётся уникальным; старые ссылки `sh_<short_id>` открываются.

`IF EXISTS`/`IF NOT EXISTS` — файл можно накатить повторно. Данные, кроме
`template_version`, не переписываются.

**Отклонение (важно):** `short_id` теперь считается от
`(template_version, content_hash)`. Без этого первая же смена шаблона падала на
уникальном индексе `share_cards_short_idx` → `503 share_card_race` (воспроизведено
тестом). Старые `sh_`-ссылки ведут на старую строку и её файл.

---

## 5. Что проверять QA

### 5.1. Безопасная зона на реальной карточке

```bash
# в приложении: карточка дня → «Поделиться» → «Сохранить в галерею»
# ожидается: 1080×1920; сверху и снизу по 250 px — только фон,
# внутри: имя продукта, фаза + строка «сегодня хорошо для…», дата,
# подсказка «ищи в Telegram: …», дисклеймер и t.me/<bot>?start=sh_…
```

Пиксельная проверка уже автоматизирована в `test_cards.py`; на стенде
достаточно глазами убедиться, что интерфейс Instagram не перекрывает текст.

### 5.2. Пустой бренд — карточки нет

```bash
# перезапустить API с BRAND_NAME='' (или убрать переменную)
curl -s -X POST -H "X-Telegram-Init-Data: $INIT_DATA" -H 'content-type: application/json' \
  -d '{"kind":"day"}' https://<host>/api/v1/share/card | jq '.details.reason'
# ожидается: "brand_name_missing", HTTP 503
# вернуть BRAND_NAME — карточка снова собирается
```

### 5.3. `identity`

```bash
# человек с оплаченным разбором, глава «Ядро» длинная и «на ты»
curl -s -X POST -H "X-Telegram-Init-Data: $INIT_DATA" -H 'content-type: application/json' \
  -d '{"kind":"identity"}' https://<host>/api/v1/share/card | jq
# ожидается: 200, картинка 1080×1920, три фразы, внизу «Узнал себя? Спроси, что про тебя»
# повторить запрос — share_url тот же (кэш по содержимому)
# человек без оплаты → 403 report_not_paid
# разбор с терминами/короткий → 422 not_enough_identity_lines
```

Фразы проверить глазами: без «асцендент/Солнце в …», без «на 80 %», без
«ты склонна». Если в разборе попалась фраза с родом — это баг отбора, а не
карточки: пришлите текст главы.

### 5.4. `moon` без профиля

```bash
# новый пользователь бота, карту НЕ строил
curl -s -X POST -H "X-Telegram-Init-Data: $NEW_INIT_DATA" -H 'content-type: application/json' \
  -d '{"kind":"moon"}' https://<host>/api/v1/share/card | jq '.url, .caption'
# ожидается 200 и картинка; сравнить фазу/знак с прогнозом дня для того же пояса
-d '{"kind":"moon","tz":"Pacific/Kiritimati"}'   # дата — по этому поясу
-d '{"kind":"moon","tz":"Mars/Olympus"}'         # 422 share_tz_unknown, field tz
# без initData → 401
```

### 5.5. Метрика и события

```bash
curl -s -H "X-Telegram-Init-Data: $ADMIN_INIT_DATA" https://<host>/api/v1/admin/metrics \
  | jq '.share_cards_created_24h'
# ожидается объект с пятью ключами; day/identity/moon растут после сборок карточек
```

`share_saved` присылает клиент; пока фронт его не отправляет (это задача
`round37-frontend-share-cards.md`), метрика сохранений остаётся нулевой — это
ожидаемо, а не поломка.

### 5.6. Чего проверить нельзя в sandbox

- Bot API и inline-режим (`sh_<short_id>` в чужом чате) — не проверялись,
  кампания не считается активной.
- Реальная вёрстка под интерфейсом Instagram (перекрытие зон) — только глазами
  на телефоне.
