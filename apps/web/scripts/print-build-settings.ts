/*
 * The first step of `pnpm build`: what the bundle is about to be built with, said before
 * anything else is printed (scripts/buildSettings.ts). A value nobody can read stops the
 * build right here; a value that is missing does not.
 *
 * Run by Node as it is: the engines this package asks for strip the types themselves.
 */
import { loadEnv } from 'vite';
import { readBuildSettings } from './buildSettings.ts';

try {
  // The variables `vite build` itself will read: the environment and the .env files of a production build.
  const { lines } = readBuildSettings(loadEnv('production', process.cwd(), ''));
  process.stdout.write(`${lines.join('\n')}\n`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
