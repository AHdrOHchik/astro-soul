/*
 * Чистые правила экранов «Тарифы» и «Пользователи» тестируются без React:
 * именно здесь живут запреты («ровно один параметр поиска», «правка без
 * основания невозможна», «эхо = серверное число»), и проверять их надо в том
 * месте, где они решаются, а не там, где рисуются.
 */

import { describe, expect, it } from 'vitest';
import type { AdminPlanRow } from '../api/types';
import { buildUsersSearch, checkPriceForm, echoMatches, planEditLocked } from './plansUsers';

const plan = (overrides: Partial<AdminPlanRow> = {}): AdminPlanRow => ({
  code: 'month_399',
  title: 'Месяц',
  price_stars: 399,
  discount_price_stars: null,
  is_active: true,
  test_only: false,
  founder_only: false,
  price_change_scope: 'only_new_purchases',
  version: 7,
  updated_at: '2026-11-18T00:00:00.000Z',
  updated_by_name: 'Владелец',
  updated_by_tg_id: '777001',
  ...overrides,
});

describe('поиск пользователей', () => {
  it('ровно один параметр: режим решает, что уйдёт в запрос', () => {
    expect(buildUsersSearch('telegram_id', ' 777003 ')).toEqual({ ok: true, params: { telegram_id: '777003' } });
    expect(buildUsersSearch('alias', '@anna_chart')).toEqual({ ok: true, params: { alias: 'anna_chart' } });
    expect(buildUsersSearch('q', 'Мария')).toEqual({ ok: true, params: { q: 'Мария' } });
  });

  it('пустое значение и нелепый telegram_id отбиваются до запроса', () => {
    expect(buildUsersSearch('q', '   ')).toEqual({ ok: false, error: 'empty' });
    expect(buildUsersSearch('telegram_id', '77a03')).toEqual({ ok: false, error: 'telegram_digits' });
    expect(buildUsersSearch('alias', '@@@')).toEqual({ ok: false, error: 'empty' });
  });
});

describe('форма цены', () => {
  it('без основания правка невалидна — даже при верных числах', () => {
    const check = checkPriceForm({ price: '349', discount: '', comment: '  ' }, plan());
    expect(check.changed).toBe(true);
    expect(check.valid).toBe(false);
  });

  it('цена без изменений не отправляется', () => {
    const check = checkPriceForm({ price: '399', discount: '', comment: 'просто так' }, plan());
    expect(check.changed).toBe(false);
    expect(check.valid).toBe(false);
  });

  it('скидка обязана быть меньше цены, а цена — целой', () => {
    expect(checkPriceForm({ price: '349', discount: '400', comment: 'акция' }, plan()).valid).toBe(false);
    expect(checkPriceForm({ price: '349.5', discount: '', comment: 'акция' }, plan()).valid).toBe(false);
    expect(checkPriceForm({ price: '349', discount: '299', comment: 'акция' }, plan()).valid).toBe(true);
  });
});

describe('запертые тарифы', () => {
  it('founder_only блокирует правку независимо от всего остального', () => {
    expect(planEditLocked(plan({ founder_only: true }))).toBe(true);
    expect(planEditLocked(plan({ founder_only: false }))).toBe(false);
  });
});

describe('эхо-подтверждение', () => {
  it('считает неразрывные пробелы форматированием, а не другим числом', () => {
    expect(echoMatches('2\u00a0990', 2990)).toBe(true);
    expect(echoMatches('2 990', 2990)).toBe(false);
    expect(echoMatches('299 ', 299)).toBe(true);
    expect(echoMatches('', 299)).toBe(false);
  });
});
