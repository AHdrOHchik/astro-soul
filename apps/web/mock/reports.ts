/*
 * The full report of the dev mock: a text that is plainly not a reading of anybody's chart,
 * and a clock that plays the pipeline of apps/api (`reports.service.ts`): queued, then a
 * chapter at a time, then ready. Nothing is generated: the chapters below are all there is.
 */
import type { components } from '../src/api/schema.gen';

type Schemas = components['schemas'];
export type Report = Schemas['Report'];
type Section = NonNullable<Report['sections']>[number];

/** How a mock report ends: as it should, or one of the ways it can go wrong. */
export type ReportScenario = 'ready' | 'failed' | 'refunded' | 'stuck';

export const REPORT_SCENARIOS: readonly ReportScenario[] = ['ready', 'failed', 'refunded', 'stuck'];

/** The first 400 characters of the first chapter are what the server shows before the purchase. */
const TEASER_LENGTH = 400;

/** The seven chapters under the keys and titles apps/api gives them (`validators.ts`, `SECTIONS`). */
const CHAPTERS: readonly Required<Pick<Section, 'key' | 'title' | 'body_md'>>[] = [
  {
    key: 'core',
    title: 'Ядро личности',
    body_md: [
      'Это текст мока, а не разбор твоей карты: настоящий пишет сервер. Здесь он нужен, чтобы увидеть, как глава выглядит на экране и как ведёт себя длинный абзац на узком телефоне.',
      'Ты не спешишь с решениями — и это не медлительность, а привычка проверять опору. **Сначала проверка, потом шаг**: так выглядит твой обычный порядок действий.',
      'Третий абзац стоит здесь, чтобы первые четыреста знаков главы заканчивались посреди текста, как это и бывает у настоящего тизера.',
    ].join('\n\n'),
  },
  {
    key: 'emotions',
    title: 'Эмоции и внутренний мир',
    body_md: [
      'Чувства у тебя идут глубже, чем видно снаружи. Тебе нужно время, чтобы назвать то, что происходит, и ты редко делаешь это вслух.',
      'Что помогает:',
      '— сказать о важном одному человеку, а не всем сразу;\n— дать себе день, прежде чем отвечать на резкое;\n— замечать, когда спокойствие — это усталость.',
    ].join('\n\n'),
  },
  {
    key: 'talents',
    title: 'Таланты и сильные стороны',
    body_md: [
      'Твоя сильная сторона — доводить начатое до результата, который можно показать. *Потенциал* тебя не убеждает, убеждает готовая вещь.',
      '1. Ты видишь, где работа буксует.\n2. Ты умеешь упростить задачу до выполнимой.\n3. Ты возвращаешься к делу после паузы.',
    ].join('\n\n'),
  },
  {
    key: 'relations',
    title: 'Отношения',
    body_md:
      'В близости тебе важна надёжность: слова, за которыми стоят действия. Ты долго присматриваешься, зато редко ошибаешься в людях, которых подпускаешь.\n\nЦена этой осторожности — паузы, которые другой человек может прочитать как холод.',
  },
  {
    key: 'money',
    title: 'Деньги, работа, реализация',
    body_md:
      'В работе ты ценишь понятные правила и видимый результат. Тебе проще долго строить одно, чем быстро пробовать многое.\n\n## Где это мешает\n\nИногда ты держишься за начатое дольше, чем оно того стоит.',
  },
  {
    key: 'purpose',
    title: 'Смысл и направление',
    body_md:
      'Тебе важно, чтобы у усилий был адресат. Дело ради дела быстро теряет для тебя вкус, а дело, которое кому-то помогает, держит годами.',
  },
  {
    key: 'summary',
    title: 'Итог: что с этим делать',
    body_md: [
      'Три действия на ближайшую неделю:',
      '— запиши одно решение, которое ты откладываешь, и срок для него;\n— скажи вслух одну вещь, о которой обычно молчишь;\n— закончи одно начатое дело, даже небольшое.',
      'Разбор — инструмент саморефлексии, а не предсказание и не замена специалисту.',
    ].join('\n\n'),
  },
];

export interface MockReport {
  id: string;
  chartId: string;
  createdAt: number;
  scenario: ReportScenario;
}

/** How long a mock report stays queued, and how long each chapter takes. */
export interface ReportPace {
  queuedMs: number;
  chapterMs: number;
}

/** After this many chapters a report that goes wrong does so; a `refunded` one is refunded a moment later. */
const TROUBLE_AFTER_CHAPTERS = 2;
const REFUND_AFTER_MS = 4000;

/** Where the report stands at `now`, by its scenario and the clock alone. */
function standingAt(report: MockReport, pace: ReportPace, now: number): { status: Report['status']; chapters: number } {
  const elapsed = now - report.createdAt;
  if (elapsed < pace.queuedMs) return { status: 'queued', chapters: 0 };
  const written = Math.floor((elapsed - pace.queuedMs) / pace.chapterMs);
  if (report.scenario === 'ready') {
    return written >= CHAPTERS.length ? { status: 'ready', chapters: CHAPTERS.length } : { status: 'generating', chapters: written };
  }
  if (written < TROUBLE_AFTER_CHAPTERS) return { status: 'generating', chapters: written };
  if (report.scenario === 'stuck') return { status: 'generating', chapters: TROUBLE_AFTER_CHAPTERS };
  const sinceFailure = elapsed - pace.queuedMs - TROUBLE_AFTER_CHAPTERS * pace.chapterMs;
  const refunded = report.scenario === 'refunded' && sinceFailure >= REFUND_AFTER_MS;
  return { status: refunded ? 'refunded' : 'failed', chapters: TROUBLE_AFTER_CHAPTERS };
}

/** Whether the stars for the report have gone back: the purchase behind it no longer stands. */
export function isRefunded(report: MockReport, pace: ReportPace, now: number): boolean {
  return standingAt(report, pace, now).status === 'refunded';
}

/**
 * `Report` the way apps/api builds it (`ReportsService.view`): progress by the chapters
 * written, 100 only when ready; the chapters only for a paid report, the teaser for any.
 */
export function viewOf(report: MockReport, pace: ReportPace, now: number, paid: boolean, pdfUrl: string | null): Report {
  const { status, chapters } = standingAt(report, pace, now);
  let progress = Math.min(95, 5 + Math.round((chapters / CHAPTERS.length) * 90));
  if (status === 'ready') progress = 100;
  if (status === 'queued') progress = 0;
  const written = CHAPTERS.slice(0, chapters);
  const teaser = written[0]?.body_md.slice(0, TEASER_LENGTH);
  return {
    report_id: report.id,
    chart_id: report.chartId,
    type: 'full',
    status,
    progress,
    created_at: new Date(report.createdAt).toISOString(),
    ready_at: status === 'ready' ? new Date(report.createdAt + pace.queuedMs + CHAPTERS.length * pace.chapterMs).toISOString() : null,
    pdf_url: paid && status === 'ready' ? pdfUrl : null,
    sections: paid ? written.map((chapter, order) => ({ ...chapter, order })) : [],
    is_paid: paid,
    ...(teaser !== undefined && { teaser }),
  };
}

/** The smallest file a PDF viewer opens: one empty page. For `API_MOCK_PDF=1`. */
export function mockPdf(): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets = objects.map((object, index) => {
    const offset = body.length;
    body += `${String(index + 1)} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = body.length;
  body += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(xref)}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}
