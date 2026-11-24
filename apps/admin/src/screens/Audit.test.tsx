/*
 * «Аудит»: проверяется не «таблица нарисовалась», а запреты экрана.
 *
 *   • вторая страница берётся по `next_cursor`, а не по номеру — на живой ленте
 *     `offset` теряет и дублирует строки;
 *   • пустой `before`/`after` показывает «—», а не молчание и не `{}`;
 *   • отказ сервера читается текстом сервера (`422 invalid_limit`), панель
 *     ничего не смягчает и не подставляет;
 *   • фильтры живут в URL-хеше — срез можно переслать ссылкой.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAdminApi } from '../api/admin';
import type { AdminApi } from '../api/admin';
import { createHttp } from '../api/http';
import { createFetchLog, jsonResponse, only, problemResponse, type Call } from '../testing/fetchLog';
import { Audit } from './Audit';
import type { AuditEntry, AuditPage } from '../api/types';

function entry(over: Partial<AuditEntry> & { id: string }): AuditEntry {
  return {
    at: '2026-11-20T10:00:00.000Z',
    actor_tg_id: '777001',
    actor_name: 'Владелец',
    action: 'code.create',
    entity: 'code',
    entity_id: 'c-1',
    before: null,
    after: { max_activations: 5 },
    reason: 'партия к запуску',
    request_id: 'req-1',
    ...over,
  };
}

const page = (items: readonly AuditEntry[], nextCursor: string | null): AuditPage =>
  ({ items, next_cursor: nextCursor }) as AuditPage;

/** Ответы сервера по порядку вызовов; последний повторяется, если вызовов больше. */
function apiOf(pages: readonly (AuditPage | Response)[]): { api: AdminApi; calls: Call[] } {
  let index = 0;
  const log = createFetchLog(() => {
    const current = pages[Math.min(index, pages.length - 1)];
    index += 1;
    return current instanceof Response ? current : jsonResponse(current);
  });
  return { api: createAdminApi(createHttp({ fetchImpl: log.fetchImpl, retries: 0, csrfToken: () => null })), calls: log.calls };
}

const queriesOf = (calls: readonly Call[]): string[] => calls.map((call) => call.url.slice(call.url.indexOf('?') + 1));

