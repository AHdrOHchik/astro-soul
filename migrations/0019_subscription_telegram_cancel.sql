-- Состояние отмены подписки в Telegram (задача A итерации 12).
--
-- `DELETE /me` отменяет подписку локально в любом случае, но автопродление
-- живёт в Telegram: без `editUserStarSubscription` человеку спишут звёзды за
-- следующий период уже после удаления данных. Вызов идёт ДО транзакции, его
-- результат пишется сюда, а неуспех повторяет ночной джоб.
--
-- `telegram_payment_charge_id` в `subscriptions` уже есть (0003) и обновляется
-- каждым продлением в `upsertSubscription`: это и есть «последний успешный
-- successful_payment» подписки. Отдельную колонку `telegram_charge_id` не
-- заводим — она дублировала бы существующую и разошлась бы с ней при
-- продлении. Дублирование `charge_id` из `payments` осознанное ровно в этом
-- смысле: связь подписки с платежом переживает обнуление `user_id`.

ALTER TABLE subscriptions
  ADD COLUMN telegram_cancel_state telegram_cancel_state NOT NULL DEFAULT 'none';

ALTER TABLE subscriptions
  ADD COLUMN telegram_cancel_attempts integer NOT NULL DEFAULT 0;

ALTER TABLE subscriptions
  ADD COLUMN telegram_cancel_last_at timestamptz;

-- Повторяем только те, что ждут повтора: частичный индекс ровно под запрос
-- ночного джоба (status = 'cancelled' AND telegram_cancel_state = 'failed').
CREATE INDEX subscriptions_telegram_cancel_retry_idx ON subscriptions (telegram_cancel_last_at)
  WHERE status = 'cancelled' AND telegram_cancel_state = 'failed';

COMMENT ON COLUMN subscriptions.telegram_cancel_state IS
  'Отмена автопродления в Telegram: none | cancelled | failed | gave_up';
COMMENT ON COLUMN subscriptions.telegram_cancel_attempts IS
  'Сколько раз вызывали editUserStarSubscription (успех тоже считается)';
COMMENT ON COLUMN subscriptions.telegram_cancel_last_at IS
  'Когда вызывали в последний раз: повтор не чаще раза в час';
