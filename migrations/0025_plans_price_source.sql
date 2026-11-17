-- 0025_plans_price_source.sql
-- Единственный источник цен — таблица `plans` (итерация 23, дополнение).
--
-- Что было не так: цена жила в `packages/shared/src/plans.ts`, «зеркалилась»
-- в `plans` сидом и одновременно читалась в трёх местах. Владелец поправил
-- строку в БД — приложение показало старую цену; поправил файл — показало
-- новую, а Telegram выставил третью. Класс дефекта — «человек платит не то,
-- что видит».
--
-- Что делает миграция:
--   1. Кладёт в `plans` всё, что витрина показывает и сервер выставляет:
--      тексты пейволла и права (`grants`), из которых собирается `includes[]`.
--      Цена (`stars`) в таблице уже была.
--   2. Добавляет `invoices.stars` — **снимок суммы** на момент выставления
--      счёта. Проверки `pre_checkout` и `successful_payment` сверяются со
--      снимком: правка цены, пока окно оплаты открыто, не должна отклонять
--      уже выставленный счёт.
--
-- Тестовые тарифы (`test_1`, `test_report_1`) здесь **не создаются**: строки
-- кладёт сид и только при `PAYMENTS_TEST_PLANS=1` (или вне прода), чтобы в
-- прод-базе их не было даже случайно.

ALTER TABLE plans
  ADD COLUMN paywall_title    text NOT NULL DEFAULT '',
  ADD COLUMN paywall_subtitle text NOT NULL DEFAULT '',
  -- Права и состав плана: {grant} у разового товара,
  -- {fullForecast, askPerDay, compatPerMonth, solarIncluded} у подписки.
  -- Из них собирается `includes[]` витрины, поэтому «обещание» и «что выдаём»
  -- не расходятся.
  ADD COLUMN grants           jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN plans.paywall_title IS
  'Название тарифа на витрине (GET /billing/plans). Источник — только эта таблица.';
COMMENT ON COLUMN plans.paywall_subtitle IS
  'Подпись тарифа на витрине: что человек получает, одной фразой.';
COMMENT ON COLUMN plans.grants IS
  'Права плана в JSON: {grant} для разового, права подписки для периодического.';

-- Снимок суммы в инвойсе. Для уже выставленных счетов берём текущую цену
-- плана: другой истории у нас нет, а на момент их создания цена была именно
-- такой (правки цены до этой миграции нигде не сохранялись).
ALTER TABLE invoices ADD COLUMN stars integer;

UPDATE invoices i
   SET stars = p.stars
  FROM plans p
 WHERE p.code = i.plan_code
   AND i.stars IS NULL;

ALTER TABLE invoices ALTER COLUMN stars SET NOT NULL;
ALTER TABLE invoices
  ADD CONSTRAINT invoices_stars_positive CHECK (stars > 0);

COMMENT ON COLUMN invoices.stars IS
  'Снимок цены на момент выставления счёта: сверка pre_checkout/successful_payment идёт с ним, а не с текущей ценой плана.';
