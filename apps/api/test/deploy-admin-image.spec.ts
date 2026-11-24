import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Б-2 (итерация 45): у админки есть образ, и он не «нарисован в документе».
 *
 * Дефект, который это закрывает: панель собиралась (`apps/admin/dist`) и даже
 * проверялась стражем мока, но **образа не существовало**. Значит деплой шёл
 * мимо общего пути (`docker compose`), руками, и «панель на сервере» было
 * состоянием машины, а не репозитория. Здесь зафиксированы четыре звена:
 * Dockerfile, сервис в compose, сборка в CI и публикация в release.
 *
 * Docker в песочнице агента нет, поэтому сам образ проверяет CI-джоба
 * `admin-image` (собирает и запускает контейнер). Этот спек ловит расхождение
 * файлов — то, что не видно, пока не начнёшь деплоить.
 */

const ROOT = join(__dirname, '../../..');

function read(relative: string): string {
  return readFileSync(join(ROOT, relative), 'utf8');
}

describe('Б-2: образ админки', () => {
  it('Dockerfile собирает панель со стражем мока и отдаёт статику из-под non-root', () => {
    const dockerfile = read('docker/admin.Dockerfile');

    // Сборка идёт штатной командой пакета: она включает `check-no-mock.mjs`.
    // Прямой `vite build` в образе обошёл бы стража.
    expect(dockerfile).toContain('pnpm --filter @astro-soul/admin build');
    expect(dockerfile).not.toMatch(/pnpm[^\n]*exec vite build/u);

    expect(dockerfile).toMatch(/FROM nginxinc\/nginx-unprivileged:1\.27-alpine/u);
    expect(dockerfile).toContain('USER 101:101');
    expect(dockerfile).toContain('HEALTHCHECK');
    // Конфиг панели — свой: DENY в iframe и запрет индексации.
    expect(dockerfile).toContain('docker/conf.d/admin.conf');
    expect(read('docker/conf.d/admin.conf')).toContain('X-Frame-Options "DENY"');
  });

  it('compose поднимает админку профилем и не публикует её наружу', () => {
    for (const file of ['docker-compose.yml', 'docker-compose.prod.yml']) {
      const compose = read(file);

      expect(compose).toMatch(/^ {2}admin:$/mu);
      // Порт — только loopback: снаружи панель закрывает nginx с TLS и
      // авторизацией, иначе экран бана доступен любому, кто дошёл до порта.
      expect(compose).toContain("'127.0.0.1:${ADMIN_HTTP_PORT:-8090}:8080'");
      expect(compose).not.toMatch(/'8090:8080'/u);
    }

    // Профиль — только в базовом файле: prod-оверлей его наследует, а второй
    // `profiles:` в оверлее — это уже другая панель, о которой никто не помнит.
    expect(read('docker-compose.yml')).toContain("profiles: ['admin']");
  });

  it('CI собирает и запускает контейнер, а не только артефакт', () => {
    const ci = read('.github/workflows/ci.yml');

    expect(ci).toMatch(/^ {2}admin-image:$/mu);
    expect(ci).toContain('docker build --file docker/admin.Dockerfile');
    // Запуск контейнера — единственная проверка «образ живой»: без него
    // Dockerfile может собираться и не отдавать ни одной страницы.
    expect(ci).toContain('docker run --detach --name admin-ci');
    expect(ci).toContain('X-Frame-Options');
  });

  it('release публикует образ админки в GHCR вместе с api и web', () => {
    const release = read('.github/workflows/release.yml');

    expect(release).toContain('ADMIN_IMAGE: ghcr.io/${{ github.repository_owner }}/astro-soul-admin');
    expect(release).toContain('file: docker/admin.Dockerfile');
    expect(release).toContain('${{ env.ADMIN_IMAGE }}:latest');
  });

  it('страж мока существует и вызывается сборкой панели', () => {
    // Без этого файла шаг сборки образа упадёт в CI — но лучше узнать об этом
    // из теста, чем из красной джобы после пуша.
    expect(existsSync(join(ROOT, 'apps/admin/scripts/check-no-mock.mjs'))).toBe(true);
    expect(read('apps/admin/package.json')).toContain('check-no-mock.mjs');
  });
});
