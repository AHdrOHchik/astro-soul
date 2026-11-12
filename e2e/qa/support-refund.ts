/**
 * QA-стенд: возврат «по запросу через поддержку» (payments.md §3.5).
 *
 * Эндпоинта для возврата в API нет — поддержка вызывает `PaymentsService.refund`
 * из кода. Поэтому проверяем ровно этот путь: поднимаем контекст приложения
 * и вызываем сервис так, как это сделал бы скрипт поддержки.
 *
 * Запуск (из apps/api, с теми же переменными окружения, что у API):
 *   pnpm exec tsx ../../e2e/qa/support-refund.ts <telegram_payment_charge_id>
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../apps/api/src/app.module';
import { PaymentsService } from '../../apps/api/src/modules/billing/payments.service';
import { DbService } from '../../apps/api/src/db/db.service';

async function main(): Promise<void> {
const chargeId = process.argv[2];
if (chargeId === undefined) {
  process.stderr.write('нужен telegram_payment_charge_id\n');
  process.exit(2);
}

const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
const payments = app.get(PaymentsService);
const db = app.get(DbService);

const before = await db.query(
  `SELECT p.status, (SELECT count(*) FROM entitlements e WHERE e.payment_id = p.id AND e.status = 'active') AS active_grants
     FROM payments p WHERE p.telegram_payment_charge_id = $1`,
  [chargeId],
);
process.stdout.write(`до возврата: ${JSON.stringify(before)}\n`);

const ok = await payments.refund(chargeId, 'qa_support_request');
process.stdout.write(`refund() -> ${String(ok)}\n`);

const after = await db.query(
  `SELECT p.status, (SELECT count(*) FROM entitlements e WHERE e.payment_id = p.id AND e.status = 'active') AS active_grants
     FROM payments p WHERE p.telegram_payment_charge_id = $1`,
  [chargeId],
);
process.stdout.write(`после возврата: ${JSON.stringify(after)}\n`);

const again = await payments.refund(chargeId, 'qa_support_request');
process.stdout.write(`повторный refund() -> ${String(again)} (ожидание: false)\n`);

await app.close();
}

void main();
