# Итерация 28 — `steps` собирается из пунктов, а не режется поперёк

Блокер выпуска совместимости. Контракт: **1.6.4** (схемы не менялись, только
описание). Ветка `arena/9c9c0a10-astro-soul`, база `a94ad9d`.

## 1. Что случилось

Второй живой прогон (`compatibility_id: 46d8b893`, 20.11) снова `failed`, но
уже на `steps`, за 3,90 ₽. Три раздела прошли, четвёртый убил заказ:

```
clicks    from=1011  to=900   boundary=sentence   ok
friction  from=1265  to=786   boundary=paragraph  ok
scenario  from=1278  to=647   boundary=sentence   ok   warnings=["partner_pronoun","trimmed"]

steps     from=651   to=474   boundary=sentence
          rejected: code=format  chars=553  verdict="ok"  failures=["steps_count"]

steps     from=799   to=539   boundary=word
          rejected: code=format  chars=618  verdict="ok"  failures=["ui_reference","steps_count"]
          dropped: reason="unrepairable"
compat_failed  code=format  attempts=5  cost_rub=3.8955
```

Это регрессия итерации 27: общий триммер (`trimCompatSection`) режет текст по
абзацу, предложению или слову, а `steps` — это **список из трёх пунктов**.
Абзац здесь — весь список, поэтому обрезка «по предложению» снесла конец
третьего пункта, а «по слову» — ещё и разрезала текст по живому
(`boundary=word`). Дальше валидатор честно сказал `steps_count`, сервис
честно счёл это провалом, и заказ за 249 ⭐ умер.

Три отдельных дефекта вокруг этого:

1. **`steps` мог выбрасываться по форме.** Правило итерации 18 («форма чинится,
   а не судится») до `steps` не доехало: `steps_count` и `ui_reference` были
   провалами, а `dropped` — с причиной `unrepairable`, без различения «пусто»
   и «сломан список».
2. **`chars` в логе не совпадал с обрезанным текстом.** `trimmed to=474`, а
   `rejected chars=553`: обрезали объём без подписи, проверяли текст с
   подписью, в БД писали третий вариант. По такому логу нельзя делать выводы.
3. **Светила терялись.** Блок `luminaries` пришёл с `present: false` во всех
   четырёх парах, а семейство `luminary` собиралось только из него — то есть
   раздел «Что совпадает» (тизер продукта) оставался без своего главного
   семейства, хотя в `cross_aspects` светила были.

## 2. Что сделано

### 2.1. `steps` режется только по пунктам

- `trimSteps` (`compat-validators.ts:672`) — единственный путь для `steps`:
  текст разбирается на пункты (`stepsItems`, продолжения строк склеиваются),
  каждый пункт обрезается отдельно `trimStepsItem` (`:644`) до
  `COMPAT_STEPS_ITEM_MAX = 140` (`:143`) по границе слова, с точкой в конце и
  без висячего союза/предлога. Затем текст собирается заново из **всех**
  пунктов, а подпись-дисклеймер прикрепляется последним абзацем и в обрезке
  **не участвует никогда**.
- `trimCompatSection` (`:695`) для `steps` вызывает только `trimSteps` и
  никогда не падает в общий триммер — `boundary` у `steps` бывает только
  `items`.
- Длина `steps` — мягкий ориентир: если после поштучной обрезки объём вне
  400–550 (например, два пункта), текст **всё равно** уходит человеку, а в лот
  пишется `compat_section_trim_out_of_range` и предупреждение `length_off
  direction=above`. Три действия — жёсткий инвариант, объём — нет.

### 2.2. `steps` не выбрасывается из-за формы

- `steps_count` — пометка: 2 и 4 пункта принимаются (`SOFT_FOR_STEPS`, `:153`).
  «Ровно три» — требование промпта, а не условие выдачи.
- `ui_reference` для `steps` — тоже пометка (см. 2.4).
- `dropped` теперь всегда с причиной (`reason`): `empty_response` (пусто),
  `unparsed` (у `steps` нет ни одного пункта «—», это и есть «нераспарсенный
  ответ»), `unsafe` (вердикт о паре, процент совместимости, запрещённая тема).
  Форма раздела в этот список не входит вовсе.

> Честная граница: `steps` может пропасть не только на пустом ответе, но и на
> запрещённом содержании — «вам не подходите» или «80 % совместимости» нельзя
> показывать ни за какие деньги (правило итерации 23). Это отдельная причина
> `unsafe`, и она не про форму.

