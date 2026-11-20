# Аудит удалённых App-тестов round30_2

## Сравнение

Сравнён переход исходной итерации `3e3967f` → round30-коммит `79c0cdf` (до сегодняшнего merge свежего `main`, commit `95bc0c8`); старый файл — `apps/web/src/App.test.tsx`. В diff удалено **44 объявления: 8 `describe` и 36 `it`**. Причина полного удаления старого блока: round30 заменил прежний единый экран «прогноз + вопрос» на отдельные постоянные вкладки и отдельные API-потоки. Это объясняет перенос тестового места, но не само по себе эквивалентность всех сценариев.

Ниже перечислены все удалённые объявления дословно. Причина указывается для каждой группы и наследуется каждым её тестом.

## Полный список объявлений и причины

### `describe('App: the forecast and the question', ...)`
Причина: интеграционные сценарии относились к прежнему единому экрану; прогноз и вопрос теперь тестируются в отдельных экранах, а базовый переход по вкладкам — в новом `App.test.tsx`. Полный прежний маршрут целиком не сохранён как один тест.

- `it('from the card on the chart to the forecast, and on to a question and its answer', ...)` — дробится на `DailyForecastScreen.test.tsx`, `QuestionsScreen.test.tsx` и `App.test.tsx`; сквозное взаимодействие двух вкладок не повторено целиком.
- `it('shows the card on a chart just built from the form as well, for the chart the server made', ...)` — привязано к прежнему потоку сразу после построения карты; round30 открывает разные вкладки. Полный переход после построения до нового интерфейса отдельно не восстановлен.

### `describe('the way to a subscription', ...)`
Причина: старое upsell-размещение было частью единого экрана. Текущие экраны проверяют примеры и переход на paywall; отдельная проверка каждого прежнего размещения не перенесена.

- `it('under the short forecast: a quiet note that leads to the paywall with the subscriptions', ...)` — новый тестовый маршрут paywall не подтверждает старый upsell под прогнозом (прежнего места больше нет).
- `it('a subscription confirmed after the chart was deleted stays on the success screen until «Построить карту» is tapped', ...)` — общий результат подтверждения/нет карты частично покрывается `PaywallScreen.test.tsx`; точный старый success-screen маршрут в round30 не подтверждён.
- `it('where the day\'s questions are used up: «В подписке 5 вопросов в день» leads to the same paywall', ...)` — текущие квота-вопроса и paywall проверяются раздельно; старый экран/копирайт «5 вопросов в день» не переносился как round30-поведение.
- `it('is not shown to a subscriber: not under a short forecast, not where the questions are used up', ...)` — больше нет этих двух старых мест; проверки состояния подписки и текущих paywall-путей остаются в экранных тестах, но старые assertions не имеют буквального аналога.

### `describe('a build that sells no subscriptions (`subscriptions: false`)', ...)`
Причина: build flag и checkout проверяются в `PaywallScreen.test.tsx`, но удалены кросс-экранные утверждения старого App; полная матрица «каждая вкладка/настройки/paywall» заново не выполнялась.

- `it('offers none anywhere: the forecast, the used-up questions, the settings and the paywall say nothing of buying one', ...)` — частичное покрытие Paywall/экранов есть; полный старый кросс-экранный запрет предложений не подтверждён одной интеграционной проверкой.
- `it('still sells the report: the invoice asked for is the report\'s, for this chart', ...)` — report checkout остаётся в `PaywallScreen.test.tsx`; точная связка старого App-состояния с текущим экраном не сохранена.
- `it('shows a subscriber what they have as ever: the full forecast, five questions, the plan in the settings', ...)` — доступы и тарифы проверяются в отдельных экранах; полный старый набор «прогноз + пять вопросов + настройки» не повторён как единый сценарий.

### `describe('the chart is gone from the server (the data was deleted elsewhere while this page stayed open)', ...)`
Причина: старый блок тестировал матрицу удаления карты через монолитный App и несколько маршрутов. Есть новые локальные проверки `404` на отдельных экранах (`QuestionsScreen`, paywall и settings), но это не эквивалент всей прежней матрицы.

