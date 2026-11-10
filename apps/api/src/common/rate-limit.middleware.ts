import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { APP_ENV } from '../config/env.module';
import type { AppEnv } from '../config/env';
import { currentRequestId, requestPath } from '../common/request-context';
import { rateLimited } from '../common/api-error';
import { sendProblemResponse } from '../common/problem-response';
import { isPublicPath } from '../modules/auth/public-routes';
import type { AuthenticatedRequest } from '../modules/auth/init-data.middleware';

/** Окно — минута: лимиты в SPEC заданы «в минуту». */
const WINDOW_MS = 60_000;

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly limit: number;
  readonly remaining: number;
  readonly resetSeconds: number;
}

/**
 * Счётчик в памяти процесса: окно в минуту на ключ.
 *
 * Redis в песочнице нет, а тянуть его ради лимитов на одном инстансе рано.
 * Ограничение честно записано в README: при горизонтальном масштабировании
 * счётчики нужно вынести в Redis, иначе лимит умножается на число подов.
 */
export class WindowLimiter {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  hit(key: string, limit: number, windowMs: number = WINDOW_MS): RateLimitDecision {
    const now = this.now();
    const bucket = this.buckets.get(key);

    if (bucket === undefined || bucket.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + windowMs });
      // Периодическая уборка вместо таймера: не держим event loop открытым.
      if (this.buckets.size > 5_000) {
        this.sweep(now);
      }
      return { allowed: true, limit, remaining: limit - 1, resetSeconds: Math.ceil(windowMs / 1000) };
    }

    bucket.count += 1;
    const allowed = bucket.count <= limit;

    return {
      allowed,
      limit,
      remaining: Math.max(0, limit - bucket.count),
      resetSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    };
  }

  reset(): void {
    this.buckets.clear();
  }

  private sweep(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) {
        this.buckets.delete(key);
      }
    }
  }
}

/**
 * Лимиты запросов (SPEC): 60 в минуту на пользователя по умолчанию,
 * 10 на создание карты (дорогая операция), 120 на подсказки городов
 * (это чтение — фронт дёргает его на каждый ввод).
 */
export function limitFor(method: string, path: string, env: AppEnv): number {
  if (path === '/api/v1/charts' && method === 'POST') {
    return env.RATE_LIMIT_CHARTS_PER_MIN;
  }
  if (path === '/api/v1/geo/resolve') {
    return env.RATE_LIMIT_GEO_PER_MIN;
  }
  return env.RATE_LIMIT_PER_MIN;
}

export function rateLimitKey(req: Request): string {
  const auth = (req as Partial<AuthenticatedRequest>).initData;
  if (auth !== undefined) {
    return `u:${auth.user.id.toString()}`;
  }
  // Без авторизации остаётся IP: так лимит работает и до входа в приложение.
  return `ip:${req.ip ?? 'unknown'}`;
}

@Injectable()
export class RateLimitMiddleware implements NestMiddleware {
  private readonly limiter = new WindowLimiter();

  constructor(@Inject(APP_ENV) private readonly env: AppEnv) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const path = requestPath(req);

    // Публичные маршруты (health, колесо по подписи, вебхук) не лимитируем:
    // health дёргает мониторинг, вебхук — Telegram, колесо — тег <img>.
    if (req.method === 'OPTIONS' || isPublicPath(path)) {
      next();
      return;
    }

    const limit = limitFor(req.method, path, this.env);
    if (limit <= 0) {
      next();
      return;
    }

    const decision = this.limiter.hit(`${rateLimitKey(req)}:${path}:${req.method}`, limit);

    res.setHeader('RateLimit-Limit', String(decision.limit));
    res.setHeader('RateLimit-Remaining', String(decision.remaining));
    res.setHeader('RateLimit-Reset', String(decision.resetSeconds));

    if (!decision.allowed) {
      res.setHeader('Retry-After', String(decision.resetSeconds));
      sendProblemResponse(
        res,
        rateLimited({
          reason: 'rate_limit',
          details: { limit: decision.limit, window_seconds: 60 },
        }),
        currentRequestId(),
      );
      return;
    }

    next();
  }
}
