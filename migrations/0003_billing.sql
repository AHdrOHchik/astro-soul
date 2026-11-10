-- 0003_billing.sql
-- Планы, инвойсы, платежи, подписки, разовые доступы, квоты.
--
-- Важно про ПДн: subscriptions / entitlements / payments НЕ имеют FK на users.
-- `user_id` здесь — псевдонимный ключ субъекта (тот же детерминированный UUID).
-- Так подписка и платёж переживают DELETE /me (SPEC «Сценарий 6», payments.md §3.5),
-- не блокируя удаление строки users и не таща за собой ПДн.

CREATE TYPE plan_kind AS ENUM ('one_off', 'subscription');
CREATE TYPE invoice_status AS ENUM ('created', 'paid', 'expired');
CREATE TYPE payment_status AS ENUM ('paid', 'processed', 'refunded', 'failed');
CREATE TYPE subscription_status AS ENUM ('active', 'expired', 'cancelled');
CREATE TYPE entitlement_kind AS ENUM ('report', 'compat', 'solar');
CREATE TYPE entitlement_status AS ENUM ('active', 'refunded');
CREATE TYPE quota_code AS ENUM ('forecast_daily', 'ask_daily', 'report_month', 'compat_month');

-- Зеркало packages/shared/src/plans.ts. Цены правятся только в plans.ts
-- и накатываются сидом (`pnpm db:seed`), а не руками в проде.
CREATE TABLE plans (
  code               text PRIMARY KEY,
  kind               plan_kind NOT NULL,
  subscription_plan  text NOT NULL,
  stars              integer NOT NULL CHECK (stars > 0),
  -- NULL для разового товара
  period_seconds     integer CHECK (period_seconds IS NULL OR period_seconds > 0),
  title              text NOT NULL,
  description        text NOT NULL,
  price_label        text NOT NULL,
  sort               integer NOT NULL,
  is_active          boolean NOT NULL DEFAULT true,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT plans_period_matches_kind CHECK (
    (kind = 'subscription' AND period_seconds IS NOT NULL)
    OR (kind = 'one_off' AND period_seconds IS NULL)
  )
);

CREATE TABLE invoices (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL,
  plan_code    text NOT NULL REFERENCES plans (code),
  -- idemK из payload: защита от двойного тапа (payments.md §5)
  idem_key     uuid NOT NULL,
  -- Сырой invoice_payload, ≤ 128 байт: plan, userId, idemK. Без ПДн.
  payload      text NOT NULL,
  invoice_link text NOT NULL,
  status       invoice_status NOT NULL DEFAULT 'created',
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, idem_key)
);

CREATE INDEX invoices_user_created_idx ON invoices (user_id, created_at DESC);
CREATE INDEX invoices_collector_idx ON invoices (status, created_at) WHERE status = 'created';

CREATE TABLE payments (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Псевдонимный ключ субъекта, без FK (см. шапку файла)
  user_id                    uuid,
  -- Нужен Telegram для refundStarPayment. Обнуляется при DELETE /me.
  telegram_id                bigint,
  plan_code                  text NOT NULL REFERENCES plans (code),
  currency                   text NOT NULL DEFAULT 'XTR' CHECK (currency = 'XTR'),
  total_amount               integer NOT NULL CHECK (total_amount > 0),
  -- Ключ идемпотентности повторной доставки successful_payment
  telegram_payment_charge_id text NOT NULL UNIQUE,
  provider_payment_charge_id text,
  invoice_payload            text,
  status                     payment_status NOT NULL DEFAULT 'paid',
  -- Нижняя граница: платёж учтён в доступах
  processed                  boolean NOT NULL DEFAULT false,
  -- subscription_expiration_date из successful_payment
  subscription_expires_at    timestamptz,
  paid_at                    timestamptz NOT NULL DEFAULT now(),
  refunded_at                timestamptz,
  anonymized_at              timestamptz,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payments_refund_consistency CHECK (
    (status = 'refunded') = (refunded_at IS NOT NULL)
  )
);

CREATE INDEX payments_user_paid_idx ON payments (user_id, paid_at DESC);
CREATE INDEX payments_unprocessed_idx ON payments (paid_at) WHERE processed = false;

CREATE TRIGGER payments_set_updated_at
  BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Одна строка на пользователя: текущее состояние подписки.
CREATE TABLE subscriptions (
  user_id                    uuid PRIMARY KEY,
  plan                       text NOT NULL CHECK (plan IN ('trial', 'week', 'month', 'year')),
  status                     subscription_status NOT NULL DEFAULT 'active',
  expires_at                 timestamptz NOT NULL,
  -- Значение из настроек Telegram, только для чтения (payments.md §3.4)
  auto_renew                 boolean NOT NULL DEFAULT true,
  telegram_payment_charge_id text,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX subscriptions_expiring_idx ON subscriptions (expires_at)
  WHERE status = 'active';

CREATE TRIGGER subscriptions_set_updated_at
  BEFORE UPDATE ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Разовые покупки. Переживают DELETE /me вместе с подпиской.
CREATE TABLE entitlements (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL,
  kind              entitlement_kind NOT NULL,
  status            entitlement_status NOT NULL DEFAULT 'active',
  -- К какой карте относится (для report/compat); NULL для solar
  chart_id          uuid REFERENCES charts (id) ON DELETE SET NULL,
  partner_chart_id  uuid REFERENCES charts (id) ON DELETE SET NULL,
  payment_id        uuid REFERENCES payments (id) ON DELETE SET NULL,
  granted_at        timestamptz NOT NULL DEFAULT now(),
  -- NULL = навсегда (payments.md §1: разовый разбор остаётся навсегда)
  expires_at        timestamptz,
  CONSTRAINT entitlements_compat_has_partner CHECK (
    kind <> 'compat' OR partner_chart_id IS NOT NULL
  )
);

CREATE INDEX entitlements_user_kind_idx ON entitlements (user_id, kind) WHERE status = 'active';

-- Использование квот. period_key — 'YYYY-MM-DD' для дневных, 'YYYY-MM' для месячных.
CREATE TABLE quotas (
  user_id     uuid NOT NULL,
  code        quota_code NOT NULL,
  period_key  text NOT NULL,
  used        integer NOT NULL DEFAULT 0 CHECK (used >= 0),
  reset_at    timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, code, period_key)
);

CREATE TRIGGER quotas_set_updated_at
  BEFORE UPDATE ON quotas
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
