import type { Chart } from '@astro-soul/shared';
import { QUESTION_SECTIONS } from './questions.validators';

/**
 * Промпт «спроси карту» (версия — `PROMPT_VERSION_QUESTION`).
 *
 * В модель уходят: вопрос как есть и **факты карты**. Не уходят: telegram_id,
 * имя, дата и место рождения списком — только то, что нужно для опоры
 * (Солнце, Луна, Асцендент и до семи сильнейших аспектов).
 */

export const QUESTION_SYSTEM_PROMPT = [
  'Ты — редактор астрологического мини-приложения. Отвечаешь на «ты», коротко и по делу.',
  'Пиши про поведение, внимание и выбор, а не про судьбу. Никаких «вас ждёт» и гарантий.',
  'Запрещено: диагнозы и здоровье как тема, смерть, юридические и финансовые советы, любые даты и сроки,',
  'проценты и вероятности, «карма», «судьба», «предназначение».',
  'Опирайся только на позиции карты из сообщения. Не выдумывай планет, домов и аспектов, которых там нет.',
  'Если вопрос не про карту и не про жизнь человека — скажи это прямо в разделе answer и дай общий ответ.',
  'Отвечай строго JSON без пояснений и без markdown-обёртки.',
].join(' ');

const SIGN_PREPOSITIONAL: Readonly<Record<string, string>> = {
  Овен: 'Овне',
  Телец: 'Тельце',
  Близнецы: 'Близнецах',
  Рак: 'Раке',
  Лев: 'Льве',
  Дева: 'Деве',
  Весы: 'Весах',
  Скорпион: 'Скорпионе',
  Стрелец: 'Стрельце',
  Козерог: 'Козероге',
  Водолей: 'Водолее',
  Рыбы: 'Рыбах',
};

const ASPECT_RU: Readonly<Record<string, string>> = {
  conjunction: 'соединение',
  opposition: 'оппозиция',
  trine: 'трин',
  square: 'квадрат',
  sextile: 'секстиль',
};

/** Сколько позиций карты достаточно, чтобы ответ был «привязан». */
const NATAL_FACTORS_MAX = 10;

function position(label: string, sign: string | null | undefined, degree?: number): string {
  if (sign === null || sign === undefined || sign === '') {
    return '';
  }
  const where = SIGN_PREPOSITIONAL[sign] ?? sign;
  return degree === undefined ? `${label} в ${where}` : `${label} в ${where}, ${degree}°`;
}

/**
 * Сильнейшие позиции карты — детерминированный отбор.
 *
 * Сначала «ядро» (Солнце, Луна, Асцендент) — без него ответ не про этого
 * человека. Затем аспекты по силе: сортировка по `strength` (а при равенстве —
 * по `orb`, затем по именам), потому что порядок из БД не гарантирован и
 * одинаковый вопрос не должен получать разные факты.
 */
export function natalFactors(chart: Chart): string[] {
  const factors: string[] = [];

  for (const key of ['sun', 'moon']) {
    const planet = chart.planets.find((item) => item.key === key);
    if (planet !== undefined) {
      const label = position(planet.name, planet.sign ?? null, planet.degree);
      if (label !== '') {
        factors.push(label);
      }
    }
  }

  const asc = position('Асцендент', chart.asc?.sign ?? null, chart.asc?.degree);
  if (asc !== '') {
    factors.push(asc);
  }

  const names = new Map<string, string>(chart.planets.map((planet) => [planet.key, planet.name]));
  const aspects = [...chart.aspects]
    .sort((a, b) => {
      const byStrength = (b.strength ?? 0) - (a.strength ?? 0);
      if (byStrength !== 0) {
        return byStrength;
      }
      const byOrb = a.orb - b.orb;
      if (byOrb !== 0) {
        return byOrb;
      }
      return `${a.a}${a.b}`.localeCompare(`${b.a}${b.b}`);
    })
    .slice(0, NATAL_FACTORS_MAX - factors.length);

  for (const aspect of aspects) {
    const a = names.get(aspect.a) ?? aspect.a;
    const b = names.get(aspect.b) ?? aspect.b;
    const type = ASPECT_RU[aspect.type] ?? aspect.type;
    factors.push(`${a} — ${type} — ${b} (орб ${aspect.orb.toFixed(2)}°)`);
  }

  return factors.slice(0, NATAL_FACTORS_MAX);
}

export interface QuestionPromptInput {
  readonly question: string;
  readonly chart: Chart;
}

export function questionPrompt(input: QuestionPromptInput): string {
  const shape = QUESTION_SECTIONS.map(
    (section) => `  • "${section.key}" — «${section.title}», ${section.min}–${section.max} знаков`,
  ).join('\n');

  return [
    `Позиции карты:`,
    ...natalFactors(input.chart).map((factor) => `- ${factor}`),
    '',
    `Вопрос: ${input.question}`,
    '',
    'Ответь тремя разделами, каждый — связный текст целыми предложениями:',
    shape,
    '',
    'answer — прямой ответ на вопрос, без вступления.',
    'why — на каких позициях карты он держится: назови их своими словами.',
    'do — одно действие на сегодня-завтра, выполнимое и бесплатное.',
    '',
    'Формат: {"answer": "…", "why": "…", "do": "…"}',
  ].join('\n');
}
