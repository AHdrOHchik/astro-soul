-- 0040_user_ban.sql
-- Итерация 41 (волна 40.2), контракт 1.6.16.
--
-- Бан пользователя из панели поддержки. Нужен ровно один факт — «доступ
-- закрыт» — и причина, чтобы через месяц можно было ответить, почему.
--
-- Почему не `deleted_at` и не `status`:
--   • бан **не** удаляет данные и не отменяет подписку: человек может
--     вернуться, а `DELETE /me` — отдельный, необратимый путь 152-ФЗ;
--   • бан **не** пишется в `entitlements`: право — это покупка, она остаётся,
--     а решение «пускать или нет» принимается над ней. Поэтому проверка бана
--     живёт в `AccessService.hasAccess` **до** подписки и грантов: иначе
--     забаненный с активной подпиской продолжал бы ходить в разбор и вопросы;
--   • отмена подписки в Telegram при бане не делается: списание — это деньги
--     человека, а не наказание, и отменять его должна поддержка осознанно
--     (`POST /subscription/cancel`), а не «забанить на всякий случай».
--
-- `banned_at` — момент, `ban_reason` — текст владельца (5…500 символов).
-- Оба `NULL` — «не забанен»; согласованность держит `CHECK`, а не код: строка
-- «забанен без причины» не должна появляться даже прямым SQL.
--
-- Идемпотентность: `IF NOT EXISTS` везде, включая констрейнт.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS banned_at timestamptz,
  ADD COLUMN IF NOT EXISTS ban_reason text;

COMMENT ON COLUMN users.banned_at IS
  'Момент блокировки доступа (1.6.16). NULL — не забанен; проверяется в AccessService.hasAccess до подписки и грантов';
COMMENT ON COLUMN users.ban_reason IS
  'Причина блокировки, текст владельца 5…500 символов; NULL вместе с banned_at';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_ban_consistent') THEN
    ALTER TABLE users
      ADD CONSTRAINT users_ban_consistent CHECK (
        (banned_at IS NULL AND ban_reason IS NULL)
        -- `ban_reason IS NOT NULL` обязателен отдельно: `char_length(NULL)`
        -- даёт NULL, а `CHECK` с NULL **проходит** — без этой проверки «забанен
        -- без причины» вставлялось бы молча.
        OR (banned_at IS NOT NULL AND ban_reason IS NOT NULL
            AND char_length(ban_reason) BETWEEN 5 AND 500)
      );
  END IF;
END $$;

-- Частичный индекс: панель и метрики спрашивают «кто забанен», а остальные
-- запросы к `users` по нему не ходят вовсе.
CREATE INDEX IF NOT EXISTS users_banned_idx ON users (banned_at) WHERE banned_at IS NOT NULL;