### 2.3. Одна строка: валидация = хранение = лог

- `finalizeSection({key, bodyMd}) → {text, chars, volumeChars}`
  (`compat-validators.ts:312`). `text` — ровно то, что уходит в `chapters`, в
  ответ и в лог; `chars = text.length`; `volumeChars` — без подписи (по нему
  вердикт длины).
- В сервисе (`compat.service.ts:628`, `:657`) текст фиксируется этой функцией
  один раз — до и после обрезки, — и дальше используется только `final.text`
  и `final.chars`. В логах `compat_section_ok` / `compat_section_trimmed` /
  `compat_section_rejected` теперь есть и `chars`, и `volume_chars`, и (у
  `steps`) `items`.
- Инвариант закреплён тестом
  `test/compat.spec.ts:1453` («`chars` в логе — длина ровно того текста, что
  попал в ответ»): сверяются лог, ответ API и `reports.chapters`, для `steps` и
  для обрезанного `clicks`.
- Обрезка теперь видна и в записи, а не только в логе: `validation[]` получил
  `trimmed: {from, to, boundary}` и `volume_chars`.

### 2.4. `ui_reference` описан и понижен для `steps`

- Правило (`compat-validators.ts:146`) ищет регуляркой `нажм…`, `свайп…`,
  `тап…`, `экран…`, `кнопк…` — отсылку к интерфейсу приложения вместо жизни
  (текст должен читаться и в PDF).
- Для `clicks`/`friction`/`scenario` это по-прежнему провал. Для `steps` —
  пометка: «отметь в календаре» в списке действий не повод не отдать покупку.
- Найденное слово пишется в `matched` (в `warnings`, в `checks` и в логах
  `matched: {ui_reference: "Нажмите"}`) — иначе код не диагностируется.

### 2.5. `validation` — перечень проверок с вердиктами

`validateCompatSection` возвращает `checks: [{rule, status: ok|warn|fail,
detail, matched}]`; он же пишется в `reports.validation`. Противоречие
«`code: "format"` при `verdict: "ok"`» больше не воспроизводится: в записи
видно, что длина `ok`, а сломан список.

### 2.6. Светила из `cross_aspects`

`factorsOf` (`compat-facts.ts:264`) относит кросс-аспект с `luminary: true` к
семейству `luminary` с идентификатором `luminary:aspect:<пара>`, а пары из
блока `luminaries` не дублирует. На этой паре (все четыре `present: false`,
как в живом прогоне) семейство выросло с **0 до 14** факторов; в тестовой
паре с тремя `present: true` — 15 (14 из аспектов + `venus-mars` из блока).

## 3. Новая строка БД `46d8b893`

Прод-БД из песочницы недоступна, поэтому запись **восстановлена по логу**, а
не прочитана из `reports`. Что из неё следует:

| Поле | Значение |
|---|---|
| `error_code` | `format` (следствие `steps_count`/`ui_reference` в старом коде) |
| `attempts` | `5` = клики 1 + трение 1 + сценарий 1 + `steps` 2 |
| `llm_cost_rub` | `3.8955` |
| `status` | `failed` |
| `section_status` | `clicks: ok`, `friction: ok`, `scenario: ok`, `steps: failed` |
| `normalization` | `clicks {trimmed}`, `friction {trimmed}`, `scenario {trimmed, partner_pronoun}`; у `steps` записи нет — раздел не был принят (обрезка жила только в логе) |
| `validation` | две записи `steps`: `attempt 1` — `code=format`, `chars=553`, `verdict=ok`, `failures=["steps_count"]`; `attempt 2` — `code=format`, `chars=618`, `verdict=ok`, `failures=["ui_reference","steps_count"]` |

Расхождение «обрезали до 474 / 484, а `chars` 553 / 618» — ровно тот дефект
наблюдаемости, который закрыт в 2.3: 553 и 618 — длина текста **с** подписью,
474 и 539 — длина объёма без неё.

## 4. Как проверял

```
pnpm build      → ok, web 114.7 kB gzip из 350
pnpm lint       → 0 проблем
pnpm typecheck  → 4/4 проекта; gen:contracts:check и gen:api:check зелёные
                  (схемы не менялись, версия 1.6.4 — только описание)
pnpm test       → api 529/529 (45 файлов, было 516/516), shared 31/31,
                  ui 39/39, web 823/825 — те же два падения
                  apps/web/tests/legal-texts.test.ts, что и на базе
```