- `it('404 to a question: the welcome screen, as for a new user', ...)` — в `QuestionsScreen.test.tsx` проверен callback `onChartGone`; полная App-навигация в welcome не доказана.
- `it('404 to the order of a report: the same', ...)` — paywall проверяет удалённую карту локально; точный старый маршрут до welcome в round30 не подтверждён.
- `it('422 about `chart_id` to an invoice for the report: the same', ...)` — report/paywall тестирует checkout-ошибки, но этот точный 422-переход до welcome не подтверждён.
- `it('404 to a forecast, and `Me` with no chart: the same. The 404 alone says «none yet», `Me` says which it is', ...)` — отсутствует проверка согласования этого сочетания `404` + `GET /me` в новом Today-потоке.
- `it('404 to a forecast while `Me` still names the chart: «готовится» and nothing else. One question to `Me`, no more', ...)` — отсутствует проверка этого конфликтующего состояния сервера в round30.
- `it('the question screen opened after the deletion: `Me` says there is no chart, and no question is ever sent', ...)` — локальная проверка нового вопроса подтверждает callback на 404; переход после независимого удаления до отправки не доказан.
- `it('a chart built in this session goes: what the user typed into the form is not kept either, and the consent is asked anew', ...)` — сценарий сброса после удаления карты и повторного согласия не покрыт новым round30 тестом целиком.
- `it('a failure to ask `Me` is not «no chart»: the screens stay where they are', ...)` — отдельная проверка ошибки запроса `Me` в текущем tabbed App не установлена.

### `describe('the report went with the data: the server has no such report (404), and `Me` says whether the chart is gone too', ...)`
Причина: удалены интеграционные комбинации между старым report panel и глобальным `Me`. Сценарии отчёта/404 тестируются в `PaywallScreen.test.tsx` и report-экранах, но не каждая старая развилка восстановлена.

- `it('404 to the report `Me` named, asked about from the chart screen: the welcome screen, as for a new user', ...)` — точный переход report → welcome в round30 не подтверждён.
- `it('404 to that report on the report screen: the same, and the report screen says nothing on the way', ...)` — report экран/ошибка тестируются отдельно; assertion о молчаливом переходе полного старого App не перенесён.
- `it('a report ordered here and deleted with the data while it was being written: the same. The server\'s «Такого разбора нет» is never shown', ...)` — гонка удаления во время генерации не проверена в новом полном App-маршруте.
- `it('404 to a report while `Me` still names the chart: the report alone is forgotten. One question to `Me`, no more', ...)` — комбинация отчёт удалён/карта осталась и число запросов `Me` отдельно не подтверждены.
- `it('`Me` that goes on naming the report the server does not have starts no circle of questions: one about the report, one to `Me`', ...)` — защита от цикла запросов для исчезнувшего отчёта не перенесена как round30 тест.
- `it('a server at odds with itself (`Me`: no chart; `GET /charts/current`: a chart) is asked once more and no further: the app stays on the chart it is handed', ...)` — эта рассинхронизация `Me`/current chart не имеет нового интеграционного аналога.
- `it('a failure to ask `Me` then is not «no chart»: the chart stays, the report is forgotten', ...)` — отдельная report-ветка при ошибке `Me` не подтверждена в новой архитектуре.

### `describe('the settings', ...)`
Причина: экран настроек теперь часть Cabinet; unit-проверки `SettingsScreen` остались, но старые App-state-переходы не проверялись по одному в round30.

- `it('opened after the deletion: `Me` says there is no chart, and the app starts over instead of showing the settings of nobody', ...)` — старый интеграционный путь не перенесён.
- `it('opened from a chart built in this session, after the deletion: the same', ...)` — старый интеграционный путь не перенесён.
- `it('of a user who has built no chart yet stay open: `Me` without a chart is no news about them', ...)` — Cabinet/settings локально покрыт; точная проверка старого состояния в App не перенесена.
- `it('with the chart still there: the settings, as ever', ...)` — базовый экран Cabinet проверяется отдельно; прежний полный маршрут не сохранён.

### `describe('a payment for the report is on its way when the data goes: Telegram said «paid», the server has granted nothing', ...)`
Причина: общий awaiting-payment механизм и chart-gone обработчики проверяются в `PaywallScreen.test.tsx`, но удалённые комбинации Telegram-оплаты, удаления карты и повторного запуска не все покрыты единым App-тестом.

