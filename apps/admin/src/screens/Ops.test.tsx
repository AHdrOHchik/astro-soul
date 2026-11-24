/*
 * «Эксплуатация». Здесь панель единственная нажимает на кнопки, которые трогают
 * живой сервис, поэтому проверки жёсткие:
 *   • основание обязательно (5…500 знаков) — без него запрос не уходит вообще,
 *     а не уходит «с пустым полем»;
 *   • дамп: `202` — «запущено», а не «сделано» (успех подтверждает маркер);
 *   • `409` несёт `details.retry_after_seconds` — срок называется, если сервер
 *     его назвал, и says «не названо», если нет;
 *   • `503 backup_not_configured` — имена из `details.missing` списком, пустой
 *     список не превращается в выдуманные переменные;
 *   • `502` на вебхуке — `last_error_message` дословно; `deleteWebhook` не
 *     вызывается никогда;
 *   • подтверждение алерта не чинит его: `value` и `threshold` после `ack`
 *     те же, меняется только показ.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAdminApi } from '../api/admin';
import { createHttp } from '../api/http';
import { createFetchLog, jsonBody, jsonResponse, only, problemResponse, type Call } from '../testing/fetchLog';
import type { Alert } from '../api/types';
import { Ops } from './Ops';

const NOW = Date.UTC(2026, 10, 20, 12, 0, 0);
const MINUTE = 60_000;
const iso = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString();

const JOB_ID = '0f0c2b6a-0000-4000-8000-0000000000c1';
const WEBHOOK_URL = 'https://astro.example/api/v1/telegram/webhook/secret';

const alert = (overrides: Partial<Alert> = {}): Alert => ({
  id: 'llm_spend',
  level: 'warning',
  value: 14.5,
  threshold: 10,
  since: iso(-2 * 3_600_000),
  fired: true,
  acked_until: null,
  ...overrides,
});

function api(fetchImpl: typeof fetch): ReturnType<typeof createAdminApi> {
  return createAdminApi(createHttp({ fetchImpl, retries: 0, retryDelayMs: () => 0, csrfToken: () => 'токен' }));
}

const posts = (calls: readonly Call[]): Call[] => calls.filter((call) => call.init.method === 'POST');

/** Панель по заголовку: оснований на экране два, и они выглядят одинаково. */
function panel(title: string): HTMLElement {
  const heading = screen.getByRole('heading', { level: 2, name: title });
  const section = heading.closest('section');
  if (section === null) throw new Error(`панель «${title}» не отрисована`);
  return section;
}

function reason(where: HTMLElement, text: string): void {
  fireEvent.change(within(where).getByLabelText(/Основание/), { target: { value: text } });
}

/** Два нажатия HoldConfirm: пауза считается по `Date.now`, который подменён. */
function pressTwice(name: RegExp): void {
  // «Часы» сбрасываются: тест может вооружить вторую кнопку, не перезагружая
  // страницу, и иначе второй клик попадает в уже истёкшую паузу.
  vi.mocked(Date.now).mockReturnValue(NOW);
  fireEvent.click(screen.getByRole('button', { name }));
  vi.mocked(Date.now).mockReturnValue(NOW + 2_100);
  fireEvent.click(screen.getByRole('button', { name: /Подожди ещё|Подтвердить ещё раз/ }));
}

