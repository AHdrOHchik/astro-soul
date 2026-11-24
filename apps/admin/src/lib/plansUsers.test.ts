/*
 * Чистые правила экранов «Тарифы» и «Пользователи» тестируются без React:
 * именно здесь живут запреты («ровно один параметр поиска», «правка без
 * основания невозможна», «эхо = серверное число»), и проверять их надо в том
 * месте, где они решаются, а не там, где рисуются.
 *
 * Тест написан против `AdminPlan` из контракта 1.6.16: полей `discount_price_stars`
 * и `updated_by_*` здесь нет не потому, что «мы их не проверяем», а потому, что
 * их нет у сервера — тест, который бы их касался, был бы проверкой выдумки.
 */

import { describe, expect, it } from 'vitest';
import type { AdminPayment, AdminPlan } from '../api/types';
import { buildUsersSearch, checkPriceForm, echoMatches, planPriceLocked, refundablePayments, retryAfterDuration, retryAfterText } from './plansUsers';

const plan = (overrides: Partial<AdminPlan> = {}): AdminPlan => ({
  code: 'month_399',
  kind: 'subscription',
  title: 'Месяц',
  price_stars: 399,
  period_days: 30,
  test_only: false,
  active: true,
  founder_only: false,
  version: 7,
  updated_at: '2026-11-18T00:00:00.000Z',
  ...overrides,
});

const payment = (overrides: Partial<AdminPayment> = {}): AdminPayment => ({
  charge_id: 'chg_9001',
  plan_code: 'month_399',
  amount_stars: 399,
  status: 'paid',
  is_test: false,
  paid_at: '2026-11-14T00:00:00.000Z',
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

describe('форма правки тарифа', () => {
  it('без основания правка невалидна — и блок именно про `comment`', () => {
    const check = checkPriceForm({ price: '349', comment: '  ', testOnly: false }, plan());
    expect(check.valid).toBe(false);
    expect(check.blocker).toBe('no_comment');
  });

  it('ничего не изменилось — нечего и отправлять (422 nothing_to_update создаём не мы)', () => {
    const check = checkPriceForm({ price: '399', comment: 'просто так', testOnly: false }, plan());
    expect(check.valid).toBe(false);
    expect(check.blocker).toBe('nothing_to_update');
  });

  it('цена — целое число; дробь и буквы не проходят', () => {
    expect(checkPriceForm({ price: '349.5', comment: 'акция', testOnly: false }, plan()).blocker).toBe('invalid_price');
    expect(checkPriceForm({ price: 'zero', comment: 'акция', testOnly: false }, plan()).blocker).toBe('invalid_price');
    // «0 ⭐» — не цена: у контракта `minimum: 1`.
    expect(checkPriceForm({ price: '0', comment: 'акция', testOnly: false }, plan()).blocker).toBe('invalid_price');
    expect(checkPriceForm({ price: '349', comment: 'акция', testOnly: false }, plan()).valid).toBe(true);
  });

  it('пустое поле цены — это «цену не трогаем», а не «цена 0»', () => {
    const check = checkPriceForm({ price: '', comment: 'флаг', testOnly: true }, plan());
    expect(check.valid).toBe(true);
    expect(check.priceStars).toBe(399);
    expect(check.testOnly).toBe(true);
  });

  it('снятие test_only требует confirm, установка — нет', () => {
    const off = checkPriceForm({ price: '399', comment: 'в продажу', testOnly: false }, plan({ test_only: true }));
    expect(off.valid).toBe(true);
    expect(off.needsConfirm).toBe(true);
    const on = checkPriceForm({ price: '399', comment: 'обратно в тест', testOnly: true }, plan({ test_only: false }));
    expect(on.needsConfirm).toBe(false);
  });

  it('цена основательского тарифа закрыта, флаг — нет', () => {
    const price = checkPriceForm({ price: '199', comment: 'попробовал', testOnly: false }, plan({ founder_only: true }));
    expect(price.blocker).toBe('founder_price_locked');
    const flag = checkPriceForm({ price: '250', comment: 'закрыть тариф', testOnly: true }, plan({ founder_only: true, price_stars: 250 }));
    expect(flag.valid).toBe(true);
  });
});

describe('запертые тарифы', () => {
  it('founder_only блокирует правку цены независимо от всего остального', () => {
    expect(planPriceLocked(plan({ founder_only: true }))).toBe(true);
    expect(planPriceLocked(plan({ founder_only: false }))).toBe(false);
  });
});

describe('платежи, по которым возможен возврат', () => {
  it('возвращают только оплаченный и зачисленный', () => {
    const rows = [
      payment({ charge_id: 'a', status: 'paid' }),
      payment({ charge_id: 'b', status: 'processed' }),
      payment({ charge_id: 'c', status: 'refunded', refunded_at: '2026-11-15T00:00:00.000Z' }),
      payment({ charge_id: 'd', status: 'failed' }),
    ];
    expect(refundablePayments(rows).map((item) => item.charge_id)).toEqual(['a', 'b']);
  });

  it('список может быть пустым — тогда на экране «возвращать нечего», а не форма', () => {
    expect(refundablePayments([])).toEqual([]);
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

describe('срок повторной попытки', () => {
  it('называет секунды, если сервер назвал; иначе — «правило не названо»', () => {
    expect(retryAfterText(45)).toBe('повтори через 45 с');
    expect(retryAfterText(600)).toBe('повтори через 10 мин');
    expect(retryAfterText(601)).toBe('повтори через 11 мин');
    expect(retryAfterText(null)).toBeNull();
    // Отдельная часть — срок без глагола: экранам нужна своя подпись.
    expect(retryAfterDuration(45)).toBe('45 с');
    expect(retryAfterDuration(600)).toBe('10 мин');
    expect(retryAfterDuration(601)).toBe('11 мин');
    // 0 и отрицательное — «срока нет», а не «повтори сейчас».
    expect(retryAfterDuration(0)).toBeNull();
    expect(retryAfterDuration(-5)).toBeNull();
    expect(retryAfterDuration(Number.NaN)).toBeNull();
  });
});
