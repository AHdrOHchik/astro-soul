import { DISCLAIMER } from '../reports/validators';
import {
  endsProperly,
  joinSections,
  trimToSentences,
  type SectionMeta,
  type TrimResult,
} from '../../common/sections';

/**
 * Четыре раздела прогноза дня: ключи, заголовки и объёмы (контракт 1.6.6).
 *
 * Заголовки — **с сервера**: клиент не хардкодит названия, иначе правка текста
 * требует релиза приложения. `min`/`max` — условие показа, а не украшение:
 * раздел короче минимума бесполезен, длиннее максимума не читают в Telegram.
 */
export const FORECAST_SECTIONS: readonly SectionMeta[] = [
  { key: 'summary', title: 'День в одном предложении', min: 120, max: 200 },
  { key: 'easier', title: 'Где будет легче', min: 300, max: 450 },
  { key: 'careful', title: 'Где осторожнее', min: 300, max: 450 },
  { key: 'step', title: 'Один шаг', min: 200, max: 300 },
];

/** Объём всего прогноза без подписи. */
export const FORECAST_TOTAL_MIN = 900;
export const FORECAST_TOTAL_MAX = 1_400;

/** Тот же дисклеймер, что у разбора: одна константа на продукт. */
export const FORECAST_DISCLAIMER = DISCLAIMER;

export type ForecastWarning = 'length_off';

export interface ForecastSectionView {
  readonly key: string;
  readonly title: string;
  readonly body: string;
}

export interface ForecastText {
  readonly sections: readonly ForecastSectionView[];
  readonly chars: number;
  readonly warnings: readonly ForecastWarning[];
  readonly bodyMd: string;
}

/**
 * Запрещённое содержание — **провал**, не предупреждение (задача владельца).
 *
 * Четыре класса, каждый — про своё:
 *   1. обещание конкретного события («тебе напишет», «деньги придут»):
 *      предсказание события — это ложь о будущем, а не «фон дня»;
 *   2. будущие даты, кроме сегодняшней: «20 ноября» в тексте про другой день
 *      человек читает как обещание;
 *   3. медицина и юридические советы: мы не имеем права;
 *   4. смерть, болезни и проценты: то, что нельзя показывать никогда.
 *
 * Регулярки намеренно широкие: лучше отклонить текст и сказать «не получилось»,
 * чем показать «тебе напишет бывший».
 */
interface ForbiddenRule {
  readonly code: string;
  readonly pattern: RegExp;
}

const FORBIDDEN: readonly ForbiddenRule[] = [
  {
    code: 'promise_event',
    pattern:
      /тебе напиш[еу]т|тебя жд[её]т|вас жд[её]т|деньги придут|придут деньги|получишь (письмо|сообщение|предложение)|позвон[яи]т|встретишь (его|её|человека)|сбудется|обязательно случится/iu,
  },
  {
    code: 'future_date',
    pattern:
      /\b(\d{1,2})[./-](\d{1,2})([./-]\d{2,4})?\b|\b\d{1,2}\s+(январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр|декабр)\w*/iu,
  },
  {
    code: 'medical_legal',
    pattern:
      /диагноз|лечени|лекарств|таблетк|дозировк|терапи|врач|анализ[ыа]|болезн|симптом|юрист|адвокат|иск в суд|нотариус|налогов\w* вычет|договор (переда|купли)/iu,
  },
  {
    code: 'death_illness',
    pattern: /смерт|умр[её]шь|умр[её]т|похорон|кончин|рак\b|онкологи|инсульт|инфаркт/iu,
  },
  {
    code: 'percent',
    pattern: /\d+\s?%|процент/i,
  },
];

/** Что именно не так — для лога и для `error_code` строки. */
export function forbiddenOf(text: string): string | null {
  for (const rule of FORBIDDEN) {
    if (rule.pattern.test(text)) {
      return rule.code;
    }
  }
  return null;
}

/**
 * Разбор ответа модели. Модель просят вернуть JSON с четырьмя ключами, но
 * JSON — не гарантия: если разобрать не удалось, разделы не выдумываем и
 * отдаём `null` — вызывающий решает (это провал генерации, не «пустой текст»).
 */
export function parseForecastAnswer(raw: string): Record<string, string> | null {
  const body = raw.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/u, '$1');

  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return null;
    }

    const record = parsed as Record<string, unknown>;
    const result: Record<string, string> = {};
    for (const section of FORECAST_SECTIONS) {
      const value = record[section.key];
      if (typeof value === 'string' && value.trim() !== '') {
        result[section.key] = value.trim();
      }
    }

    return Object.keys(result).length === FORECAST_SECTIONS.length ? result : null;
  } catch {
    return null;
  }
}

/**
 * Проверка и обрезка разделов.
 *
 * Возвращает `null`, если текст показывать нельзя (нет раздела, обрывок,
 * запрещённое содержание). Иначе — готовые разделы, объём и предупреждения.
 * Обрезка только по границе предложения: см. `common/sections`.
 */
export function finalizeForecast(parsed: Record<string, string>): ForecastText | null {
  const sections: ForecastSectionView[] = [];
  const warnings = new Set<ForecastWarning>();

  for (const meta of FORECAST_SECTIONS) {
    const raw = parsed[meta.key];
    if (raw === undefined) {
      return null;
    }

    if (forbiddenOf(raw) !== null) {
      return null;
    }

    const trimmed: TrimResult = trimToSentences(raw, meta.max, meta.min);
    if (trimmed.text === '' || !endsProperly(trimmed.text)) {
      return null;
    }
    // `length_off` — «объём пришлось править»: либо обрезали по предложению,
    // либо он всё равно вне границ. Второе без первого бывает только на
    // одном длинном предложении.
    if (trimmed.trimmed || trimmed.off) {
      warnings.add('length_off');
    }

    sections.push({ key: meta.key, title: meta.title, body: trimmed.text });
  }

  const chars = sections.reduce((sum, section) => sum + section.body.length, 0);
  if (chars < FORECAST_TOTAL_MIN || chars > FORECAST_TOTAL_MAX) {
    warnings.add('length_off');
  }

  return {
    sections,
    chars,
    warnings: [...warnings],
    bodyMd: joinSections(sections),
  };
}

/** Раздел по ключу из сохранённого markdown — для чтения готового прогноза. */
export function forecastFromBody(bodyMd: string): { sections: ForecastSectionView[]; chars: number } {
  const parts: ForecastSectionView[] = [];

  for (const meta of FORECAST_SECTIONS) {
    const pattern = new RegExp(`^##\\s+${escapeRe(meta.title)}\\s*$`, 'mu');
    const match = pattern.exec(bodyMd);
    if (match === null) {
      continue;
    }
    const start = match.index + match[0].length;
    const rest = bodyMd.slice(start);
    const next = /^##\s+/mu.exec(rest);
    const body = (next === null ? rest : rest.slice(0, next.index)).trim();
    parts.push({ key: meta.key, title: meta.title, body });
  }

  return { sections: parts, chars: parts.reduce((sum, section) => sum + section.body.length, 0) };
}

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
