import { describe, expect, it } from 'vitest';
import { formatReport, parseArgs, type DiagnoseReport } from '../scripts/payments-diagnose';

/**
 * Итерация 26: диагностика должна быть читаемой человеком.
 *
 * Проверяем формат, а не сеть: `payments:diagnose` идёт в Bot API и в БД, а вот
 * «видно ли в выводе название счёта, его длину и что делать» — это свойство
 * чистых функций.
 */

function report(overrides: Partial<DiagnoseReport> = {}): DiagnoseReport {
  return {
    bot: { reachable: true, id: 1, username: 'astro_bot', latency_ms: 42, error: null },
    webhook: {
      state: 'ok',
      description: 'вебхук зарегистрирован на ожидаемый адрес',
      hint: null,
      expected_url_masked: 'https://example.com/api/v1/internal/telegram/webhook/***cret',
      actual_url_masked: 'https://example.com/api/v1/internal/telegram/webhook/***cret',
      pending_update_count: 0,
      last_error_message: null,
      last_error_date: null,
    },
    catalogue: [
      {
        code: 'month_399',
        invoice_title: 'Подписка на месяц',
        invoice_title_chars: 17,
        title_chars: 35,
        period_seconds: 2_592_000,
        problem: null,
        severity: null,
      },
    ],
    periods: null,
    money: null,
    ...overrides,
  };
}

describe('payments:diagnose — аргументы', () => {
  it('флаги складываются, а не перекрывают друг друга', () => {
    expect(parseArgs(['--periods', '--json'])).toEqual({
      periods: true,
      json: true,
      setWebhook: false,
      db: true,
    });
    expect(parseArgs(['--no-db', '--set-webhook'])).toMatchObject({ db: false, setWebhook: true });
  });

  it('неизвестный флаг — ошибка, а не молчаливое игнорирование', () => {
    expect(() => parseArgs(['--period'])).toThrow(/--period/);
  });
});

describe('payments:diagnose — вывод', () => {
  it('печатает invoice_title и его длину рядом с лимитом', () => {
    const text = formatReport(report());

    expect(text).toContain('invoice_title=«Подписка на месяц»');
    expect(text).toContain('(17/32)');
    // Название тарифа (35 символов) больше не то, что уходит в счёт: в
    // выводе именно название счёта, иначе диагностика показывает не то.
    expect(text).not.toContain('title=35');
  });

  it('ok помечается, а проблема — нет', () => {
    expect(formatReport(report())).toContain('✓ month_399');

    const broken = report({
      catalogue: [
        {
          code: 'test_report_1',
          invoice_title: 'Тестовый разбор — 1 звезда!',
          invoice_title_chars: 27,
          title_chars: 27,
          period_seconds: null,
          problem: 'title: 33 > лимита 32',
          severity: 'fail',
        },
      ],
    });

    expect(formatReport(broken)).toContain('✗ test_report_1');
    expect(formatReport(broken)).toContain('title: 33 > лимита 32');
  });

  it('нерезолвящийся вебхук печатает «что делать»', () => {
    const text = formatReport(
      report({
        webhook: {
          state: 'unreachable',
          description: 'адрес вебхука не резолвится',
          hint:
            'адрес MINI_APP_URL (tunnel.example.invalid) не резолвится: ENOTFOUND. ' +
            'Запусти туннель, проверь MINI_APP_URL и перезапусти API',
          expected_url_masked: 'https://tunnel.example.invalid/api/v1/internal/telegram/webhook/***cret',
          actual_url_masked: null,
          pending_update_count: 0,
          last_error_message: null,
          last_error_date: null,
        },
      }),
    );

    expect(text).toContain('что делать: адрес MINI_APP_URL');
    expect(text).toContain('туннель');
  });

  it('живая проверка периодов печатает вердикт по каждому тарифу', () => {
    const text = formatReport(
      report({
        periods: [
          { code: 'month_399', period_seconds: 2_592_000, ok: true, status: 200, description: null },
          { code: 'test_1', period_seconds: 2_592_000, ok: true, status: 200, description: null },
        ],
      }),
    );

    expect(text).toMatch(/month_399\s+period=\s+2592000\s+→ ok/);
    expect(text).toMatch(/test_1\s+period=\s+2592000\s+→ ok/);
  });
});
