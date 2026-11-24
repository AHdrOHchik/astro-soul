-- 0037_admin_sessions.sql
-- Итерация 40 (волна 40.1), контракт 1.6.15.
--
-- Сессия админ-панели: **непрозрачный идентификатор в таблице**, а не JWT и не
-- подписанная cookie. Причина не в удобстве, а в кнопке «Выйти»: stateless
-- сессия после выхода остаётся валидной до истечения срока, и скопированный из
-- DevTools идентификатор продолжает работать. Здесь `revoked_at` делает выход
-- настоящим: строка та же, доступ снят.
--
-- `csrf_token` лежит в этой же строке: второй секрет с отдельным сроком жизни
-- означал бы вторую причину для «токен истёк, а сессия нет». Ротируется при
-- каждом входе, а не при каждом запросе: иначе две открытые вкладки панели
-- начали бы гасить токен друг другу.
--
-- Хранение `id` в открытом виде — осознанно. 12-часовой срок и **один** админ
-- (ADMIN_TG_ID) дают вероятность угадать идентификатор, равную вероятности
-- угадать 122 бита случайности; хэш добавил бы только слой «а как отозвать, не
-- зная id». Решение зафиксировано в отчёте итерации.
--
-- `name` — снимок имени из Telegram на момент входа (см. отчёт: §3.2 требует
-- отдавать имя именно из сессии, а не джойнить `users`). Имя человека меняется,
-- история входов — нет.
--
-- Идемпотентность: `IF NOT EXISTS` — файл можно накатить повторно на стенде.

CREATE TABLE IF NOT EXISTS admin_sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tg_id        bigint NOT NULL,
  -- Снимок подписи из Telegram Login Widget на момент входа: «кто это был».
  name         text NOT NULL,
  csrf_token   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  last_seen_at timestamptz,
  CONSTRAINT admin_sessions_name_not_empty CHECK (char_length(name) BETWEEN 1 AND 200),
  CONSTRAINT admin_sessions_expires_after_created CHECK (expires_at > created_at)
);

COMMENT ON TABLE admin_sessions IS
  'Сессии админ-панели (1.6.15): id — непрозрачный, отзыв через revoked_at';
COMMENT ON COLUMN admin_sessions.name IS
  'Снимок имени из Telegram Login Widget на момент входа; не джойнить с users';
COMMENT ON COLUMN admin_sessions.csrf_token IS
  'CSRF-токен сессии, отдаётся в GET /admin/me; обязателен в X-Admin-CSRF для cookie-пути';

-- «Все сессии человека» и «уборка по сроку» — два реальных запроса к таблице.
CREATE INDEX IF NOT EXISTS admin_sessions_tg_idx ON admin_sessions (tg_id);
CREATE INDEX IF NOT EXISTS admin_sessions_expires_idx ON admin_sessions (expires_at);
