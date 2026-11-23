-- 0034_grants.sql
-- Итерация 39: бесплатный доступ по праву (контракт 1.6.14).
--
-- Зачем отдельная таблица, а не план с нулевой ценой и не строка в
-- `subscriptions`:
--
--   1) **План за 0 ⭐ — это то, что кто-то забудет выключить.** Прод-гард
--      проверяет только тестовые тарифы; нулевая строка в каталоге рано или
--      поздно станет продаваемой (или «подаренной») всем. Бесплатное право —
--      строка в `grants` с обязательным `expires_at`, и она видна в аудите.
--   2) **Грант — не подписка.** `subscriptions` участвует в алерте
--      `subscription_cancel_no_charge_id_24h` («не смогли отменить — спишется»)
--      и в исходящих вызовах Telegram. Грант нечего отменять: у него нет
--      `charge_id` и автопродления. Писать гранты в `subscriptions` значило бы
--      в первый же день получить ложный critical-алерт.
--
-- Три источника права: `partner` (партнёрский код), `founder` (первые 50),
-- `referral` (приглашённый друг). Плюс `admin` — ручная выдача через
-- `POST /admin/grants`.

-- Пользователь, пришедший по `start=ref_<short>`. Хранится до появления
-- `referrals`-строки: на момент `/start` аккаунта ещё нет (его создаёт первая
-- авторизация мини-аппа), а пригласившего надо запомнить. Отдельная колонка,
-- а не строка `referrals` с NULL в `referred_id`: NOT NULL там честнее.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS referred_by uuid REFERENCES users (id) ON DELETE SET NULL;

COMMENT ON COLUMN users.referred_by IS
  'Кто пригласил (итерация 39). Награда начисляется только после карты приглашённого';

-- Короткий идентификатор для ссылки `t.me/<bot>?start=ref_<short>`.
-- Генерируется лениво (при первом `GET /me`), уникален: ссылка — не ПДн,
-- потому что за ней нет ни telegram_id, ни имени.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS referral_short_id text;

CREATE UNIQUE INDEX IF NOT EXISTS users_referral_short_idx
  ON users (referral_short_id)
  WHERE referral_short_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS grants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- `all_access` — подписка целиком; `single_*` — одноразовое право.
  kind        text NOT NULL CHECK (kind IN ('all_access', 'single_report', 'single_compat')),
  source      text NOT NULL CHECK (source IN ('partner', 'founder', 'referral', 'admin')),
  -- Код, которым выдано (партнёрский или подарочный). FK на `access_codes`
  -- добавляется в 0035: таблицы кодов на момент этой миграции ещё нет.
  code_id     uuid,
  -- Сколько дней доступа даёт право (для `all_access`). Нужно, чтобы посчитать
  -- `expires_at`, когда срок начнётся позже — после первой карты.
  days        integer,
  -- Когда право начало действовать. NULL — активировано до карты и ждёт:
  -- человек не должен «сжигать» 30 дней, глядя на онбординг.
  starts_at   timestamptz,
  -- Конец срока. NULL только у ещё не начавшегося `all_access` и у
  -- одноразовых прав: одноразовое не истекает, оно расходуется (`consumed_at`).
  expires_at  timestamptz,
  -- Одноразовое право израсходовано. Не удаляем строку: нужна история выдачи.
  consumed_at timestamptz,
  -- Отзыв (админка или 152-ФЗ). Строка остаётся, доступ прекращается.
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),

  -- Срок обязателен для действующего `all_access` и необязателен для права,
  -- которое ждёт карту (`starts_at IS NULL`).
  CONSTRAINT grants_all_access_expiry CHECK (
    kind <> 'all_access' OR expires_at IS NOT NULL OR starts_at IS NULL
  ),
  -- Одноразовое право без `days` и без `expires_at`: срок у него не задаётся.
  CONSTRAINT grants_single_no_expiry CHECK (
    kind = 'all_access' OR expires_at IS NULL
  ),
  -- Дни обязательны для `all_access`: без них нечего продлевать и не из чего
  -- посчитать бюджет.
  CONSTRAINT grants_all_access_days CHECK (kind <> 'all_access' OR days > 0)
);

COMMENT ON TABLE grants IS
  'Бесплатный доступ по праву (итерация 39). Не подписка: без charge_id, без автопродления';
COMMENT ON COLUMN grants.starts_at   IS 'Когда право начало действовать; NULL — ждёт построения карты';
COMMENT ON COLUMN grants.consumed_at IS 'Когда израсходовано одноразовое право';
COMMENT ON COLUMN grants.revoked_at  IS 'Когда отозвано; строка не удаляется — история выдачи';

-- Одно **неотозванное** право «всё включено» на пользователя. Повторная выдача
-- не создаёт вторую строку, а продлевает срок (см. `GrantsService.issue`).
CREATE UNIQUE INDEX IF NOT EXISTS grants_one_all_access_idx
  ON grants (user_id)
  WHERE kind = 'all_access' AND revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS grants_user_idx ON grants (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS grants_source_created_idx ON grants (source, created_at);
-- «Есть ли у человека неиспользованное одноразовое право» — самый частый вопрос.
CREATE INDEX IF NOT EXISTS grants_unconsumed_idx
  ON grants (user_id, kind)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;

-- ── Основатели: первые 50 ───────────────────────────────────────────────────
--
-- Место (place) — это номер в списке, выдаётся атомарно под advisory lock:
-- два одновременных нажатия не должны получить одно место.
CREATE TABLE IF NOT EXISTS founders (
  user_id    uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  place      integer NOT NULL UNIQUE CHECK (place BETWEEN 1 AND 50),
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE founders IS
  'Первые 50 основателей (итерация 39). place — номер места, только для чтения клиенту';

-- ── Приглашения друзей ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS referrals (
  -- Один приглашённый — один пригласивший: повторные переходы по чужим
  -- ссылкам не должны превращаться в цепочку наград.
  referred_id      uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  referrer_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  joined_at        timestamptz NOT NULL DEFAULT now(),
  -- Награда начисляется только после карты приглашённого: до неё он мог
  -- зайти, посмотреть онбординг и уйти — платить за это нечем.
  chart_created_at timestamptz,
  rewarded_at      timestamptz,
  CONSTRAINT referrals_not_self CHECK (referrer_id <> referred_id)
);

COMMENT ON TABLE referrals IS
  'Приглашения (итерация 39). Награда — после карты приглашённого, один уровень';
COMMENT ON COLUMN referrals.rewarded_at IS
  'Когда пригласившему начислено; NULL — ещё не награждено (или не за что)';

CREATE INDEX IF NOT EXISTS referrals_referrer_idx ON referrals (referrer_id, joined_at DESC);