`compat.spec.ts`: 54 → 67 тестов (+13). Новые:

- `651` и `799` знаков → три пункта, подпись на месте, объём 416/421 в
  границах, `boundary = "items"`, каждый пункт ≤ 140 + маркер + точка, каждый
  кончается точкой;
- общий триммер к `steps` не применяется: даже на 2 156 знаках `boundary`
  остаётся `items` и пунктов три;
- два пункта → `ready`, `steps_count` — пометка, кредит израсходован на
  готовый текст, ни один раздел не `failed`;
- четыре пункта → `ready`, четыре пункта в ответе;
- `ui_reference` в `steps` → `ready`, в логе
  `matched: {ui_reference: "Нажмите"}` и `checks: {ui_reference: "warn"}`;
- `ui_reference` в `scenario` → по-прежнему провал, но со словом в `matched`;
- битая разметка (таблица) в `steps` → `ready`, `format_table: warn`;
- `steps` прозой → `dropped: unparsed`, кредит не списан;
- запрещённый процент в `steps` → `dropped: unsafe`, и в `validation` записана
  обрезка (`trimmed: {boundary: "items"}`), `chars > volume_chars`,
  `compat_percent: fail` при `verdict: ok`;
- `chars` из лога = длина ответа API = длина в `reports.chapters` (для `steps` и
  обрезанного `clicks`);
- светила: при `present: false` у всех четырёх пар семейство `luminary` не
  пустое, все факторы с префиксом `luminary:aspect:`, `familiesMissing` пуст;
  пары из блока не дублируются.

### `compat:dry-run --long`

```
status: ready
  clicks    chars  867 | объём  867
  friction  chars  867 | объём  867
  scenario  chars  642 | объём  642
  steps     chars  495 | объём  416, пунктов 3
Предупреждения контракта: clicks/trimmed, friction/trimmed, scenario/trimmed, steps/trimmed
cost_rub (оценка токенов): 3.6120
```

`--long --steps=799`: `steps chars 500 | объём 421, пунктов 3`, `status: ready`.
То есть оба ответа из живого лога теперь проходят.

## 5. Что проверять QA

1. Заказ совместимости → `ready`; `steps` — три пункта «—» и подпись последним
   абзацем; в `/admin/metrics` `compat_sections_dropped_24h` остаётся 0.
2. `GET /compatibility/{id}`: `steps` в объёме 400–550 (или короче при двух
   пунктах — тогда есть `length_off`), `warnings` может содержать `trimmed`.
3. В логе `compat_section_ok` для `steps` — `items: 3`, `chars` = длина текста
   в ответе (без последнего символа тоже сходится), `volume_chars` меньше на
   длину подписи.
4. `compat_section_dropped` бывает только с `reason`:
   `empty_response` / `unparsed` / `unsafe`.
5. В `reports.validation` у отказов есть `checks` с вердиктами; у обрезанных —
   `trimmed`.
6. `pnpm --filter @astro-soul/api run compat:dry-run --long --steps=651` и
   `--steps=799` — оба `ready`, три пункта.

## 6. Контракт

**Не изменён.** Новых полей, кодов и эндпоинтов нет; перечень
`Compatibility.warnings` (`length_off`, `trimmed`, `disclaimer_added`) тот же.
Изменилось поведение: `steps` не может исчезнуть из-за формы. Версия поднята
до 1.6.4 записью в описании контракта, чтобы прогоны до и после отличались.

## 7. Не проверено

- **Живого прогона на GigaChat не было** (в песочнице нет ключа владельца и
  сети до провайдера): вместо него `compat:dry-run --long` на тех же объёмах
  (651/799) и сквозные тесты; что GigaChat отвечает именно так, подтверждено
  логом `46d8b893`, а не новым запуском;
- строка `46d8b893` восстановлена по логу — прод-БД недоступна, поэтому
  `section_status`/`validation`/`normalization` в таблице 3 могут отличаться в
  деталях (например, в `section_status` могло быть `regenerated` вместо `ok`);
- `cost_rub` после правки на живом провайдере не измерен: оценка по цене
  вызова из провалившегося прогона — ≈3,2–3,9 ₽ за четыре вызова.
