-- 0005_billing_compat_partner.sql
-- Два изменения, без которых оплата не доходит до выдачи доступа.
--
-- 1. `invoices.chart_id`: к какой карте относится покупка (разовый разбор,
--    совместимость, карта года). Раньше это пытались уложить в `payload`,
--    но payload ограничен 128 байтами (payments.md §2), а два UUID туда
--    уже не помещаются вместе с планом. Теперь payload = plan + user + idemK,
--    а карта лежит в инвойсе.
--
-- 2. Партнёрская карта для `compat_249` появляется ПОСЛЕ оплаты (второй
--    пользователь присоединяется позже), поэтому требовать её при выдаче
--    доступа нельзя: платёж отваливался бы с ошибкой ограничения, а Telegram
--    повторял бы доставку. Проверка партнёра остаётся в приложении (отчёт
--    не генерируется без второй карты) — но не в схеме оплаты.

ALTER TABLE invoices
  ADD COLUMN chart_id uuid REFERENCES charts (id) ON DELETE SET NULL;

COMMENT ON COLUMN invoices.chart_id IS
  'Карта, к которой относится покупка; NULL для подписок и карты года без привязки';

ALTER TABLE entitlements
  DROP CONSTRAINT entitlements_compat_has_partner;

COMMENT ON COLUMN entitlements.partner_chart_id IS
  'Партнёр появляется после оплаты; NULL допустим и означает «ждёт партнёра»';
