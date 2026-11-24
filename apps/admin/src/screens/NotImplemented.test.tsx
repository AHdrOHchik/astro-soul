import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { NotImplemented } from './NotImplemented';
import { missingRoutesFor, type ScreenKey } from '../api/routes';

// С 1.6.17 «Основатели» и «Эксплуатация» больше не заглушки: все их маршруты
// пришли в контракт, и экран обязан показывать данные, а не список того, чего
// нет. Если такой экран снова окажется здесь, `missingRoutesFor` вернёт пусто и
// тест упадёт на `toBeGreaterThan(0)` — то есть вернуть его в заглушки молча
// нельзя.
const SCREENS: readonly { key: ScreenKey; title: string }[] = [
  { key: 'users', title: 'Пользователи' },
  { key: 'payments', title: 'Платежи и генерации' },
  { key: 'plans', title: 'Тарифы' },
];

/**
 * «Аудит» в этом списке больше нет: его маршрут пришёл в 1.6.15, и экран
 * настоящий. Заглушка для него теперь была бы враньём — проверяем, что её нет.
 */

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

  it('аудит больше не заглушка', () => {
    expect(missingRoutesFor('audit')).toHaveLength(0);
  });
});
