import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
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
    // What the API answers for a route it does not have.
    const error = apiError('NOT_FOUND', { status: 404, serverMessage: 'Cannot POST /api/v1/geo/resolve', requestId: '141f950f' });
    render(<ErrorState error={error} telegram={fakeTelegram()} />);

    const alert = screen.getByRole('alert');
    expect(alert).not.toHaveTextContent('Cannot POST');
    expect(alert).toHaveTextContent(ru.errors.NOT_FOUND.title);
    expect(alert).toHaveTextContent(ru.errors.NOT_FOUND.text);
    // The request id still lets support find the call.
    expect(screen.getByText(ru.common.requestId('141f950f'))).toBeInTheDocument();
  });
});
