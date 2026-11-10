import { createHmac } from 'node:crypto';

/**
 * Внутренний UUID пользователя = HMAC-SHA256(PSEUDONYM_PEPPER, "telegram:<id>").
 *
 * Зачем детерминированный, а не случайный:
 *  - `DELETE /me` удаляет строку `users` (ПДн), но подписка и платежи должны
 *    остаться и продолжать указывать на того же субъекта (SPEC, сценарий 6);
 *  - когда человек вернётся, ему выдаётся тот же UUID, и доступ не теряется;
 *  - обратно в telegram_id значение не разворачивается, поэтому это не ПДн.
 *
 * Формат UUID — как у v5 (номера версии/варианта выставлены вручную),
 * но хеш SHA-256, а не SHA-1.
 */
export function userIdFromTelegramId(telegramUserId: bigint, pepper: string): string {
  const digest = createHmac('sha256', pepper)
    .update(`telegram:${telegramUserId.toString()}`)
    .digest();

  const bytes = Buffer.from(digest.subarray(0, 16));
  const versionByte = bytes[6] ?? 0;
  const variantByte = bytes[8] ?? 0;
  bytes[6] = (versionByte & 0x0f) | 0x50;
  bytes[8] = (variantByte & 0x3f) | 0x80;

  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}
