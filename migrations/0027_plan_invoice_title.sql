-- 0027: короткое название для счёта — отдельная колонка `invoice_title`.
--
-- Почему не хватило `title`: это название тарифа, и оно же уходило в
-- `createInvoiceLink.title`, где у Bot API лимит 1–32 символа. Пока лимит
-- держался «на честном слове», три тарифа из семи не продавались вовсе:
-- `week_149` 36 символов, `month_399` 35, `year_2990` 33, `test_report_1` 33.
-- Telegram отвечал `400`, наш клиент превращал это в `502`, и человек видел
-- «не удалось создать счёт» (итерация 25 сузила `title`, но роль осталась
-- одна: любое будущее изменение названия тарифа снова ломало бы оплату).
--
-- Теперь роли разные и колонки разные:
--   • `paywall_title` — что видит человек на витрине (длинно, лимит не наш);
--   • `title`         — название тарифа для логов и админки;
--   • `invoice_title` — то, что уходит в счёт Telegram. 1–32 символа, и это
--                       гарантирует `CHECK`, а не договорённость.
--
-- Заполнение идемпотентно: строка обновляется только там, где названия ещё
-- нет, поэтому правка через `pnpm plans:set-titles` переживает любой повторный
-- деплой и миграцию.

ALTER TABLE plans ADD COLUMN IF NOT EXISTS invoice_title varchar(32);

-- Короткие названия для окон оплаты. Не косметика: в счёте Telegram название
-- видно целиком, и «Разбор личности: месяц» там читается хуже, чем
-- «Подписка на месяц».
UPDATE plans
   SET invoice_title = values_table.invoice_title,
       updated_at = now()
  FROM (VALUES
    ('one_149',       'Полный разбор'),
    ('week_149',      'Подписка на неделю'),
    ('month_399',     'Подписка на месяц'),
    ('year_2990',     'Подписка на год'),
    ('compat_249',    'Совместимость с партнёром'),
    ('solar_590',     'Карта года'),
    ('test_1',        'Тестовая подписка — 1 ⭐'),
    ('test_report_1', 'Тестовый разбор — 1 ⭐')
  ) AS values_table (code, invoice_title)
 WHERE plans.code = values_table.code
   AND (plans.invoice_title IS NULL OR plans.invoice_title = '');

-- Тариф, которого нет в списке выше (владелец завёл новый строкой), не должен
-- остаться без названия для счёта: если его `title` укладывается в лимит —
-- берём его. Если не укладывается, ниже сработает проверка и миграция
-- остановится с понятным текстом, а не «null value in column».
UPDATE plans
   SET invoice_title = title,
       updated_at = now()
 WHERE (invoice_title IS NULL OR invoice_title = '')
   AND char_length(title) BETWEEN 1 AND 32;

-- Данные, которые не проходят лимит, — ошибка каталога, а не повод выставить
-- счёт, который Telegram отвергнет. Сообщение говорит, что именно править.
DO $$
DECLARE
  broken text;
BEGIN
  SELECT string_agg(code || ' (' || coalesce(char_length(invoice_title), 0) || ')', ', ' ORDER BY code)
    INTO broken
    FROM plans
   WHERE invoice_title IS NULL
      OR char_length(invoice_title) NOT BETWEEN 1 AND 32;

  IF broken IS NOT NULL THEN
    RAISE EXCEPTION
      'plans: invoice_title должен быть 1–32 символа, не подходит: %. Задайте короткое название: pnpm plans:set-titles --code=<код> --title=<название>',
      broken;
  END IF;
END $$;

ALTER TABLE plans ALTER COLUMN invoice_title SET NOT NULL;

-- Лимит Bot API на уровне схемы: нарушить его правкой данных нельзя.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'plans_invoice_title_fits_telegram'
  ) THEN
    ALTER TABLE plans
      ADD CONSTRAINT plans_invoice_title_fits_telegram
      CHECK (char_length(invoice_title) BETWEEN 1 AND 32);
  END IF;
END $$;

COMMENT ON COLUMN plans.invoice_title IS
  'Название товара в окне оплаты Telegram (createInvoiceLink.title): 1–32 символа, CHECK. Витрина — paywall_title.';

-- Задача 2 итерации 26: тестовая подписка — 30 дней, а не неделя. Миграция
-- 0026 делала это же, но на стенде, где она не применялась, в базе осталось
-- 604 800, и `test_1` не выставлялся вовсе (Bot API принимает у звёздных
-- подписок только 2 592 000). Обновляем по коду и только подписку.
UPDATE plans
   SET period_seconds = 2592000,
       updated_at = now()
 WHERE code = 'test_1'
   AND kind = 'subscription'
   AND period_seconds IS DISTINCT FROM 2592000;

-- Тексты тестовой подписки тоже про период: «неделя» в описании счёта/витрины
-- противоречит 30 дням. `paywall_title` не трогаем — он не про срок.
UPDATE plans
   SET description = '30 дней доступа за 1 ⭐. Только для проверки оплаты владельцем',
       paywall_subtitle = '1 ⭐ за 30 дней доступа, права как у месячной. Только для проверки оплаты.',
       updated_at = now()
 WHERE code = 'test_1'
   AND description LIKE '%недел%';

UPDATE plans
   SET paywall_subtitle = '1 ⭐ за 30 дней доступа, права как у месячной. Только для проверки оплаты.',
       updated_at = now()
 WHERE code = 'test_1'
   AND paywall_subtitle LIKE '%недел%';