describe('экран «Аудит»', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('обещание append-only видно всегда, кнопок правки и выгрузки нет', async () => {
    const { api } = apiOf([page([], null)]);
    render(<Audit api={api} query={{}} />);

    expect(await screen.findByText('Журнал только на добавление: изменить или удалить запись нельзя.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /изменить|удалить|редакт/i })).toBeNull();
    // CSV в этой итерации не делается — ни кнопки, ни ссылки на выгрузку.
    expect(screen.queryByRole('button', { name: /csv|выгруз|экспорт/i })).toBeNull();
    expect(screen.queryByRole('link', { name: /csv|выгруз|экспорт/i })).toBeNull();
  });

  it('вторая страница запрошена по next_cursor, а не по номеру', async () => {
    const { api, calls } = apiOf([
      page([entry({ id: 'a-1' })], 'c50'),
      page([entry({ id: 'a-2', action: 'grant.revoke' })], null),
    ]);
    render(<Audit api={api} query={{}} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Показать ещё' }));

    await waitFor(() => { expect(screen.getByText('grant.revoke')).toBeInTheDocument(); });
    const second = only(calls.filter((call) => call.url.includes('cursor=')), 'запрос второй страницы');
    expect(second.url).toContain('cursor=c50');
    // «Страниц по номеру» нет ни как параметра, ни как подписи.
    expect(calls.some((call) => /page=|offset=/.test(call.url))).toBe(false);
    expect(screen.queryByText(/страница \d/)).toBeNull();
    // Курсора дальше нет — кнопка исчезает и говорит, что лента кончилась.
    await waitFor(() => { expect(screen.queryByRole('button', { name: 'Показать ещё' })).toBeNull(); });
    expect(await screen.findByText('Дальше записей нет.')).toBeInTheDocument();
  });

  it('фильтры уходят в запрос как есть, пустые — не уходят вовсе', async () => {
    const filtered = apiOf([page([], null)]);
    render(<Audit api={filtered.api} query={{ entity: 'grant', action: 'grant.revoke', actor_tg_id: '777002', limit: '25' }} />);
    await waitFor(() => { expect(queriesOf(filtered.calls).length).toBeGreaterThan(0); });
    expect(queriesOf(filtered.calls)[0]).toBe('entity=grant&action=grant.revoke&actor_tg_id=777002&limit=25');

    const bare = apiOf([page([], null)]);
    render(<Audit api={bare.api} query={{}} />);
    await waitFor(() => { expect(queriesOf(bare.calls).length).toBeGreaterThan(0); });
    // Пустой фильтр не отправляется как `entity=`: сервер прочтёт это как
    // «фильтр с пустым значением» и ответит 422 вместо списка.
    expect(queriesOf(bare.calls)[0]).not.toContain('entity');
    expect(queriesOf(bare.calls)[0]).not.toContain('limit');
  });

  it('кривой limit из хеша в запрос не едет', async () => {
    const { api, calls } = apiOf([page([], null)]);
    render(<Audit api={api} query={{ limit: 'все' }} />);

    await waitFor(() => { expect(queriesOf(calls).length).toBeGreaterThan(0); });
    expect(queriesOf(calls)[0]).not.toContain('limit');
  });

  it('пустой before/after — «—»; в различиях только изменённые поля', async () => {
    const { api } = apiOf([
      page(
        [
          entry({ id: 'a-1', action: 'session.login', entity: 'session', entity_id: null, before: null, after: null, reason: null, request_id: null }),
          entry({ id: 'a-2', action: 'code.update', before: { max_activations: 5, note: null }, after: { max_activations: 7 } }),
        ],
        null,
      ),
    ]);
    const { container } = render(<Audit api={api} query={{}} />);
    await screen.findByText('code.update');

    // Различия показаны полем и обоими значениями; `note` не было → «—».
    const deltas = [...container.querySelectorAll('tbody li')].map((li) => li.textContent);
    expect(deltas).toContain('max_activations: 5 → 7');
    expect(deltas).toContain('note: — → —');
    // В строке входа различий нет: ни `<li>`, ни пустой ячейки — стоит «—».
    const rows = [...container.querySelectorAll('tbody tr')];
    expect(rows).toHaveLength(2);
    expect(deltas.length).toBe(2);
    expect(rows[0]?.textContent).toContain('—');
    expect(rows[0]?.querySelector('li')).toBeNull();
  });

  it('422 сервера на limit=201 показан текстом сервера', async () => {
    const { api } = apiOf([problemResponse(422, 'VALIDATION_FAILED', 'Limit вне диапазона 1..200.', { reason: 'invalid_limit' })]);
    render(<Audit api={api} query={{ limit: '201' }} />);

    // Текст сервера доезжает целиком (префикс — общий для всех ошибок экрана).
    expect(await screen.findByText(/Limit вне диапазона 1\.\.200\./)).toBeInTheDocument();
    expect(screen.getByText(/VALIDATION_FAILED · invalid_limit/)).toBeInTheDocument();
    expect(screen.queryByText('Записей нет.')).toBeNull();
  });

  it('служебная запись помечена «сервис»; имя — снимок из журнала', async () => {
    const { api, calls } = apiOf([page([entry({ id: 'a-3', actor_tg_id: '0', actor_name: 'planner', action: 'session.purge', entity: 'session' })], null)]);
    render(<Audit api={api} query={{}} />);

    expect(await screen.findByText('(сервис)')).toBeInTheDocument();
    expect(screen.getByText('planner')).toBeInTheDocument();
    // За «текущим именем» человека панель не ходила: только журнал.
    expect(calls.map((call) => call.url.split('?')[0])).toEqual([expect.stringContaining('/admin/audit')]);
  });

  it('смена фильтров в хеше перечитывает ленту и сбрасывает накопленные страницы', async () => {
    const { api, calls } = apiOf([
      page([entry({ id: 'a-1' })], 'c1'),
      page([entry({ id: 'a-2' })], 'c2'),
    ]);
    const view = render(<Audit api={api} query={{}} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Показать ещё' }));
    await waitFor(() => { expect(calls.filter((call) => call.url.includes('cursor='))).toHaveLength(1); });

    view.rerender(<Audit api={api} query={{ entity: 'grant' }} />);
    await waitFor(() => { expect(queriesOf(calls).some((q) => q.includes('entity=grant'))).toBe(true); });
    // Старый курсор к новому срезу не подмешался.
    const after = calls.filter((call) => call.url.includes('entity=grant'));
    expect(after.every((call) => !call.url.includes('cursor='))).toBe(true);
  });

  it('форма пишет фильтры в хеш, «Сбросить» их убирает', async () => {
    window.location.hash = '/audit';
    const { api, calls } = apiOf([page([], null)]);
    render(<Audit api={api} query={{}} />);
    await screen.findByText('Записей нет.');

    fireEvent.change(screen.getByLabelText('entity'), { target: { value: 'grant' } });
    const form = screen.getByRole('button', { name: 'Применить' }).closest('form');
    if (form === null) throw new Error('формы фильтров нет');
    fireEvent.submit(form);
    expect(window.location.hash).toBe('#/audit?entity=grant');

    fireEvent.click(screen.getByRole('button', { name: 'Сбросить' }));
    expect(window.location.hash).toBe('#/audit');
    expect(calls.length).toBeGreaterThan(0);
  });
});
