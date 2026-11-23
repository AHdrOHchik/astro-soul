-- 0035_access_codes.sql
-- Итерация 39: коды доступа (партнёрская программа и подарки).
--
-- Код — это **право на выдачу**, а не право само по себе: активация создаёт
-- строку в `grants`. Поэтому здесь нет ни цен, ни планов — только «сколько
-- активаций, на сколько дней и до какого срока».
--
-- Две защиты от перевыдачи:
--   1) `max_activations` проверяется **атомарно** (`UPDATE … WHERE activations <
--      max_activations RETURNING`): два одновременных нажатия не могут занять
--      одно и то же место, как бы быстро они ни пришли;
--   2) `(code_id, user_id)` уникален: один человек активирует код один раз,
--      даже если у кода остались активации. Иначе «поделись кодом с друзьями»
--      превращается в «примени его к себе 30 раз».

CREATE TABLE IF NOT EXISTS access_codes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Читаемый код: 8 знаков из алфавита без похожих символов (0/O, 1/I/l).
  code            text NOT NULL UNIQUE CHECK (code ~ '^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$'),
  -- Что даёт код: подписку целиком или одноразовое право.
  kind            text NOT NULL CHECK (kind IN ('all_access', 'single_report', 'single_compat')),
  -- На сколько дней (для `all_access`). Для одноразовых — NULL.
  days            integer,
  max_activations integer NOT NULL CHECK (max_activations > 0),
  -- Сколько раз код уже активировали. Меняется только атомарным UPDATE.
  activations     integer NOT NULL DEFAULT 0 CHECK (activations >= 0),
  -- Кто выдал: партнёр, акция, «подарок другу». Свободный текст без ПДн.
  partner_name    text,
  is_active       boolean NOT NULL DEFAULT true,
  -- Срок действия самого кода (не права). NULL — бессрочный.
  expires_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT access_codes_all_access_days CHECK (kind <> 'all_access' OR days > 0),
  CONSTRAINT access_codes_activations_within_max CHECK (activations <= max_activations)
);

COMMENT ON TABLE access_codes IS
  'Коды доступа (итерация 39). Активация создаёт строку в grants, а не подписку';
COMMENT ON COLUMN access_codes.activations IS
  'Счётчик активаций; увеличивается только атомарно (UPDATE … WHERE activations < max_activations)';
COMMENT ON COLUMN access_codes.partner_name IS
  'Метка партнёра для админки. Не ПДн: имя компании или акции, не человека';

-- История активаций: кто и когда. Нужна и для «код уже активирован», и для
-- разбора «откуда у человека доступ».
CREATE TABLE IF NOT EXISTS access_code_activations (
  code_id      uuid NOT NULL REFERENCES access_codes (id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  activated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (code_id, user_id)
);

COMMENT ON TABLE access_code_activations IS
  'Активации кодов (итерация 39): один код — один раз на пользователя';

CREATE INDEX IF NOT EXISTS access_code_activations_user_idx
  ON access_code_activations (user_id, activated_at DESC);

-- Код, которым выдано право (партнёрский, подарочный, «первые 50»). FK
-- добавляется здесь, а не в 0034: на момент той миграции таблицы кодов нет.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'grants_code_fk') THEN
    ALTER TABLE grants
      ADD CONSTRAINT grants_code_fk
      FOREIGN KEY (code_id) REFERENCES access_codes (id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS grants_code_idx ON grants (code_id) WHERE code_id IS NOT NULL;
