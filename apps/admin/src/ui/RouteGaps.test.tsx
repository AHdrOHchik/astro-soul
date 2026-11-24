/*
 * «Чего здесь нет и почему». Компонент маленький, но за ним стоит обещание:
 * список пробелов выводится из реестра маршрутов, а не пишется словами в
 * экране. Значит, строка исчезает ровно тогда, когда маршрут появляется в
 * `api.openapi.yaml` (это проверяет `src/api/routes.contract.test.ts`), и здесь
 * проверяется вторая половина — что на экране показан именно реестр:
 *   • строки ровно те же, что вернул `missingRoutesFor`, и в том же порядке;
 *   • адрес на экране — `routeLabel` записи, а не пересказ «на слух»;
 *   • у экрана без пробелов блока нет вовсе: «пробелов нет» — это не повод
 *     показывать пустую таблицу;
 *   • список ничего не предлагает нажать: кнопки «запросить вручную» здесь
 *     нет и быть не может.
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { missingRoutesFor, routeLabel } from '../api/routes';
import { RouteGaps } from './RouteGaps';

function rows(): { route: string; why: string }[] {
  return Array.from(document.querySelectorAll('tbody tr')).map((row) => {
    const [route, why] = Array.from(row.querySelectorAll('td'));
    return { route: route?.textContent ?? '', why: why?.textContent ?? '' };
  });
}

describe('Список маршрутов, которых нет в контракте', () => {
  it('показаны ровно записи реестра — адресами сервера, а не пересказом', () => {
    render(<RouteGaps screen="payments" anchor="gaps" />);

    const expected = missingRoutesFor('payments');
    const shown = rows();
    expect(shown).toHaveLength(expected.length);
    expect(shown.map((row) => row.route)).toEqual(expected.map((item) => routeLabel(item)));
    // Причина — текст записи реестра: экран не пересказывает её своими словами.
    expect(shown.map((row) => row.why)).toEqual(expected.map((item) => item.why));
    expect(screen.getByRole('heading', { level: 2, name: 'Чего здесь нет и почему' })).toBeInTheDocument();
  });

  it('адреса в списке — действительно те, что не нашлись в контракте', () => {
    render(<RouteGaps screen="users" anchor="users-gaps" />);

    const shown = rows();
    expect(shown.map((row) => row.route)).toEqual(['POST /api/v1/admin/users/bulk']);
    // Тот же адрес в реестре помечен «нет в контракте» — иначе список врёт.
    const [gap] = missingRoutesFor('users');
    expect(gap?.key).toBe('usersBulk');
    expect(gap?.inContract).toBe(false);
    // И это не «забыли включить»: у пробела названа причина.
    expect(shown[0]?.why).toContain('каждое действие с деньгами обязано быть одиночным');
  });

  it('у экрана без пробелов блока нет — пустая таблица «пробелов нет» не показывается', () => {
    const { container } = render(<RouteGaps screen="overview" anchor="overview-gaps" />);

    expect(container).toBeEmptyDOMElement();
    expect(missingRoutesFor('overview')).toHaveLength(0);
  });

  it('список ничего не предлагает нажать: ни кнопок, ни ссылок', () => {
    render(<RouteGaps screen="plans" anchor="plans-gaps" />);

    expect(screen.getAllByRole('row')).toHaveLength(2); // шапка + единственная строка
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.queryAllByRole('link')).toHaveLength(0);
    expect(screen.getByText('POST /api/v1/admin/plans')).toBeInTheDocument();
    expect(screen.getByText(/завести тариф — работа миграции, не кнопки/i)).toBeInTheDocument();
  });
});
