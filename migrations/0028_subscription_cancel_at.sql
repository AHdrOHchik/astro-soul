-- Отмена подписки из приложения (итерация 29).
--
-- До этой миграции отменить автопродление можно было только через `DELETE /me`
-- (вместе со всеми данными) — то есть «хочешь не продлевать, удаляй аккаунт».
-- Кнопка в мини-аппе вела на `tg://settings/star_subscriptions`, такого адреса
-- в Telegram нет, и человек оставался с живым автопродлением: через период
-- звёзды списывались молча.
--
-- `auto_renew` в `subscriptions` есть с 0003 (`NOT NULL DEFAULT true`), но до
-- сих пор был «значение из настроек Telegram, только для чтения» (payments.md
-- §3.4). Теперь это наше состояние: `POST /subscription/cancel` ставит `false`
-- **после** подтверждения Telegram, и `GET /me` показывает его клиенту.
-- Добавлять колонку заново не нужно, поэтому здесь только комментарий к ней.
--
-- `cancelled_at` — когда человек нажал «отменить» и Telegram это подтвердил.
-- Нужен, чтобы экран отличал «подписка живёт и продлится» от «подписка живёт,
-- но уже отменена, доступ до конца периода»: по одному `auto_renew` этого не
-- видно, а `updated_at` меняется от любого касания строки.
--
-- Окно возврата `charge_id` и повтор — те же, что у `DELETE /me`:
-- `telegram_cancel_state` / `telegram_cancel_attempts` / `telegram_cancel_last_at`
-- (0019) и тот же ночной джоб. Второй механизм повтора не заводим: два
-- счётчика попыток на одну подписку расходятся при первом же сбое.

ALTER TABLE subscriptions
  ADD COLUMN cancelled_at timestamptz;

COMMENT ON COLUMN subscriptions.auto_renew IS
  'Автопродление: true до отмены, false после подтверждённой отмены в Telegram';
COMMENT ON COLUMN subscriptions.cancelled_at IS
  'Когда автопродление отключено (POST /subscription/cancel, подтверждено Bot API)';

-- Частичный индекс ночного джоба: раньше он ловил только строки, отменённые
-- удалением аккаунта (`status = 'cancelled'`). Теперь отменённая подписка
-- остаётся `active` — доступ должен жить до конца периода, — поэтому условие
-- по статусу снимаем: повторяем всё, что в состоянии `failed`.
DROP INDEX IF EXISTS subscriptions_telegram_cancel_retry_idx;

CREATE INDEX subscriptions_telegram_cancel_retry_idx ON subscriptions (telegram_cancel_last_at)
  WHERE telegram_cancel_state = 'failed';

-- Метрика «сколько подписок уже не продлятся» (`subscriptions_auto_renew_off`):
-- считается по этой выборке, поэтому индекс ровно под неё.
CREATE INDEX subscriptions_auto_renew_off_idx ON subscriptions (expires_at)
  WHERE status = 'active' AND auto_renew = false;
