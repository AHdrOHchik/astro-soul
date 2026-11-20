import type { AstroDayFacts } from '../astro/astro.client';
import { FORECAST_SECTIONS } from './daily-forecast.validators';

/**
 * Промпт прогноза дня (версия — `PROMPT_VERSION_FORECAST`, не путать с
 * разбором и совместимостью).
 *
 * Модель не считает: все факты (Луна, ретро, транзиты, окна времени) пришли из
 * Python-сайдкара и лежат в сообщении. Задача модели — перевести их в текст про
 * поведение и внимание. Поэтому в промпте нет ни даты рождения, ни имени: только
 * факты дня.
 */

export const FORECAST_SYSTEM_PROMPT = [
  'Ты — редактор астрологического мини-приложения. Пишешь на «ты», спокойно, без лести и запугивания.',
  'Пиши про поведение и внимание, а не про судьбу. Никаких «вас ждёт».',
  'Запрещено: обещания событий («тебе напишет», «деньги придут»), любые даты и сроки, медицина и диагнозы,',
  'юридические и финансовые советы, смерть и болезни, проценты и вероятности, «карма», «судьба», «предназначение».',
  'В разделе summary не называй планеты вовсе: это «день в одном предложении», а не список аспектов.',
  'Шаг в разделе step обязан быть выполнимым физически и бесплатно: пройтись, выключить уведомления, написать одно сообщение.',
  'Опирайся только на факты из сообщения. Не придумывай транзитов, окон и аспектов, которых там нет.',
  'Отвечай строго JSON без пояснений и без markdown-обёртки.',
].join(' ');

/** Факты дня в текстовом виде: компактно, без служебных полей. */
export function factsBlock(facts: AstroDayFacts): string {
  const lines: string[] = [
    `Дата: ${facts.date}, часовой пояс места рождения: ${facts.timezone}`,
    `Луна на полдень: ${facts.moon.sign}, ${facts.moon.degree}°${String(facts.moon.minute).padStart(2, '0')}′, фаза ${facts.moon.phase}, освещённость ${Math.round(facts.moon.illumination * 100)}%`,
    `Управитель дня: ${facts.ruler.name}`,
  ];

  if (facts.retrograde.length > 0) {
    lines.push(`Ретроградно: ${facts.retrograde.map((planet) => planet.name).join(', ')}`);
  }

  if (facts.transits.length > 0) {
    const transits = facts.transits.slice(0, 8).map((aspect) => {
      const row = aspect as {
        transit_name?: string;
        natal_name?: string;
        type_ru?: string;
        orb?: number;
      };
      return `${row.transit_name ?? '?'} ${row.type_ru ?? '?'} ${row.natal_name ?? '?'} (орб ${row.orb ?? '?'}°)`;
    });
    lines.push(`Транзиты к карте: ${transits.join('; ')}`);
  }

  if (facts.windows.length > 0) {
    const windows = facts.windows.map((window) => {
      const row = window as { from?: string; to?: string; label?: string };
      return `${row.from?.slice(11, 16) ?? '?'}–${row.to?.slice(11, 16) ?? '?'} — ${row.label ?? ''}`;
    });
    lines.push(`Окна дня: ${windows.join('; ')}`);
  }

  return lines.join('\n');
}

export interface ForecastPromptInput {
  readonly facts: AstroDayFacts;
}

/** Пользовательское сообщение: факты + форма ответа (ключи и объёмы). */
export function forecastPrompt(input: ForecastPromptInput): string {
  const shape = FORECAST_SECTIONS.map(
    (section) =>
      `  • "${section.key}" — «${section.title}», ${section.min}–${section.max} знаков, целыми предложениями`,
  ).join('\n');

  return [
    factsBlock(input.facts),
    '',
    'Напиши прогноз на этот день. Четыре независимых раздела, каждый — свой абзац текста:',
    shape,
    '',
    'summary — одно-два предложения про день целиком, без названий планет.',
    'easier — где будет легче: что даётся само, на что не нужно давить.',
    'careful — где осторожнее: трение, спешка, лишние разговоры.',
    'step — один шаг на день: конкретное действие, которое можно сделать сегодня и бесплатно.',
    '',
    'Формат: {"summary": "…", "easier": "…", "careful": "…", "step": "…"}',
  ].join('\n');
}
