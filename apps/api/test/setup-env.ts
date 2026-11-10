import { applyTestEnv } from './test-env';

// Порядок важен: env выставляется до инициализации модулей приложения.
applyTestEnv();
