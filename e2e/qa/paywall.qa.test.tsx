/**
 * QA-002, задача 3.2 / QA-003, задача 4: пейволл как состояние экрана.
 *
 * Вопрос приёмки не изменился с 002, изменился компонент: `Teaser` из итерации 1
 * стал `ReportTeaser` (FE 005). Проверяем то же поведение, а не новое:
 *   1) без оплаты полного разбора в DOM нет ни одной буквы разбора: заглушка —
 *      фигуры, а не спрятанный текст, который можно вытащить из `innerHTML`;
 *   2) кнопка покупки ведёт в пейволл, а не открывает покупку сама, и цена на
 *      ней — из `packages/shared`, а не литерал в компоненте;
 *   3) при `full_report: true` компонент не берёт решение о доступе на себя: он
 *      показывает то, что дал сервер, и не рисует платный текст, если сервер его
 *      не прислал (нет второго источника правды на клиенте);
 *   4) `paymentPending` — цена не предлагается, пока сервер не подтвердил платёж.
 *
 * Рендер — как в `apps/web/src/screens/chart/ChartScreen.test.tsx`: компонент
 * получает `api` и колбэки, отдельного «тестового» входа у него нет.
 * Цена берётся из shared: изменение цены там не должно требовать правки теста.
 *
 * Запуск: pnpm exec vitest run --config e2e/qa/vitest.config.ts
 */
import { priceOf } from '@astro-soul/shared';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Report } from '../../apps/web/src/api';
import { ru } from '../../apps/web/src/i18n/ru';
import { ReportTeaser } from '../../apps/web/src/screens/chart/ReportTeaser';

const copy = ru.chart;
const REPORT_PRICE = priceOf('one_149');
const CHART_ID = '11111111-1111-4111-8111-111111111111';
const REPORT_ID = '22222222-2222-4222-8222-222222222222';

/** Глава разбора: если её текст окажется в DOM, тест обязан это увидеть. */
const SECRET_CHAPTER = {
  topic: 'core' as const,
  title: 'Глава первая, секретная',
  body_md: 'ЭТОТ ТЕКСТ ПЛАТНЫЙ И НЕ ДОЛЖЕН БЫТЬ В DOM',
  total_chars: 40,
  status: 'ready' as const,
};

const unpaidReport: Report = {
  report_id: REPORT_ID,
  chart_id: CHART_ID,
  status: 'ready',
  progress: 100,
  is_paid: false,
  teaser: 'Короткий бесплатный фрагмент.',
  sections: [],
  pdf_url: null,
};

function setup(overrides: Partial<Parameters<typeof ReportTeaser>[0]> = {}) {
  const onBuy = vi.fn();
  const onOrder = vi.fn();
  const onOpen = vi.fn();
  const api = { getReport: vi.fn(async () => unpaidReport) };

  const view = render(
    <ReportTeaser
      api={api}
      chartId={CHART_ID}
      fullReport={false}
      reportId={null}
      onBuy={onBuy}
      onOrder={onOrder}
      onOpen={onOpen}
      {...overrides}
    />,
  );

  return { api, onBuy, onOrder, onOpen, user: userEvent.setup(), ...view };
}

/** Кнопка «Открыть полностью — N ⭐» по доступному имени (звёздочка — слово). */
const buyButton = () =>
  screen.getByRole('button', { name: new RegExp(copy.teaserCta.replace(/\s+/gu, '\\s*'), 'u') });

describe('QA: пейволл (ReportTeaser)', () => {
  it('без отчёта: платного текста в DOM нет, заглушка — фигуры, а не буквы', () => {
    const { container } = setup();

    // Замок и подпись «заперто» на месте.
    expect(screen.getByText(copy.teaserLocked)).toBeInTheDocument();

    // Заглушка помечена aria-hidden — скринридер её не читает…
    const hidden = container.querySelector('[aria-hidden="true"]');
    expect(hidden, 'нет блока-заглушки с aria-hidden').not.toBeNull();

    // …и внутри неё ни одного слова: только пустые span'ы.
    expect((hidden?.textContent ?? '').trim(), 'в заглушке оказался текст — его видно мимо блюра').toBe('');

    // Главы разбора нет ни в каком виде.
    expect(container.innerHTML).not.toContain(SECRET_CHAPTER.body_md);
    expect(container.innerHTML).not.toContain(SECRET_CHAPTER.title);
  });

  it('без отчёта: кнопка ведёт в пейволл, покупку сама не открывает', async () => {
    const { onBuy, onOrder, user } = setup();

    const cta = buyButton();
    expect(cta).toBeEnabled();

    await user.click(cta);

    expect(onBuy).toHaveBeenCalledTimes(1);
    expect(onOrder, 'кнопка цены заказала разбор в обход пейволла').not.toHaveBeenCalled();
  });

  it('цена берётся из shared, а не из литерала в компоненте', () => {
    setup();

    const text = buyButton().textContent ?? '';
    expect(text).toContain(String(REPORT_PRICE));
    expect(REPORT_PRICE).toBe(priceOf('one_149'));
  });

  it('оплачен, но отчёт сервер не прислал: кнопка заказа, а платного текста по-прежнему нет', async () => {
    const { onOrder, user } = setup({ fullReport: true, reportId: null });

    // Заказа ждём только когда отчёт не пришёл вовсе.
    expect(screen.queryByText(SECRET_CHAPTER.body_md)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: copy.orderReport }));

    expect(onOrder).toHaveBeenCalledTimes(1);
  });

  it('неоплаченный отчёт с главами на руках: показывает teaser, главы в DOM не попадают', async () => {
    const api = {
      getReport: vi.fn(async () => ({ ...unpaidReport, sections: [SECRET_CHAPTER] })),
    };
    const { container } = setup({ api, reportId: REPORT_ID });

    expect(await screen.findByText('Короткий бесплатный фрагмент.')).toBeInTheDocument();
    expect(api.getReport).toHaveBeenCalledWith(REPORT_ID, expect.any(AbortSignal));
    expect(container.innerHTML).not.toContain(SECRET_CHAPTER.body_md);
    expect(container.innerHTML).not.toContain(SECRET_CHAPTER.title);
  });

  it('платёж ещё не подтверждён: цена не предлагается, второй оплаты быть не может', () => {
    setup({ paymentPending: true, fullReport: false });

    expect(screen.getByText(copy.paymentPending)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: new RegExp(copy.teaserCta, 'u') })).not.toBeInTheDocument();
    expect(document.body.textContent ?? '').not.toContain(String(REPORT_PRICE));
  });
});
