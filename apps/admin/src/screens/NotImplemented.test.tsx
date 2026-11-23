import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { NotImplemented } from './NotImplemented';
import { missingRoutesFor, type ScreenKey } from '../api/routes';

const SCREENS: readonly { key: ScreenKey; title: string }[] = [
  { key: 'users', title: 'Пользователи' },
  { key: 'payments', title: 'Платежи и генерации' },
  { key: 'plans', title: 'Тарифы' },
  { key: 'founders', title: 'Основатели и партнёры' },
  { key: 'ops', title: 'Эксплуатация' },
  { key: 'audit', title: 'Аудит' },
];

describe('экраны без серверных маршрутов', () => {
  afterEach(cleanup);

  it.each(SCREENS)('%s: список отсутствующих маршрутов и ни одной таблицы данных', async ({ key, title }) => {
    render(<NotImplemented screen={key} title={title} />);

    expect(await screen.findByText('Экран не реализован')).toBeInTheDocument();
    expect(screen.getByText(title)).toBeInTheDocument();

    const missing = missingRoutesFor(key);
    expect(missing.length).toBeGreaterThan(0);
    for (const item of missing) {
      // Маршрут назван ровно один раз в списке и один раз в таблице «зачем».
      expect(screen.getAllByText(`${item.method} ${item.path}`).length).toBeGreaterThan(0);
    }
    // «Не отрисовывать данные» проверяется структурно: на заглушке нет ни
    // строк таблицы, ни плашек-цифр — только тексты про отсутствие маршрутов.
    expect(document.querySelectorAll('.stat')).toHaveLength(0);
    expect(document.querySelectorAll('tbody tr').length).toBe(missing.length);
  });
});
