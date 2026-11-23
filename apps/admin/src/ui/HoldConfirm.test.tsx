/*
 * Компонентная проверка главного запрета: действие не выполняется без второго
 * шага — независимо от того, что у кнопки стоит `onClick`.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HoldConfirm } from './HoldConfirm';

const T0 = 1_700_000_000_000;

describe('HoldConfirm', () => {
  /** Часы сдвигаются, а не ждут: тест на паузу не должен длиться две секунды. */
  const advance = (ms: number): void => {
    vi.mocked(Date.now).mockReturnValue(T0 + ms);
  };

  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(T0);
  });

  afterEach(() => vi.restoreAllMocks());

  it('одно нажатие не вызывает onExecute', () => {
    const onExecute = vi.fn();
    render(<HoldConfirm label="Отозвать право" onExecute={onExecute} />);

    fireEvent.click(screen.getByRole('button', { name: 'Отозвать право' }));
    expect(onExecute).not.toHaveBeenCalled();
  });

  it('второе нажатие раньше паузы тоже не выполняет', () => {
    const onExecute = vi.fn();
    render(<HoldConfirm label="Отозвать право" onExecute={onExecute} />);
    const button = () => screen.getByRole('button', { name: /Подожди ещё|Отозвать право|Подтвердить ещё раз/ });

    fireEvent.click(button());
    advance(1_999);
    fireEvent.click(button());
    expect(onExecute).not.toHaveBeenCalled();
  });

  it('после паузы выполняет ровно один раз', async () => {
    const onExecute = vi.fn(() => Promise.resolve());
    render(<HoldConfirm label="Отозвать право" onExecute={onExecute} />);

    fireEvent.click(screen.getByRole('button', { name: 'Отозвать право' }));
    advance(2_100);
    fireEvent.click(screen.getByRole('button', { name: /Подожди ещё|Подтвердить ещё раз/ }));

    await screen.findByRole('button', { name: 'Отозвать право' });
    expect(onExecute).toHaveBeenCalledOnce();
  });

  it('пока идёт запрос — кнопки заблокированы, повтор не проходит', () => {
    const onExecute = vi.fn();
    render(<HoldConfirm label="Отозвать право" onExecute={onExecute} busy />);

    expect(screen.getByRole('button', { name: 'Загрузка…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Отмена' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Загрузка…' }));
    expect(onExecute).not.toHaveBeenCalled();
  });
});
