/**
 * Хранилище CSRF-токена. Отдельный модуль потому, что цикл получился бы
 * идеальный: токен отдаёт `GET /admin/me`, а этот запрос идёт через HTTP-слой,
 * который токен требует.
 *
 * Токен живёт только в памяти вкладки. Ни `localStorage`, ни `sessionStorage`,
 * ни логов: записанный в хранилище токен переживает закрытие вкладки и
 * читается любым скриптом на домене, а смысл CSRF-защиты в этом и теряется.
 */

export interface TokenStore {
  get(): string | null;
  set(token: string | null): void;
}

export function createTokenStore(): TokenStore {
  let token: string | null = null;
  return {
    get: () => token,
    set: (value) => {
      token = value;
    },
  };
}
