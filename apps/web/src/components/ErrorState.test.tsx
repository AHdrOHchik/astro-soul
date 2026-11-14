import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ru } from '../i18n/ru';
import { apiError, fakeTelegram } from '../test/fixtures';
import { ErrorState } from './ErrorState';

describe('ErrorState', () => {
  it('shows the message the server wrote for the user', () => {
    const error = apiError('UNAUTHORIZED', {
      status: 401,
      serverMessage: 'Не удалось подтвердить вход. Откройте приложение заново.',
      requestId: 'b946a38b',
    });
    render(<ErrorState error={error} telegram={fakeTelegram()} />);

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(ru.errors.UNAUTHORIZED.title);
    expect(alert).toHaveTextContent('Не удалось подтвердить вход. Откройте приложение заново.');
    expect(alert).not.toHaveTextContent(ru.errors.UNAUTHORIZED.text);
    expect(screen.getByText(ru.common.requestId('b946a38b'))).toBeInTheDocument();
  });

  it('keeps a message that is not Russian text off the screen and uses its own wording', () => {
    // Not the API's own answer: the wording of a server framework for a route it does not have.
    const error = apiError('NOT_FOUND', { status: 404, serverMessage: 'Cannot POST /api/v1/geo/resolve', requestId: '141f950f' });
    render(<ErrorState error={error} telegram={fakeTelegram()} />);

    const alert = screen.getByRole('alert');
    expect(alert).not.toHaveTextContent('Cannot POST');
    expect(alert).toHaveTextContent(ru.errors.NOT_FOUND.title);
    expect(alert).toHaveTextContent(ru.errors.NOT_FOUND.text);
    // The request id still lets support find the call.
    expect(screen.getByText(ru.common.requestId('141f950f'))).toBeInTheDocument();
  });

  it('offers a retry when the geodata provider is down: that passes, unlike a place that does not exist', () => {
    const onRetry = vi.fn();
    render(<ErrorState error={apiError('GEO_NOT_FOUND', { status: 503 })} telegram={fakeTelegram()} onRetry={onRetry} />);

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(ru.errors.GEO_NOT_FOUND.title);
    expect(alert).toHaveTextContent(ru.errors.GEO_NOT_FOUND.text);
    expect(screen.getByRole('button', { name: ru.common.retry })).toBeInTheDocument();
  });

  it('offers no retry for input the server rejected: the same request fails the same way', () => {
    render(<ErrorState error={apiError('VALIDATION_FAILED', { status: 422 })} telegram={fakeTelegram()} onRetry={vi.fn()} />);

    expect(screen.getByRole('alert')).toHaveTextContent(ru.errors.VALIDATION_FAILED.text);
    expect(screen.queryByRole('button', { name: ru.common.retry })).not.toBeInTheDocument();
  });

  describe('a conflict (409)', () => {
    const conflict = apiError('CONFLICT', { status: 409, serverMessage: 'Разбор по этой карте уже заказан.', requestId: 'req-409' });

    it('never leaves the user with a text alone: the server\'s words, the way to support, and no «retry»', async () => {
      const telegram = fakeTelegram();
      render(<ErrorState error={conflict} telegram={telegram} supportLink="https://t.me/astro_soul_help" onRetry={vi.fn()} />);

      expect(screen.getByRole('alert')).toHaveTextContent('Разбор по этой карте уже заказан.');
      // Waiting does not move what is in the way: the same request would fail the same way.
      expect(screen.queryByRole('button', { name: ru.common.retry })).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: ru.support.write }));
      expect(telegram.openLink).toHaveBeenCalledWith('https://t.me/astro_soul_help');
    });

    it('without a contact the button is there all the same, disabled and saying that support is coming', () => {
      // No link named: the one the app was built with, and a test build has none.
      render(<ErrorState error={conflict} telegram={fakeTelegram()} />);

      expect(screen.getByRole('button', { name: ru.support.soon })).toBeDisabled();
      expect(screen.queryByRole('button', { name: ru.support.write })).not.toBeInTheDocument();
    });

    it('is the only failure that gets the support button by itself', () => {
      render(<ErrorState error={apiError('INTERNAL', { status: 500 })} telegram={fakeTelegram()} supportLink="https://t.me/astro_soul_help" />);

      expect(screen.queryByRole('button', { name: ru.support.write })).not.toBeInTheDocument();
    });
  });
});
