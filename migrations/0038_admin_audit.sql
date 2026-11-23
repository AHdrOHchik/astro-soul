-- 0038_admin_audit.sql
-- Итерация 40 (волна 40.1), контракт 1.6.15.
--
-- Журнал действий админа. Пишет **сервер**, в той же транзакции, что и само
-- изменение: если транзакция откатилась — записи нет; если запись аудита не
-- удалась — откатывается и действие. Аудит не может быть необязательным,
-- иначе «кто отозвал доступ» однажды окажется вопросом без ответа.
--
-- `actor_name` — **снимок** имени на момент действия, не ссылка на `users`:
-- ник меняется, аудит — нет. Чтение истории не джойнит пользователей.
--
-- `before`/`after` — только изменённые поля, без снимков записи целиком.
-- ПДн не пишутся: если действие касается карты, в аудите будет `chart_id`,
-- а не дата рождения (это проверяет тест).
--
-- Таблица **только на добавление**: строки нельзя менять и удалять. Защита —
-- триггер, а не `REVOKE`: приложение ходит в базу одной ролью (в тестах —
-- владельцем), и `REVOKE` на такую роль ничего не запрещает, а триггер
-- срабатывает независимо от прав. Снять его можно только явной миграцией,
-- которая останется в истории.
--
-- Партиционирования нет: объём — единицы строк в день.
--
-- Идемпотентность: `IF NOT EXISTS` + `CREATE OR REPLACE FUNCTION` и
-- `DROP TRIGGER IF EXISTS` перед созданием.

CREATE TABLE IF NOT EXISTS admin_audit (
  id          bigserial PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  actor_tg_id bigint NOT NULL,
  actor_name  text NOT NULL,
  -- 'session.login', 'session.logout', 'session.revoke', 'session.purge',
  -- 'code.create', 'grant.create', 'grant.revoke' — закрытый список в коде.
  action      text NOT NULL,
  entity      text NOT NULL,
  entity_id   text,
  before      jsonb,
  after       jsonb,
  reason      text,
  request_id  text,
  CONSTRAINT admin_audit_actor_name_not_empty CHECK (char_length(actor_name) BETWEEN 1 AND 200),
  CONSTRAINT admin_audit_action_not_empty CHECK (char_length(action) BETWEEN 1 AND 64),
  CONSTRAINT admin_audit_entity_not_empty CHECK (char_length(entity) BETWEEN 1 AND 64)
);

COMMENT ON TABLE admin_audit IS
  'Журнал действий админа (1.6.15): append-only, actor_name — снимок, ПДн не пишутся';
COMMENT ON COLUMN admin_audit.before IS
  'Только изменённые поля до действия; не снимок записи';

-- Лента «что было» и фильтры панели — ровно эти три запроса.
CREATE INDEX IF NOT EXISTS admin_audit_at_idx ON admin_audit (at DESC, id DESC);
CREATE INDEX IF NOT EXISTS admin_audit_entity_idx ON admin_audit (entity, entity_id);
CREATE INDEX IF NOT EXISTS admin_audit_actor_idx ON admin_audit (actor_tg_id);

CREATE OR REPLACE FUNCTION admin_audit_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'admin_audit is append-only: % не разрешён', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS admin_audit_no_change ON admin_audit;
CREATE TRIGGER admin_audit_no_change
  BEFORE UPDATE OR DELETE ON admin_audit
  FOR EACH ROW EXECUTE FUNCTION admin_audit_append_only();
