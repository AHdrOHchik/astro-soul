import type { LlmProvider, LlmRequest, LlmResponse } from './llm.client';

/**
 * Подставной провайдер: работает без сети и без денег.
 *
 * Включается, когда ключей GigaChat нет (или явно `LLM_FAKE=1`). Это не
 * «тихая заглушка»: имя провайдера пишется в лог и в `reports.model`, поэтому
 * в проде сразу видно, что разбор собран не моделью.
 *
 * Текст здесь нарочно простой, но он проходит все валидаторы формата:
 * каждая глава получает свою тему (`{t}` в шаблонах), поэтому пересечение по
 * 8-граммам между главами близко к нулю, а объём укладывается в `structure_v1`.
 * Литературных достоинств у него нет — судья в этом режиме не вызывается.
 */
const TOPIC: Readonly<Record<string, string>> = {
  core: 'решения',
  emotions: 'чувства',
  talents: 'дело',
  relations: 'близость',
  money: 'цена',
  purpose: 'направление',
  summary: 'итог',
};

const TEMPLATES: readonly string[] = [
  'Когда дело касается {t}, ты долго выбираешь темп для {t} и редко об этом жалеешь.',
  'Ты держишь {t} в поле зрения, но не позволяешь {t} задавать тебе скорость.',
  'Твоя сила в {t} проявляется тихо: {t} работает, пока другие обсуждают подход.',
  'В разговорах про {t} ты сначала проверяешь опору, потом цену {t}.',
  'Тебе важно, чтобы {t} шло своим ходом, поэтому {t} редко бывает быстрым.',
  'Ты не любишь показывать, сколько {t} держишь внутри, и прячешь {t} за спокойствием.',
  'Ошибку в {t} ты замечаешь раньше других и потом долго возвращаешься к {t}.',
  'Когда {t} требует решения, ты берёшь паузу, и эта пауза в {t} тебя не подводит.',
  'Твой способ вести {t} выглядит медленным, зато {t} почти не даёт сбоев.',
  'Про {t} ты говоришь мало, но каждое слово про {t} у тебя взвешено.',
  'Тебя успокаивает, когда {t} движется ровно, и раздражает, когда {t} торопят.',
  'В {t} ты опираешься на проверенное, и это делает {t} надёжным, но не быстрым.',
];

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
    const price = this.options.pricePer1kRub ?? 0.5;

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

  /** Текст нужной длины: шаблоны со своей темой главы, без запрещённых тем. */
  private filler(section: string, length: number): string {
    const topic = TOPIC[section] ?? 'тема';
    const sentences: string[] = [];
    let index = 0;

    while (sentences.join(' ').length < length) {
      const template = TEMPLATES[index % TEMPLATES.length] ?? '';
      sentences.push(template.replaceAll('{t}', topic));
      index += 1;
      // Страховка от бесконечного цикла при пустом списке шаблонов.
      if (index > 40) {
        break;
      }
    }

    return sentences.join(' ');
  }
}
