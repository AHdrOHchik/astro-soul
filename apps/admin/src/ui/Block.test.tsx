/*
 * Три состояния, которые панель обязана различать: «нет маршрута», «нет данных»
 * и «ошибка». Различает их не текст, а поведение: в первом случае children не
 * вызывается вовсе (значит ни таблиц, ни нулей, ни «0 активных кодов» на экране
 * нет), во втором — вызывается на пустом списке и экран пишет «пусто», в третьем
 * — есть чем повторить.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Block } from './Block';
import { ApiError } from '../api/errors';
import { failed, loading, ok, unavailable } from '../api/state';

const rows = [{ id: 'c1' }];

describe('состояния блока данных', () => {
  afterEach(cleanup);

  it('пока запрос идёт — только «Загрузка…», без детей', () => {
    const children = vi.fn(() => <div data-testid="table" />);
    render(<Block state={loading<readonly unknown[]>()}>{children}</Block>);

    expect(screen.getByText('Загрузка…')).toBeInTheDocument();
    expect(children).not.toHaveBeenCalled();
  });

  it('нет маршрута: список маршрутов показан, данных на экране нет', () => {
    const children = vi.fn(() => <div data-testid="table" />);
    render(
      <Block state={unavailable<readonly unknown[]>('usersSearch', 'userCard')} onReload={vi.fn()}>
        {children}
      </Block>,
    );

    expect(screen.getByText('Недоступно в этой версии')).toBeInTheDocument();
    expect(screen.getByText('Нет серверных маршрутов:')).toBeInTheDocument();
    expect(screen.getByText('GET /api/v1/admin/users')).toBeInTheDocument();
    expect(screen.getByText('Данные не отрисовываются: показывать нечего, выдумывать их нельзя.')).toBeInTheDocument();
    expect(children).not.toHaveBeenCalled();
    // Повтор тут бессмыслен: маршрут не появится от перезапроса.
    expect(screen.queryByRole('button', { name: 'Повторить' })).toBeNull();
  });

  it('нет маршрута без списка маршрутов — без пустого раздела «нет серверных маршрутов»', () => {
    render(<Block state={{ kind: 'unavailable', routes: [] }}>{() => <div />}</Block>);

    expect(screen.getByText('Недоступно в этой версии')).toBeInTheDocument();
    expect(screen.queryByText('Нет серверных маршрутов:')).toBeNull();
  });

  it('нет данных: дети не рисуются, но это «пусто», а не ошибка', () => {
    const children = vi.fn(() => <div data-testid="table" />);
    render(
      <Block state={ok<readonly unknown[]>([])} empty="Кодов ещё нет." isEmpty={(items) => items.length === 0}>
        {children}
      </Block>,
    );

    expect(screen.getByText('Кодов ещё нет.')).toBeInTheDocument();
    expect(children).not.toHaveBeenCalled();
    expect(screen.queryByText('Ошибка запроса')).toBeNull();
  });

  it('пустое состояние по умолчанию подписано общим текстом', () => {
    render(<Block state={ok<readonly unknown[]>([])} isEmpty={(items) => items.length === 0}>{() => <div />}</Block>);
    expect(screen.getByText('Пусто')).toBeInTheDocument();
  });

  it('данные есть — на экране дети', () => {
    render(
      <Block state={ok<readonly { id: string }[]>(rows)} isEmpty={(items) => items.length === 0}>
        {(items) => <ul>{items.map((item) => <li key={item.id}>{item.id}</li>)}</ul>}
      </Block>,
    );

    expect(screen.getByText('c1')).toBeInTheDocument();
  });

  it('ошибка: код, request_id и поле-причина — то, с чем идут в бэкенд', () => {
    const onReload = vi.fn();
    render(
      <Block
        state={failed<readonly unknown[]>(
          new ApiError({
            code: 'VALIDATION_FAILED',
            status: 422,
            message: 'Код не создан.',
            requestId: 'req-77',
            route: 'POST /api/v1/admin/codes',
            fieldErrors: [{ field: 'max_activations', message: 'Нужно целое ≥ 1' }],
          }),
        )}
        onReload={onReload}
      >
        {() => <div />}
      </Block>,
    );

    expect(screen.getByText(/Код не создан\./)).toBeInTheDocument();
    expect(screen.getByText(/VALIDATION_FAILED · request_id req-77/)).toBeInTheDocument();
    // Поле и причина: `<span class="mono">поле</span>: причина` — testing-library
    // сравнивает текст узла без вложенных элементов, поэтому проверяем оба куска.
    expect(screen.getByText('max_activations')).toBeInTheDocument();
    expect(screen.getByText(/Нужно целое ≥ 1/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    expect(onReload).toHaveBeenCalledOnce();
  });

  it('401 — не красная авария, а «Сессии нет», 403 — про ADMIN_TG_ID', () => {
    const { rerender } = render(
      <Block state={failed<readonly unknown[]>(new ApiError({ code: 'UNAUTHORIZED', status: 401, message: 'нет сессии', route: 'GET /api/v1/admin/codes' }))}>
        {() => <div />}
      </Block>,
    );
    expect(screen.getByText('Сессии нет. Войди через Telegram.')).toBeInTheDocument();
    expect(screen.queryByText(/Ошибка запроса/)).toBeNull();

    rerender(
      <Block state={failed<readonly unknown[]>(new ApiError({ code: 'FORBIDDEN', status: 403, message: 'не админ', route: 'GET /api/v1/admin/codes' }))}>
        {() => <div />}
      </Block>,
    );
    expect(screen.getByText(/ADMIN_TG_ID/)).toBeInTheDocument();
  });

  it('сеть: у ошибки нет request_id — панель не выдумывает его', () => {
    render(
      <Block state={failed<readonly unknown[]>(new ApiError({ code: 'NETWORK', status: null, message: 'API не отвечает', route: 'GET /api/v1/health' }))}>
        {() => <div />}
      </Block>,
    );

    expect(screen.getByText(/API не отвечает/)).toBeInTheDocument();
    expect(screen.queryByText(/request_id/)).toBeNull();
  });
});
