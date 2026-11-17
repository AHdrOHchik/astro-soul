/**
 * Таблица моделей и цен — единственное место, где живёт цена токена.
 *
 * Владелец (итерация 8, вопрос 3): «0,5 — это GigaChat 3 Ultra, 0,65 — 2 Max.
 * В коде должно быть то, что стоит в `LLM_MODEL`… Одна константа, берётся из
 * той же таблицы, что и имя модели». Поэтому отдельной переменной окружения
 * для цены нет: расхождение имени модели и цены на 30 % портило бы
 * `llm_cost_rub`, а по нему считаются решения по деньгам.
 *
 * Цена указана за 1000 токенов, вход и выход по одной цене (блок владельца).
 * Новая модель — новая строка здесь; неизвестная модель не поднимает сервис.
 */
export interface LlmModelSpec {
  readonly id: string;
  /** Рубли за 1000 токенов. */
  readonly pricePer1kRub: number;
}

export const LLM_MODELS: readonly LlmModelSpec[] = [
  { id: 'GigaChat-3-Ultra', pricePer1kRub: 0.5 },
  { id: 'GigaChat-2-Max', pricePer1kRub: 0.65 },
];

/** Модель по умолчанию: та, что в контракте и в блоке владельца. */
export const DEFAULT_LLM_MODEL = 'GigaChat-3-Ultra';

export function llmModelSpec(id: string): LlmModelSpec | null {
  return LLM_MODELS.find((model) => model.id === id) ?? null;
}

export function pricePer1kRubFor(id: string): number | null {
  return llmModelSpec(id)?.pricePer1kRub ?? null;
}

export const LLM_MODEL_IDS: readonly string[] = LLM_MODELS.map((model) => model.id);

/** Сколько токенов списал провайдер. Обе половины нужны по отдельности, чтобы `usage` в логе было честным. */
export interface LlmUsageTokens {
  readonly promptTokens: number;
  readonly completionTokens: number;
}

/**
 * Стоимость вызова: **(prompt_tokens + completion_tokens) / 1000 × цена за 1000
 * токенов**, округление до 0,0001 ₽.
 *
 * Считается только по `usage` провайдера. Длина строки в символах — не деньги:
 * на русском знак ≈ 0,36 токена, поэтому счёт по знакам завышал стоимость почти
 * втрое (итерация 23, `cost_rub` в `compat:dry-run`).
 */
export function costRubOf(usage: LlmUsageTokens, pricePer1kRub: number): number {
  const tokens = usage.promptTokens + usage.completionTokens;
  return Math.round(((tokens / 1000) * pricePer1kRub + Number.EPSILON) * 10_000) / 10_000;
}
