/**
 * Пути, доступные без initData.
 *
 * Правило (SPEC): middleware на всех `/api/v1/*`, кроме `/health`.
 * Отдельно отмечены маршруты, у которых в контракте `security: []`,
 * но своя защита — их реализация появится в следующих итерациях:
 *   - /api/v1/charts/{id}/wheel.svg — подписанный `?sig=`;
 *   - /api/v1/internal/telegram/webhook/{secret} — секрет в пути + заголовок;
 *   - /api/v1/internal/jobs/run — секрет джоба.
 * Пока обработчиков нет — список закрыт, добавление требует правки здесь.
 */
const PUBLIC_PATHS: ReadonlySet<string> = new Set(['/api/v1/health', '/health']);

export function isPublicPath(requestPath: string): boolean {
  const normalized = requestPath.length > 1 ? requestPath.replace(/\/+$/, '') : requestPath;
  return PUBLIC_PATHS.has(normalized);
}
