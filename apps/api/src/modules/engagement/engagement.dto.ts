import { z } from 'zod';
import { invalidFields, type FieldErrorInput } from '../../common/api-error';

export const askRequestSchema = z.object({
  chart_id: z.string().uuid(),
  question: z.string().trim().min(3).max(500),
});

export type AskRequestBody = z.infer<typeof askRequestSchema>;

/** Ошибки полей — тем же форматом `field_errors`, что и везде (QA-8). */
export function parseAskRequest(body: unknown): AskRequestBody {
  const parsed = askRequestSchema.safeParse(body);
  if (!parsed.success) {
    const errors: FieldErrorInput[] = parsed.error.issues.map((issue) => ({
      field: issue.path.join('.') === '' ? 'question' : issue.path.join('.'),
      message:
        issue.path[0] === 'question'
          ? 'Вопрос — от 3 до 500 знаков'
          : `${issue.path.join('.')} — проверь значение`,
    }));

    throw invalidFields(errors, { reason: 'ask_request_invalid' });
  }

  return parsed.data;
}
