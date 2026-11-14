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
