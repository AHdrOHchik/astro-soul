import type { LlmProvider, LlmRequest, LlmResponse } from './llm.client';

/**
 * Подставной провайдер: работает без сети и без денег.
 *
 * Включается, когда ключей GigaChat нет (или явно `LLM_FAKE=1`). Это не
 * «тихая заглушка»: имя провайдера пишется в лог и в `reports.model`, поэтому
 * в проде сразу видно, что разбор собран не моделью.
 *
 * Текст здесь нарочно простой, но он проходит все валидаторы формата и
 * приёмки: 3–6 абзацев по 2–4 предложения (QA-22), доля частотного слова ниже
 * 12 %, каждая глава со своей темой (`{t}`), поэтому пересечение по 8-граммам
 * между главами близко к нулю, а объём укладывается в `structure_v1.1`.
 * Литературных достоинств у него нет — судья в этом режиме не вызывается.
 *
 * Денег он не стоит: `pricePer1kRub` по умолчанию 0. Иначе QA-прогон писал бы
 * в `llm_cost_rub` рубли по цене GigaChat Ultra, которого не было в вызове
 * (QA-002, задача 2).
 */
/**
 * Темы глав: по шесть синонимов на главу.
 *
 * Два ограничения держат заглушку в рамках приёмки одновременно:
 *   • слово темы стоит в каждом предложении дважды — иначе пересечение по
 *     8-граммам между главами превышает 12 % (`repeats`);
 *   • синонимы чередуются — иначе одно слово занимает больше 12 % главы
 *     (`word_share`, QA-22).
 * Падежи не согласованы: это заглушка, литературных достоинств у неё нет.
 */
const TOPIC: Readonly<Record<string, readonly string[]>> = {
  core: ['решения', 'выборы', 'шаги', 'опоры', 'ритмы', 'паузы'],
  emotions: ['чувства', 'переживания', 'настроения', 'волны', 'тепло', 'тишину'],
  talents: ['дела', 'умения', 'навыки', 'работу', 'точность', 'ремонт'],
  relations: ['близость', 'доверие', 'разговоры', 'дистанцию', 'теплоту', 'границы'],
  money: ['цены', 'деньги', 'счёт', 'запас', 'сроки', 'расходы'],
  purpose: ['направление', 'смысл', 'путь', 'движение', 'курс', 'дело'],
  summary: ['итог', 'вывод', 'шаги', 'порядок', 'опору', 'ритм'],
};

/** Начало предложения: 4 слова до первого слова темы. */
const LEADS: readonly string[] = [
  'Когда речь заходит про',
  'В разговоре про',
  'Ты держишь в поле зрения',
  'Тебе важно, чтобы',
  'Ты не любишь показывать, сколько',
  'Ошибку замечаешь раньше других в',
  'Твой способ вести дело — это',
  'Про себя ты говоришь мало про',
  'Тебя успокаивает ровный ритм в',
  'Ты опираешься на проверенное в',
  'Тебе легче начать, когда понятен',
  'В неясной ситуации ты ищешь',
  'Ты умеешь ждать, но плохо переносишь',
  'Чужое давление усиливает упрямство сильнее',
  'Ты возвращаешься к незакрытым',
  'Твоя осторожность выглядит как холодность в',
  'Ты редко торопишься, когда',
  'Тебе знакомо чувство, что',
];

/** Середина: 4 слова между двумя словами темы (второе встаёт на 10-е место). */
const MIDS: readonly string[] = [
  'и не позволяешь суете задавать',
  'но не даёшь спешке испортить',
  'и проверяешь опору перед',
  'потому что спешка редко помогает',
  'и держишь паузу вокруг',
  'но не превращаешь это в',
  'и возвращаешься мысленно к',
  'зато почти не даёшь сбоев в',
  'и каждое слово у тебя взвешено про',
  'хотя внутри всё наоборот про',
];

/** Хвост: 4 слова после второго слова темы. */
const TAILS: readonly string[] = [
  'и это редко подводит',
  'поэтому ты не спешишь',
  'и это даёт опору',
  'без лишнего шума',
  'когда остальные спорят',
  'и это стоит темпа',
  'ровно настолько, насколько нужно',
  'и спокойствие здесь честное',
  'в этом ты последователен',
  'и это твой способ',
];

