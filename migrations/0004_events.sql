-- 0004_events.sql
-- Продуктовая аналитика и аудит действий. Служебная таблица: не содержит ПДн,
-- только идентификаторы и названия событий.

CREATE TABLE events (
  id         bigserial PRIMARY KEY,
  -- Может отсутствовать у анонимных событий (например, отказ на входе)
  user_id    uuid,
  name       text NOT NULL,
  props      jsonb NOT NULL DEFAULT '{}'::jsonb,
  request_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Запрет на ПДн в свободных свойствах: размер ограничен, чтобы туда
  -- не «случайно» не уехал профиль рождения
  CONSTRAINT events_props_size CHECK (pg_column_size(props) < 2048),
  CONSTRAINT events_name_format CHECK (name ~ '^[a-z0-9_.]{3,64}$')
);

CREATE INDEX events_name_created_idx ON events (name, created_at DESC);
CREATE INDEX events_user_created_idx ON events (user_id, created_at DESC) WHERE user_id IS NOT NULL;
