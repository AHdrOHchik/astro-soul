-- 0039_plan_prices.sql
-- Итерация 41 (волна 40.2), контракт 1.6.16.
--
-- Управление ценами из панели. Нужны три вещи, которых в схеме не было:
--
--   1) `plans.version` — оптимистическая блокировка. Панель присылает ту
--      версию, которую видела, и сервер меняет цену только если строка не
--      уехала вперёд (`409 price_changed` с текущей ценой). Без версии две
--      вкладки молча перетирают друг друга, и «почему тариф стоит 399, а не
--      499» остаётся без ответа.
--   2) `plan_price_history` — история изменений цены. `plans` хранит только
--      текущее значение (`stars`, `updated_at`), и по нему нельзя ответить
--      «когда подорожали» и «кто это сделал». `admin_audit` показывает
--      действие, но не даёт дешёвой выборки «история цены одного тарифа».
--   3) `effective_from` — с какого момента действует новая цена. В этой
--      итерации она **всегда** равна моменту изменения: уже выставленные
--      инвойсы не пересчитываются (`invoices.stars` — снимок), а «отложенные»
--      цены потребовали бы планировщика и второго источника правды. Поэтому
--      `price_change_scope` в контракте имеет единственное значение
--      `only_new_purchases`.
--
-- `plans.updated_at` уже есть с 0003 — дублировать колонку не нужно; отчёт
-- волны 40.2 перечисляет это явно, потому что панель ждала отдельное поле.
--
-- Приватность: в истории нет ни `telegram_id`, ни имени — только `actor_tg_id`
-- (тот же принцип, что в `admin_audit`: имя — снимок, ПДн пользователей нет).
--
-- Идемпотентность: `IF NOT EXISTS` / `CREATE OR REPLACE`, миграцию можно
-- накатить повторно на стенде, где её уже применяли руками.

ALTER TABLE plans
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;

COMMENT ON COLUMN plans.version IS
  'Версия строки плана для оптимистической блокировки панели (1.6.16): растёт при смене цены';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'plans_version_positive') THEN
    ALTER TABLE plans
      ADD CONSTRAINT plans_version_positive CHECK (version > 0);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS plan_price_history (
  id                    bigserial PRIMARY KEY,
  plan_code             text NOT NULL REFERENCES plans (code) ON DELETE CASCADE,
  -- Цена, которая стала действующей. Полная сумма в звёздах: частичных
  -- изменений не бывает, поэтому и второй колонки «сколько добавили» нет.
  price_stars           integer NOT NULL CHECK (price_stars > 0),
  -- Цена до изменения. NULL — первая запись по тарифу (сравнивать не с чем).
  previous_price_stars  integer CHECK (previous_price_stars IS NULL OR previous_price_stars > 0),
  -- `plans.version` сразу после изменения: по ней база и история сходятся.
  version               integer NOT NULL CHECK (version > 0),
  -- Комментарий владельца — обязателен в запросе (мин. 5 символов): изменение
  -- цены без объяснения через месяц неотличимо от ошибки.
  comment               text NOT NULL,
  actor_tg_id           bigint NOT NULL,
  -- Снимок имени на момент действия, как в `admin_audit`.
  actor_name            text NOT NULL,
  -- Момент, с которого цена действует на новые покупки.
  effective_from        timestamptz NOT NULL DEFAULT now(),
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT plan_price_history_comment_len CHECK (char_length(comment) BETWEEN 5 AND 500),
  CONSTRAINT plan_price_history_actor_name_len CHECK (char_length(actor_name) BETWEEN 1 AND 200)
);

COMMENT ON TABLE plan_price_history IS
  'История цен тарифов (1.6.16): только добавление, previous_price_stars — NULL у первой записи';
COMMENT ON COLUMN plan_price_history.effective_from IS
  'Момент, с которого цена действует; в 1.6.16 всегда равен моменту изменения (только новые покупки)';

-- Запросы панели: «история одного тарифа», «последние изменения».
CREATE INDEX IF NOT EXISTS plan_price_history_plan_idx
  ON plan_price_history (plan_code, effective_from DESC, id DESC);
CREATE INDEX IF NOT EXISTS plan_price_history_at_idx
  ON plan_price_history (effective_from DESC, id DESC);

-- Только добавление: строка истории — факт, а не черновик.
CREATE OR REPLACE FUNCTION plan_price_history_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'plan_price_history is append-only: % не разрешён', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS plan_price_history_no_change ON plan_price_history;
CREATE TRIGGER plan_price_history_no_change
  BEFORE UPDATE OR DELETE ON plan_price_history
  FOR EACH ROW EXECUTE FUNCTION plan_price_history_append_only();
