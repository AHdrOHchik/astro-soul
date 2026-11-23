import {
  MOON_ADVICE,
  MOON_ADVICE_FALLBACK,
  MOON_PHASES,
  type MoonPhaseLabel,
} from '../share/share.service';

/**
 * Текст утреннего пуша (итерация 38, контракт 1.6.13).
 *
 * Почему отдельный модуль, а не строки в `EngagementService`.
 *
 *   1. **Модель не вызывается.** Текст собирается из констант и фактов дня:
 *      каждый пуш с моделью стоил бы денег на человека в день и мог соврать —
 *      а пуш уходит от нашего имени в личный чат.
 *   2. **Требования проверяемы.** Всё, что можно посчитать (длина, эмодзи,
 *      экранирование, запрещённые темы), считается здесь и проверяется тестом —
 *      включая 96 комбинаций «8 фаз × 12 знаков».
 *   3. **Один шанс на первое впечатление.** Человек читает это на экране
 *      блокировки, до того как открыть приложение, поэтому правила жёсткие:
 *      ≤ 200 символов без кнопок, вторая строка ≤ 120, никаких чисел и
 *      обещаний.
 */

/**
 * Эмодзи фазы — по одной на каждую фазу `daily.PHASES`.
 *
 * Ключи типизированы фазой: добавить фазу в сайдкар и забыть эмодзи нельзя —
 * это ошибка компиляции, а не «звёздочка по умолчанию» в чужом чате.
 */
export const PHASE_EMOJI: Readonly<Record<MoonPhaseLabel, string>> = {
  новолуние: '🌑',
  'растущий серп': '🌒',
  'первая четверть': '🌓',
  'растущая Луна': '🌔',
  полнолуние: '🌕',
  'убывающая Луна': '🌖',
  'последняя четверть': '🌗',
  'убывающий серп': '🌘',
};

/**
 * Короткая подпись фазы для строки «Луна в X, …».
 *
 * Подписи сайдкара — существительные («растущая Луна», «первая четверть»), а в
 * строке уже есть слово «Луна»: `Луна в Рыбах, растущая Луна` звучит как опечатка.
 */
export const PHASE_SHORT: Readonly<Record<MoonPhaseLabel, string>> = {
  новолуние: 'новолуние',
  'растущий серп': 'растущий серп',
  'первая четверть': 'первая четверть',
  'растущая Луна': 'растущая',
  полнолуние: 'полнолуние',
  'убывающая Луна': 'убывающая',
  'последняя четверть': 'последняя четверть',
  'убывающий серп': 'убывающий серп',
};

/** Первая строка: отправка идёт только в 08:00 по местному, поэтому «утро» — факт. */
export const PUSH_GREETING = 'Доброе утро.';
/** Третья строка: одно и то же всегда. Узнаваемость важнее новизны. */
export const PUSH_INVITE = 'Разбор дня на 5 минут';
/** Кнопка мини-аппа: экран «Сегодня». */
export const PUSH_OPEN_TEXT = 'Открыть разбор дня';
/** Вторая кнопка: отказ от пушей прямо из чата. */
export const PUSH_OFF_TEXT = 'Отключить';
/** `callback_data` кнопки отказа. Обрабатывает вебхук, сообщение не шлётся. */
export const PUSH_OFF_CALLBACK = 'push_off';

/** Жёсткий лимит всего текста без кнопок. */
export const PUSH_MAX_CHARS = 200;
/** Лимит второй строки: длиннее — уже не читается с экрана блокировки. */
export const PUSH_LINE_MAX_CHARS = 120;

/**
 * Эмодзи, которых в пуше быть не должно.
 *
 * Это тот же запрет, что в бренд-гайде: мистика в первой строке сообщения
 * превращает продукт в «гороскоп». Эмодзи фазы — единственный разрешённый.
 */
export const FORBIDDEN_EMOJI: readonly string[] = ['🔮', '✨', '🪐', '🔯', '🙏', '🌠', '⭐', '💫'];

/**
 * Экранирование для `parse_mode: HTML`.
 *
 * `&` — первым, иначе `&lt;` превратится в `&amp;lt;`. Знак, фаза и имя
 * продукта приходят из данных и конфига: одно неэкранированное `_` или `<` — и
 * Bot API отвечает 400, а человек не получает ничего.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;');
}

export interface PushTextInput {
  /** Знак Луны как его назвал сайдкар («Рыбы»). */
  readonly sign: string;
  /** Подпись фазы из `daily.PHASES` («растущая Луна»). */
  readonly phase: string;
}

export interface PushMessage {
  /** Текст для `sendMessage` (`parse_mode: HTML`, уже экранированный). */
  readonly text: string;
  /** Длина без HTML-сущностей — по ней проверяется лимит 200. */
  readonly visibleLength: number;
}

/**
 * Вторая строка: `Луна в <знак>, <фаза> — <фраза>`.
 *
 * Фраза берётся из `MOON_ADVICE` — тех же констант, что карточка `moon` и
 * карточка дня: пуш не выдумывает текст на месте и не расходится с тем, что
 * человек увидит в приложении. Если строка не влезает в 120 символов, режем
 * **по границе предложения**: обрезка по словам ломает смысл («день про план, а
 * не про рыв…»).
 */
export function pushLine(sign: string, phase: string): string {
  const advice = adviceFor(phase);
  const short = PHASE_SHORT[phase as MoonPhaseLabel] ?? phase;
  const head = `Луна в ${sign}, ${short}`;
  const candidate = `${head} — ${advice}`;

  if (candidate.length <= PUSH_LINE_MAX_CHARS) {
    return candidate;
  }

  // Первое предложение совета — самостоятельная мысль; если и оно не влезает,
  // оставляем только факт: лучше короткая правда, чем обрубок совета.
  const firstSentence = firstSentenceOf(advice);
  const withFirst = `${head} — ${firstSentence}`;

  return withFirst.length <= PUSH_LINE_MAX_CHARS ? withFirst : head;
}

function adviceFor(phase: string): string {
  // Та же запасная строка, что у карточки `moon`: незнакомая фаза не должна
  // появляться в пуше выдумкой.
  return (MOON_ADVICE as Readonly<Record<string, string>>)[phase] ?? MOON_ADVICE_FALLBACK;
}

function firstSentenceOf(text: string): string {
  const match = /^.*?[.!?…](?=\s|$)/u.exec(text);
  return match === null ? text : match[0];
}

/**
 * Полный текст пуша: приветствие с эмодзи фазы, строка факта, приглашение.
 *
 * Строки разделены пустой строкой: на экране блокировки Telegram показывает
 * 3–4 строки, и без пустых строк «Разбор дня на 5 минут» слипается с фактом.
 */
export function buildPushMessage(input: PushTextInput): PushMessage {
  const emoji = PHASE_EMOJI[input.phase as MoonPhaseLabel] ?? '🌙';
  const visible = [
    `${emoji} ${PUSH_GREETING}`,
    pushLine(input.sign, input.phase),
    PUSH_INVITE,
  ].join('\n\n');

  return {
    text: visible
      .split('\n\n')
      .map((line) => escapeHtml(line))
      .join('\n\n'),
    visibleLength: visible.length,
  };
}

/** Фазы, для которых есть эмодзи и короткая подпись: ровно список сайдкара. */
export const PUSH_PHASES: readonly MoonPhaseLabel[] = MOON_PHASES;
