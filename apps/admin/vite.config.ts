import react from '@vitejs/plugin-react';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';
import { adminMockApi } from './mock/plugin.ts';

/*
 * Сборка админ-панели. Правила, которые здесь защищаются кодом:
 *
 * 1. `API_MOCK=1` — только dev. В `vite build` переменная не просто
 *    игнорируется, а роняет сборку: «забыли выключить» не должно существовать
 *    как сценарий. Второй слой — проверка артефакта (`scripts/check-no-mock.mjs`).
 * 2. Один origin. API вызывается относительными путями (`/api/v1/...`), а
 *    `/api/*` на `admin.<домен>` проксирует реверс-прокси. CORS нет, cookie
 *    `SameSite=Lax` работает, сторонних cookie нет. Префикс не обрезается.
 * 3. Админка — отдельное приложение: в бандл `apps/web` она не входит ни при
 *    каких условиях, и наоборот.
 */

const BROWSER_TARGET = ['es2022'];
const DEV_PORT = 5199;

/** Значения `.env` репозитория плюс значения пакета: пакет переопределяет. */
function readEnv(mode: string): Record<string, string> {
  const repo = loadEnv(mode, new URL('../../', import.meta.url).pathname, '');
  const local = loadEnv(mode, process.cwd(), '');
  return { ...repo, ...local };
}

export default defineConfig(({ mode, command }) => {
  // Сборка не должна зависеть от того, кто её вызвал: CI ставит NODE_ENV=test,
  // и без этого шага в прод уехал бы dev-сбор React с `import.meta.env.DEV === true`.
  if (command === 'build') process.env.NODE_ENV = 'production';

  const env = readEnv(mode);
  const useMock = env.API_MOCK === '1';

  if (useMock && command === 'build') {
    throw new Error(
      'Сборка с API_MOCK=1 запрещена: mock-данные вымышленные, а артефакт этот — прод. ' +
        'Для локального просмотра интерфейса запускай `pnpm dev:admin` с API_MOCK=1.',
    );
  }

  const proxyTarget = env.API_PROXY_TARGET ?? 'http://localhost:8080';

  return {
    plugins: [
      react(),
      // Dev-only: в `command === 'serve'` и только по явной переменной.
      command === 'serve' &&
        adminMockApi({
          upstream: proxyTarget,
          // Пауза нужна, чтобы состояния «загрузка» были видны в браузере, а не мелькали.
          delayMs: Number(env.API_MOCK_DELAY ?? 200),
        }),
    ],
    // Единственный источник правды для клиента о том, что данные вымышлены:
    // значение подставляется из API_MOCK здесь, поэтому «мокер включили, а
    // плашку забыли» невозможно — они включают друг друга.
    define: {
      'import.meta.env.VITE_ADMIN_DEMO': JSON.stringify(useMock && command === 'serve' ? '1' : ''),
    },
    server: {
      host: true,
      port: Number(env.ADMIN_DEV_PORT ?? DEV_PORT),
      // /api/* → backend без rewrite: API ждёт префикс /api/v1, срезанный
      // префикс превращает каждый маршрут в 404.
      proxy: { '/api': { target: proxyTarget, changeOrigin: true } },
      // Dev-сервер смотрит на Host, и песочница/туннель (`*.e2b.app`,
      // `*.trycloudflare.com`) дают чужой — панель отвечала бы 403 на весь
      // preview. Настройки здесь только для `vite dev`: прод — статика за
      // nginx, который про `allowedHosts` ничего не знает.
      allowedHosts: true,
    },
    preview: { host: true, port: Number(env.ADMIN_PREVIEW_PORT ?? 5299), allowedHosts: true },
    build: { target: BROWSER_TARGET, cssTarget: BROWSER_TARGET, sourcemap: false },
    test: {
      environment: 'jsdom',
      setupFiles: ['./vitest.setup.ts'],
      restoreMocks: true,
    },
  };
});