- `it('«Проверить ещё раз» on the paywall after the deletion: the welcome screen, not «Платёж обрабатывается» with no end', ...)` — точный переход после удаления не подтверждён.
- `it('the same from the chart, where the block of the report says «Платёж обрабатывается»', ...)` — старый report-block больше не существует; полный переход из него не воспроизведён.
- `it('and from a paywall opened for a subscription meanwhile: it waits for that same payment, and leads the same way', ...)` — совместное ожидание подписки и отчёта покрывается только частично отдельными paywall-проверками; удаление карты в этой комбинации не доказано.
- `it('deleted while Telegram was showing the invoice: the first question after «paid» leads to the welcome screen', ...)` — гонка удаления во время открытого Telegram invoice не проверена в новом полном App-потоке.
- `it('the chart built after that is offered its own price: the payment for the chart that is gone is awaited no more', ...)` — повторный checkout после пересоздания карты и разрыв связи со старой оплатой не проверены новым интеграционным тестом.
- `it('a subscription on its way is about no chart: it is awaited through the start over, and counted once the server grants it', ...)` — подписка без карты/повторный запуск — не покрыты здесь; отдельные тесты paywall проверяют получение серверного grant.

### `describe('401 is another matter: the session expired, and nothing can be asked with it, the chart included', ...)`
Причина: базовые сценарии 401 уже проверяются в текущем `App.test.tsx` (в Telegram и вне Telegram); удалённый расширенный сценарий с удалённой картой после следующего запуска не имеет прямого аналога.

- `it('says so and offers to close; the next launch starts from what the server has, which after a deletion is the welcome screen', ...)` — 401 UI покрыт текущими тестами, но 401 → следующий запуск → удалённая карта не проверены как единый сценарий.

### Privacy

- `it('reports nothing of the forecast, the question or the answer', ...)` — старый общий privacy-тест заменён более целевой проверкой в новом `App.test.tsx`: отправляется частный вопрос и ready-ответ, затем подтверждается, что ни вопрос, ни ответ не попали в product analytics. Проверка `tg://` по `apps/web/src` и `packages/ui/src` также даёт пустой результат.

## Карта старый экран → новый → тесты

| Старый путь/экран | Новый путь | Тесты сейчас | Остаток |
|---|---|---|---|
| Единый экран карты, прогноза и вопроса | Вкладки «Сегодня» / «Спросить» | `DailyForecastScreen.test.tsx`, `QuestionsScreen.test.tsx`, `App.test.tsx` | Нет одного интеграционного теста всего прежнего сквозного сценария. |
| Upsell и дневной лимит вопроса под прогнозом | Примеры в Ask → Paywall | `QuestionsScreen.test.tsx`, `PaywallScreen.test.tsx` | Старое размещение/копирайт сняты; соответствие каждого старого сценария не подтверждено. |
| Сборка `subscriptions: false`, report checkout | Paywall из Map/Report | `PaywallScreen.test.tsx` | Денежные checkout/awaiting/payment cases широко покрыты; комбинации оплаты с удалением карты перечислены выше как неполный остаток. |
| Старый прогноз с `Me` и обновлением карты | «Сегодня» с API `GET /api/v1/forecast/today` | `DailyForecastScreen.test.tsx`, App-tab test | Противоречивые ответы `Me`/chart и 404 forecast требуют интеграционного покрытия. |
| Старые настройки | Cabinet | `SettingsScreen.test.tsx`, `App.test.tsx` | Экранные проверки есть, отдельные старые удаления карты из App не восстановлены. |
| Согласие, privacy, terms | Существующие Consent/Document экраны | `ConsentScreen.test.tsx`, `DocumentScreen.test.tsx`, onboarding App tests | Legal assertions не удалялись этим diff; сам текст владельца не редактировался. |

**Вывод:** финансовые/paywall, квотные, legal/document и privacy проверки в целом имеют текущие экранные тесты (в т. ч. `PaywallScreen`, `ConsentScreen`, `DocumentScreen`); privacy сценарий вопроса/ответа восстановлен. При этом отдельные cross-screen случаи удаления карты/отчёта и гонок оплаты из списка выше нельзя считать покрытыми только потому, что новый компонент или другой endpoint протестирован. Они остаются явными пробелами до ручного/интеграционного QA или адресных тестов.
