-- 0024_compat.sql
-- Совместимость (синастрия), контракт 1.6.0: данные партнёра, факты пары,
-- расход разовой покупки.
--
-- Почему отдельная таблица, а не «вторая карта в `charts`»:
--   • `charts` — карты владельца. Партнёр там стал бы «текущей картой»
--     (`GET /charts/current`) и всплыл бы в онбординге как своя;
--   • у партнёра нет согласия и нет профиля, его данные — минимум для
--     расчёта: дата, необязательное время, место и тип отношений;
--   • каскад `ON DELETE CASCADE` от `users` даёт удаление в той же
--     транзакции, что и `DELETE /me`, без отдельного кода.
--
-- Свободного текста здесь нет ни в одной колонке: имя, заметка или метка
-- («Аня») — это канал, через который ПДн третьего лица попадут в БД, в логи
-- и в промпт. `relationship` — код из закрытого перечня, а не текст.

CREATE TABLE compat_partners (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- romantic | friend | family | colleague (проверка перечня — в БД, а не
  -- только в коде: мимо API в таблицу ничего не просочится).
  relationship text NOT NULL,
  birth_date   date NOT NULL,
  -- NULL = «время неизвестно»: дома и оверлеи тогда не считаются.
  birth_time   time,
  -- Место — как в онбординге: город справочника плюс координаты и пояс.
  city_id      text,
  lat          numeric(9, 6) NOT NULL,
  lon          numeric(9, 6) NOT NULL,
  tz           text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT compat_partners_relationship CHECK (
    relationship IN ('romantic', 'friend', 'family', 'colleague')
  ),
  CONSTRAINT compat_partners_lat CHECK (lat BETWEEN -90 AND 90),
  CONSTRAINT compat_partners_lon CHECK (lon BETWEEN -180 AND 180),
  CONSTRAINT compat_partners_birth_date CHECK (birth_date >= DATE '1900-01-01')
);

CREATE INDEX compat_partners_user_idx ON compat_partners (user_id, created_at DESC);

COMMENT ON TABLE compat_partners IS
  'Данные партнёра для синастрии: только дата/время/место и тип отношений, без свободного текста. Удаляются каскадом вместе с пользователем';

ALTER TABLE reports
  -- Пара, по которой считалась совместимость. `SET NULL`, а не `CASCADE`:
  -- удаление партнёра не должно молча стирать купленный разбор.
  ADD COLUMN compat_partner_id uuid REFERENCES compat_partners (id) ON DELETE SET NULL,
  -- `compatibility_facts` v1.0 из сайдкара: по ним написан текст. Хранится,
  -- чтобы проданную совместимость можно было объяснить без пересчёта.
  ADD COLUMN compat_facts jsonb,
  -- Какая разовая покупка (`entitlements.kind = 'compat'`) израсходована
  -- этим заказом. NULL — подписка или провал.
  ADD COLUMN credit_entitlement_id uuid REFERENCES entitlements (id) ON DELETE SET NULL;

-- Покупка списывается **только при `ready`**: провал возвращает кредит сам,
-- без джобы и без ручного вмешательства.
ALTER TABLE entitlements ADD COLUMN used_at timestamptz;

COMMENT ON COLUMN entitlements.used_at IS
  'Когда разовая совместимость израсходована (status = ready). NULL — не израсходована';

CREATE INDEX entitlements_compat_unused_idx ON entitlements (user_id)
  WHERE kind = 'compat' AND status = 'active' AND used_at IS NULL;

CREATE INDEX reports_compat_idx ON reports (user_id, created_at DESC)
  WHERE kind = 'compat';

-- Уникальность «один готовый разбор на карту» к совместимости не относится:
-- у одной карты может быть несколько партнёров, и каждая пара — своя покупка.
DROP INDEX reports_one_ready_per_chart_kind;

CREATE UNIQUE INDEX reports_one_ready_per_chart_kind
  ON reports (chart_id, kind)
  WHERE status = 'ready' AND kind <> 'compat';