/** Раскладывает предложения в абзацы по 2–4 предложения, всего 3–6 абзацев. */
function packParagraphs(sentences: readonly string[]): string {
  if (sentences.length === 0) {
    return '';
  }

  const paragraphCount = Math.min(6, Math.max(3, Math.ceil(sentences.length / 3)));
  const base = Math.floor(sentences.length / paragraphCount);
  const extra = sentences.length % paragraphCount;
  const paragraphs: string[] = [];
  let cursor = 0;

  for (let index = 0; index < paragraphCount; index += 1) {
    const size = Math.max(1, base + (index < extra ? 1 : 0));
    const slice = sentences.slice(cursor, cursor + size);
    cursor += size;
    if (slice.length > 0) {
      paragraphs.push(slice.join(' '));
    }
  }

  if (cursor < sentences.length) {
    paragraphs[paragraphs.length - 1] = `${paragraphs[paragraphs.length - 1]} ${sentences
      .slice(cursor)
      .join(' ')}`;
  }

  return paragraphs.join('\n\n');
}

export class FakeLlmProvider implements LlmProvider {
  readonly name = 'fake-llm';

  constructor(
    private readonly options: {
      /** Сколько «токенов» списывать за вызов: для проверки лимитов. */
      readonly tokensPerCall?: number;
      readonly pricePer1kRub?: number;
      /** Заставить провайдера падать — для проверки `failed` и возврата. */
      readonly fail?: boolean;
      /** Наблюдатель за запросами: тесты проверяют, что в промпте нет ПДн. */
      readonly onRequest?: (request: LlmRequest) => void;
    } = {},
  ) {}

  complete(request: LlmRequest): Promise<LlmResponse> {
    if (this.options.fail === true) {
      return Promise.reject(new Error('fake provider: отказ по требованию теста'));
    }

    this.options.onRequest?.(request);

    const prompt = request.messages.map((message) => message.content).join('\n');
    const tokens = this.options.tokensPerCall ?? 1_000;
    // Подставной провайдер ничего не стоит. Тесты лимитов передают цену явно.
    const price = this.options.pricePer1kRub ?? 0;

    return Promise.resolve({
      content: this.contentFor(prompt),
      model: this.name,
      usage: {
        promptTokens: Math.round(tokens * 0.8),
        completionTokens: Math.round(tokens * 0.2),
        totalTokens: tokens,
        costRub: Math.round(((tokens / 1000) * price + Number.EPSILON) * 10_000) / 10_000,
      },
    });
  }

  /** Ответ зависит от стадии: план — JSON, глава — текст, итог — с дисклеймером. */
  private contentFor(prompt: string): string {
    if (prompt.includes('Ответ — строго JSON')) {
      return JSON.stringify({
        thesis:
          'Ты медленно решаешься, но, решившись, почти не отступаешь, и это стоит тебе части возможностей.',
        focuses: [
          { topic: 'скорость решений', factor: 'Солнце в Тельце', angle: 'цена позднего старта' },
          { topic: 'видимость', factor: 'Луна в Льве', angle: 'заметность без позы' },
        ],
        avoid: ['не повторять про медлительность', 'не оценивать', 'не обещать'],
      });
    }

    const section = /Глава:\s*([a-z]+)/u.exec(prompt)?.[1] ?? 'core';

    if (section === 'summary' || prompt.includes('Напиши заключительную главу')) {
      return `${this.filler('summary', 520)} Разбор — инструмент саморефлексии, а не предсказание и не замена специалисту.`;
    }

    // Объём берём из запроса: `Объём: 1 200–1 550 знаков`.
    const range = /Объём:\s*([\d\s]+)–([\d\s]+)\s*знаков/u.exec(prompt);
    const min = range?.[1] === undefined ? 1_200 : Number(range[1].replace(/\s/gu, ''));
    return this.filler(section, min);
  }

  /**
   * Текст нужной длины: шаблоны со своей темой главы, без запрещённых тем,
   * разложенные в 3–6 абзацев по 2–4 предложения (QA-22).
   */
  private filler(section: string, length: number): string {
    const topics = TOPIC[section] ?? ['тема', 'темы', 'тему', 'теме', 'темой', 'темах'];
    const sentences: string[] = [];
    let index = 0;

    while (sentences.join(' ').length < length && index < 40) {
      const lead = LEADS[index % LEADS.length] ?? '';
      const mid = MIDS[index % MIDS.length] ?? '';
      const tail = TAILS[index % TAILS.length] ?? '';
      // Синоним чередуется, чтобы одно слово не заняло больше 12 % главы.
      const first = topics[index % topics.length] ?? 'тема';
      const second = topics[(index + 3) % topics.length] ?? first;
      // Смещение по главам: даже одинаковые фразы дают разные 8-граммы.
      const offset = section.length % 5;
      const lead2 = LEADS[(index + offset) % LEADS.length] ?? lead;
      sentences.push(`${lead2} ${first} ${mid} ${second} ${tail}.`);
      index += 1;
    }

    return packParagraphs(sentences);
  }
}
