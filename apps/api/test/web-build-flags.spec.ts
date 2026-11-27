import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Б-1, итерация 45: `VITE_NOTIFICATIONS_UI` обязан доезжать до сборки web.
 *
 * Как выглядела поломка: флаг есть в `apps/web/src/config.ts`, есть в
 * `apps/web/.env.example`, есть в `vars` релизного workflow — и при этом
 * `docker/web.Dockerfile` его не объявлял. Сборка образа в compose передавала
 * только четыре `VITE_*`, поэтому значение молча терялось: `import.meta.env.
 * VITE_NOTIFICATIONS_UI` в бандле становился `undefined`, экран согласия
 * оставался скрытым, а `PUSH_ENABLED=1` слал пуши, от которых нельзя
 * отказаться из приложения.
 *
 * Проверка идёт по трём звеньям одной цепи (`.env` → compose → Dockerfile →
 * `import.meta.env`), потому что порваться может любое: файлы читаются как
 * текст — ровно те буквальные строки, которые видит docker.
 */

const ROOT = join(__dirname, '../../..');
const DOCKERFILE = join(ROOT, 'docker/web.Dockerfile');
const COMPOSE = join(ROOT, 'docker-compose.yml');
const ENV_EXAMPLE = join(ROOT, '.env.example');
const WEB_CONFIG = join(ROOT, 'apps/web/src/config.ts');

const read = (path: string): string => readFileSync(path, 'utf8');

describe('Б-1: VITE_NOTIFICATIONS_UI доезжает до сборки web', () => {
  it('Dockerfile объявляет ARG и передаёт его в pnpm build', () => {
    const dockerfile = read(DOCKERFILE);

    expect(dockerfile).toMatch(/^ARG VITE_NOTIFICATIONS_UI=/mu);
    // Недостаточно объявить ARG: без передачи в команду сборки значение так и
    // останется переменной Docker, а не переменной Vite.
    expect(dockerfile).toMatch(/VITE_NOTIFICATIONS_UI="\$\{VITE_NOTIFICATIONS_UI\}"/u);
    // Дефолт — выключено: «забыли передать» не должно включать UI само по себе.
    expect(dockerfile).toMatch(/^ARG VITE_NOTIFICATIONS_UI="0"$/mu);
  });

  it('compose передаёт флаг в build.args с дефолтом 0', () => {
    const compose = read(COMPOSE);

    expect(compose).toContain('VITE_NOTIFICATIONS_UI: ${VITE_NOTIFICATIONS_UI:-0}');
    // Build-args живут в блоке сборки web, а не в environment контейнера:
    // в рантайме эта переменная ничего не значит.
    const webBlock = compose.slice(compose.indexOf('dockerfile: docker/web.Dockerfile'));
    expect(webBlock).toContain('VITE_NOTIFICATIONS_UI: ${VITE_NOTIFICATIONS_UI:-0}');
  });

  it('флаг описан в корневом .env.example выключенным', () => {
    const env = read(ENV_EXAMPLE);

    const lines = env.split('\n').filter((line) => line.startsWith('VITE_NOTIFICATIONS_UI='));
    expect(lines).toEqual(['VITE_NOTIFICATIONS_UI=0']);
    // Рядом должно быть сказано, что порядок важен: сначала PUSH_ENABLED.
    expect(env).toContain('PUSH_ENABLED=1');
  });

  it('web читает именно ту переменную, которую прокидывают', () => {
    // Единственная связь между Dockerfile и кодом — литерал в config.ts.
    // Если её переименуют, предыдущие проверки останутся зелёными и флаг
    // снова перестанет работать — поэтому проверяется и она.
    expect(read(WEB_CONFIG)).toContain("import.meta.env.VITE_NOTIFICATIONS_UI === '1'");
  });

  it('релизный workflow не собирает бандл с включённым флагом без ARG', () => {
    // Гард существует в release.yml с итерации 44; проверим, что он на месте —
    // иначе регрессия вернётся уже на деплое, а не в PR.
    const workflow = read(join(ROOT, '.github/workflows/release.yml'));

    expect(workflow).toContain('ARG VITE_NOTIFICATIONS_UI');
    expect(workflow).toContain('VITE_NOTIFICATIONS_UI: ${{ vars.VITE_NOTIFICATIONS_UI }}');
  });
});
