import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * GHCR: имя репозитория — только в нижнем регистре.
 *
 * Найдено по ходу итерации 45. Владелец дважды поправил `release.yml` прямо в
 * `main` (`08b9255`) именно из-за этого: `github.repository_owner` = `AHdrOHchik`,
 * а GHCR принимает только `ahdrohchik`. Сборка падала **до** первого шага, то
 * есть «релиз красный» не имело отношения к коду.
 *
 * Когда это выяснилось, выяснилось и второе: ту же ошибку содержал деплой.
 * `deploy.yml` передаёт в `scripts/deploy/remote-release.sh` владельца как есть,
 * скрипт собирает `ghcr.io/${OWNER}/astro-soul-api:${TAG}` — и `docker pull`
 * падал бы на «invalid reference format» уже после успешной публикации образа
 * в нижнем регистре. Сборка и выкладка смотрели на разные имена одного пакета.
 *
 * Тест держит оба конца: имена в workflow считаются в шелле, деплой приводит
 * владельца к нижнему регистру, и нигде не остаётся прямого
 * `github.repository_owner` в имени образа.
 */

const ROOT = join(__dirname, '../../..');

function read(relative: string): string {
  return readFileSync(join(ROOT, relative), 'utf8');
}

describe('GHCR: имена образов в нижнем регистре на обоих концах', () => {
  it('release считает имена шагом в шелле, а не выражением Actions', () => {
    const release = read('.github/workflows/release.yml');

    // В выражениях GitHub Actions нет `lowercase`, поэтому имя считается в bash.
    expect(release).toContain('owner="${GITHUB_REPOSITORY_OWNER,,}"');
    expect(release).toContain('ghcr.io/${owner}/astro-soul-api');
    expect(release).toContain('ghcr.io/${owner}/astro-soul-web');
    expect(release).toContain('ghcr.io/${owner}/astro-soul-admin');

    // Прямое использование owner-а в имени образа вернуло бы заглавные буквы.
    expect(release).not.toMatch(/ghcr\.io\/\$\{\{\s*github\.repository_owner/u);
  });

  it('деплой приводит владельца к нижнему регистру до сборки ссылок', () => {
    const deploy = read('scripts/deploy/remote-release.sh');

    expect(deploy).toContain('OWNER="${OWNER_RAW,,}"');
    // Ссылки собираются уже из нормализованного значения.
    expect(deploy).toContain('api_ref="ghcr.io/${OWNER}/astro-soul-api:${TAG}"');
    expect(deploy).toContain('web_ref="ghcr.io/${OWNER}/astro-soul-web:${TAG}"');
    // Сырое значение используется ровно один раз — в присваивании.
    expect(deploy.match(/\$\{OWNER_RAW/gu)?.length ?? 0).toBe(1);
  });

  it('нормализация действительно работает: шаг img и deploy одинаковы', () => {
    // Не проверка bash-поведения, а проверка одного факта: обе стороны
    // используют один и тот же приём (`${…,,}`), а не «одна считает, другая
    // надеется». Это и было причиной расхождения.
    expect(read('.github/workflows/release.yml')).toContain('${GITHUB_REPOSITORY_OWNER,,}');
    expect(read('scripts/deploy/remote-release.sh')).toContain('${OWNER_RAW,,}');
  });
});