describe('Эксплуатация', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('дамп: без основания запрос не уходит, с основанием — POST {reason} и 202 «запущено»', async () => {
    const { fetchImpl: fetch, calls } = createFetchLog((_url, init) => {
      if ((init.method ?? 'GET') === 'POST') return jsonResponse({ started: true, job_id: JOB_ID }, { status: 202 });
      return jsonResponse({ alerts: [] });
    });
    render(<Ops api={api(fetch)} sessionLive demo={false} />);

    const section = panel('Дамп базы');
    const button = within(section).getByRole('button', { name: 'Запустить дамп' });
    // Пустое основание — кнопка не вооружается: «422 invalid_reason» панель сама не провоцирует.
    expect(button).toBeDisabled();
    expect(within(section).getByText('Без основания запрос не отправляется.')).toBeInTheDocument();
    fireEvent.click(button);
    expect(posts(calls)).toHaveLength(0);

    // Три знака — всё ещё мало: нижняя граница 5.
    reason(section, 'абв');
    expect(within(section).getByRole('button', { name: 'Запустить дамп' })).toBeDisabled();

    reason(section, 'после миграции 0042');
    expect(within(section).queryByText(/Без основания запрос не отправляется/)).toBeNull();

    // Первое нажатие — только вооружение.
    fireEvent.click(within(section).getByRole('button', { name: 'Запустить дамп' }));
    expect(posts(calls)).toHaveLength(0);

    vi.mocked(Date.now).mockReturnValue(NOW + 2_100);
    fireEvent.click(within(section).getByRole('button', { name: /Подожди ещё|Подтвердить ещё раз/ }));
    await waitFor(() => {
      expect(posts(calls)).toHaveLength(1);
    });

    const run = only(posts(calls), 'POST дампа');
    expect(run.url).toBe('/api/v1/admin/backup/run');
    expect(jsonBody(run)).toEqual({ reason: 'после миграции 0042' });

    // 202 = «в работе»: дамп запущен, а не готов.
    const banner = await screen.findByText(/Дамп запущен/);
    expect(banner.textContent).toContain(JOB_ID);
    expect(screen.queryByText(/Дамп готов/)).toBeNull();
    expect(within(panel('Дамп базы')).getByText(/успех подтверждает маркер/)).toBeInTheDocument();
  });

  it('409 дампа: срок из details.retry_after_seconds; без срока — «сервер не назвал»', async () => {
    const first = createFetchLog((_url, init) => {
      if ((init.method ?? 'GET') === 'POST') {
        return problemResponse(409, 'CONFLICT', 'Предыдущий дамп ещё идёт.', {
          reason: 'backup_too_frequent',
          retry_after_seconds: 420,
        });
      }
      return jsonResponse({ alerts: [] });
    });
    const { rerender } = render(<Ops api={api(first.fetchImpl)} sessionLive demo={false} />);
    const section = panel('Дамп базы');
    reason(section, 'повтор дампа вручную');
    pressTwice(/Запустить дамп/);
    const banner = await screen.findByText(/Предыдущий дамп ещё идёт. \(backup_too_frequent\)/);
    // 409 — предупреждение, а не красная авария: ничего не сломалось, просто рано.
    expect(banner.closest('.banner--warn')).not.toBeNull();
    expect(banner.textContent).toContain('Повторить можно через 7 мин');
    expect(banner.textContent).toContain('Предыдущий запуск был меньше 10 минут назад');

    // Тот же отказ, но сервер не назвал срок — панель не выдумывает «через 10 минут».
    const second = createFetchLog((_url, init) => {
      if ((init.method ?? 'GET') === 'POST') return problemResponse(409, 'CONFLICT', 'Дамп уже идёт.', { reason: 'backup_in_progress' });
      return jsonResponse({ alerts: [] });
    });
    rerender(<Ops api={api(second.fetchImpl)} sessionLive demo={false} />);
    const again = panel('Дамп базы');
    reason(again, 'повтор дампа вручную');
    pressTwice(/Запустить дамп/);
    const next = await screen.findByText(/Дамп уже идёт. \(backup_in_progress\)/);
    expect(next.textContent).toContain('Дамп уже идёт');
    expect(next.textContent).toContain('Сервер не назвал, когда можно повторить');
    expect(next.textContent).not.toMatch(/через \d+ мин/);
  });

  it('503 backup_not_configured: имена из details.missing списком, пустой список не выдумывается', async () => {
    const log = createFetchLog((_url, init) => {
      if ((init.method ?? 'GET') === 'POST') {
        return problemResponse(503, 'UNAVAILABLE', 'Выгрузка не настроена.', {
          reason: 'backup_not_configured',
          missing: ['BACKUP_S3_BUCKET', 'BACKUP_S3_REGION'],
        });
      }
      return jsonResponse({ alerts: [] });
    });
    render(<Ops api={api(log.fetchImpl)} sessionLive demo={false} />);

    const section = panel('Дамп базы');
    reason(section, 'впервые после продакшена');
    pressTwice(/Запустить дамп/);
    const banner = await screen.findByText(/Выгрузка не настроена./);
    expect(banner.textContent).toContain('`BACKUP_S3_BUCKET`, `BACKUP_S3_REGION`');
    // Красный: чинить нужно сейчас, и список переменных — часть диагностики.
    expect(banner.closest('.banner--crit')).not.toBeNull();
  });

  it('503 без details.missing — «сервер не назвал имён переменных»', async () => {
    const log = createFetchLog((_url, init) => {
      if ((init.method ?? 'GET') === 'POST') return problemResponse(503, 'UNAVAILABLE', 'Выгрузка не настроена.', { reason: 'backup_not_configured' });
      return jsonResponse({ alerts: [] });
    });
    render(<Ops api={api(log.fetchImpl)} sessionLive demo={false} />);

    const section = panel('Дамп базы');
    reason(section, 'впервые после продакшена');
    pressTwice(/Запустить дамп/);
    const banner = await screen.findByText(/Выгрузка не настроена./);
    expect(banner.textContent).toContain('сервер не назвал имён переменных');
    // Ни одного выдуманного имени переменной в тексте нет.
    expect(banner.textContent).not.toMatch(/BACKUP_|S3_/);
  });

  it('вебхук: 200 показывает адрес и null-ошибку; deleteWebhook не вызывается никогда', async () => {
    const { fetchImpl: fetch, calls } = createFetchLog((_url, init) => {
      if ((init.method ?? 'GET') === 'POST') return jsonResponse({ url: WEBHOOK_URL, ok: true, last_error_message: null });
      return jsonResponse({ alerts: [] });
    });
    render(<Ops api={api(fetch)} sessionLive demo={false} />);

    const section = panel('Вебхук Telegram');
    reason(section, 'сменили секрет вебхука');
    pressTwice(/Переустановить вебхук/);

    await waitFor(() => {
      expect(posts(calls)).toHaveLength(1);
    });
    const set = only(posts(calls), 'POST вебхука');
    expect(set.url).toBe('/api/v1/admin/telegram/webhook');
    expect(jsonBody(set)).toEqual({ reason: 'сменили секрет вебхука' });
    // Единственный маршрут — `setWebhook`. `deleteWebhook` с плохим адресом
    // оставил бы нас без pre_checkout_query, то есть без оплаты.
    expect(calls.map((call) => call.url).join(' ')).not.toMatch(/delete/i);

    const banner = await screen.findByText(/Вебхук переустановлен и подтверждён/);
    expect(banner.textContent).toContain(WEBHOOK_URL);
    expect(banner.textContent).toContain('last_error_message: null');
  });

  it('502 на вебхуке — ответ Bot API дословно и «адрес остался прежним»', async () => {
    const { fetchImpl: fetch } = createFetchLog((_url, init) => {
      if ((init.method ?? 'GET') === 'POST') {
        return problemResponse(502, 'UPSTREAM', 'Telegram отказал.', {
          last_error_message: 'Webhook URL must be HTTPS',
          url: null,
          ok: false,
        });
      }
      return jsonResponse({ alerts: [] });
    });
    render(<Ops api={api(fetch)} sessionLive demo={false} />);

    const section = panel('Вебхук Telegram');
    reason(section, 'попробовали http-адрес');
    pressTwice(/Переустановить вебхук/);

    const banner = await screen.findByText(/Telegram отказал./);
    // Дословно, без пересказа: «Webhook URL must be HTTPS» полезнее «что-то пошло не так».
    expect(banner.textContent).toContain('Ответ Bot API: Webhook URL must be HTTPS');
    expect(banner.textContent).toContain('Telegram отказал (502) — адрес остался прежним');
    expect(banner.closest('.banner--crit')).not.toBeNull();
  });

  it('алерты: список берётся как есть — fired:false на экран не попадает', async () => {
    const { fetchImpl: fetch } = createFetchLog(() =>
      jsonResponse({
        alerts: [
          alert({ id: 'llm_spend', value: 14.5, threshold: 10, fired: true }),
          alert({ id: 'backup_stale', value: null, threshold: 36, fired: false, since: null }),
        ],
        checked_at: iso(0),
      }),
    );
    render(<Ops api={api(fetch)} sessionLive demo={false} />);

    const section = panel('Алерты');
    await within(section).findByText('llm_spend');
    expect(within(section).queryByText('backup_stale')).toBeNull();
    // Значение и порог — числом сервера, без округления «до удобно».
    expect(within(section).getByText('14,5')).toBeInTheDocument();
    expect(within(section).getByText('10')).toBeInTheDocument();
  });

  it('`alerts` без ключа в ответе — «неподтверждённых алертов нет», а не ошибка', async () => {
    const { fetchImpl: fetch } = createFetchLog(() => jsonResponse({ checked_at: iso(0) }));
    render(<Ops api={api(fetch)} sessionLive demo={false} />);

    const section = panel('Алерты');
    expect(await within(section).findByText('Неподтверждённых алертов нет.')).toBeInTheDocument();
    expect(within(section).queryByText(/Ошибка запроса/)).toBeNull();
  });

  it('ack: тело только {minutes}; подтверждение не меняет value и threshold', async () => {
    const { fetchImpl: fetch, calls } = createFetchLog((_url, init) => {
      if ((init.method ?? 'GET') === 'POST') {
        return jsonResponse({
          acked_until: iso(45 * MINUTE),
          // Сервер возвращает то же правило с тем же значением — «скрыт» ≠ «исправлено».
          alert: alert({ acked_until: iso(45 * MINUTE), fired: false }),
        });
      }
      return jsonResponse({ alerts: [alert()] });
    });
    render(<Ops api={api(fetch)} sessionLive demo={false} />);

    const section = panel('Алерты');
    const minutes = await within(section).findByLabelText(/Заглушить на/);
    // 10 минут — вне 15..1440: запрос не уходит, подсказка называет границу.
    fireEvent.change(minutes, { target: { value: '10' } });
    expect(within(section).getByText('нужно целое число минут от 15 до 1440')).toBeInTheDocument();
    fireEvent.click(within(section).getByRole('button', { name: 'Подтвердить' }));
    expect(posts(calls)).toHaveLength(0);

    fireEvent.change(minutes, { target: { value: '30' } });
    pressTwice(/Подтвердить/);
    await waitFor(() => {
      expect(posts(calls)).toHaveLength(1);
    });
    const ack = only(posts(calls), 'POST подтверждения');
    expect(ack.url).toBe('/api/v1/admin/alerts/llm_spend/ack');
    // Только `minutes`: срок считает сервер, панель его не назначает.
    expect(jsonBody(ack)).toEqual({ minutes: 30 });

    const banner = await within(section).findByText(/Скрыт до/);
    expect(banner.textContent).toMatch(/Скрыт до \d{2}:\d{2}/);
    // «Исправлено» здесь прозвучало бы как «проблемы нет».
    expect(within(section).queryByText(/исправлено/i)).toBeNull();

    // Лента перечитана, и цифры те же: подтверждение гасит показ, а не данные.
    await waitFor(() => {
      expect(calls.filter((call) => (call.init.method ?? 'GET') === 'GET' && call.url.includes('/admin/alerts')).length).toBeGreaterThanOrEqual(2);
    });
    expect(await within(section).findByText('14,5')).toBeInTheDocument();
    expect(within(section).getByText('10')).toBeInTheDocument();
  });

  it('без сессии ни одна опасная кнопка не вооружается', () => {
    const { fetchImpl: fetch, calls } = createFetchLog(() => jsonResponse({ alerts: [] }));
    render(<Ops api={api(fetch)} sessionLive={false} demo={false} />);

    reason(panel('Дамп базы'), 'после миграции 0042');
    expect(within(panel('Дамп базы')).getByRole('button', { name: 'Запустить дамп' })).toBeDisabled();
    expect(within(panel('Вебхук Telegram')).getByRole('button', { name: 'Переустановить вебхук' })).toBeDisabled();
    fireEvent.click(within(panel('Дамп базы')).getByRole('button', { name: 'Запустить дамп' }));
    expect(calls).toHaveLength(0);
  });
});
