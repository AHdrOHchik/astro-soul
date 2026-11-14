/**
 * QA-002, задача 3.2: критические состояния экрана ошибки без браузера.
 *
 * Проверяем не «красиво ли», а три вещи, которые ломают доверие и деньги:
 *   1) `409 CONFLICT` (зависшая оплата) даёт пользователю путь решения —
 *      и этот путь ведёт к живому контакту поддержки, а не в тупик;
 *   2) `401` внутри Telegram не предлагает «закрой и открой» без выхода;
 *   3) английский текст фреймворка на экран не попадает.
 *
 * Запуск: pnpm exec vitest run --config e2e/qa/vitest.config.ts
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../apps/web/src/api/errors';
import { ErrorState } from '../../apps/web/src/components/ErrorState';

const telegramInside = { isTelegram: true, close: vi.fn() };
const telegramOutside = { isTelegram: false, close: vi.fn() };

/** Тот же `ApiError`, что собирает `apps/web/src/api/http.ts` из ответа сервера. */
function problem(code: string, status: number, extra: { message?: string; details?: Record<string, unknown> } = {}) {
  return new ApiError(code as never, {
    status,
    serverMessage: extra.message,
    details: extra.details,
    requestId: 'qa-req-1',
  });
}

describe('QA: экран ошибки', () => {
  it('409 CONFLICT не оставляет пользователя без выхода: кнопка поддержки есть', () => {
    render(<ErrorState error={problem('CONFLICT', 409)} telegram={telegramInside} />);
    // Пользователь видит, что случилось…
    expect(screen.getByRole('alert')).toBeTruthy();
    // …и, по заданию 002, должен видеть путь решения. Ищем любую ссылку/кнопку,
    // ведущую в поддержку: её пока нет — это и есть находка, тест фиксирует её.
    const support = screen.queryByRole('link', { name: /поддержк|написать/i })
      ?? screen.queryByRole('button', { name: /поддержк|написать/i });
    expect(support, 'на 409 нет кнопки «Написать в поддержку»').not.toBeNull();
  });

  it('409 CONFLICT не предлагает «повторить»: ждать бессмысленно', () => {
    const onRetry = vi.fn();
    render(<ErrorState error={problem('CONFLICT', 409)} telegram={telegramInside} onRetry={onRetry} />);
    expect(screen.queryByRole('button', { name: /повторить/i })).toBeNull();
  });

  it('401 внутри Telegram даёт выход, а не только текст', () => {
    render(<ErrorState error={problem('UNAUTHORIZED', 401)} telegram={telegramInside} />);
    expect(screen.getByRole('alert').textContent).toContain('Сессия');
    const buttons = screen.queryAllByRole('button').map((b) => b.textContent ?? '');
    expect(buttons.length, 'на 401 нет ни одной кнопки').toBeGreaterThan(0);
  });

  it('вне Telegram 401 объясняет, что открыть приложение нужно в Telegram', () => {
    render(<ErrorState error={problem('UNAUTHORIZED', 401)} telegram={telegramOutside} />);
    expect(screen.getByRole('alert').textContent).toContain('Telegram');
  });

  it('английский текст фреймворка на экран не попадает', () => {
    render(
      <ErrorState
        error={problem('INTERNAL', 500, { message: 'Cannot POST /api/v1/charts' })}
        telegram={telegramInside}
      />,
    );
    expect(screen.getByRole('alert').textContent).not.toContain('Cannot POST');
  });

  it('request_id показан: поддержке есть что спросить', () => {
    render(<ErrorState error={problem('INTERNAL', 500)} telegram={telegramInside} />);
    // `StateView` кладёт подпись в `aria-describedby`, а не в текст заголовка.
    const alert = screen.getByRole('alert');
    const describedBy = alert.getAttribute('aria-describedby') ?? '';
    const caption = describedBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ');
    const text = `${alert.textContent ?? ''} ${caption} ${document.body.textContent ?? ''}`;
    expect(text).toContain('qa-req-1');
  });
});
