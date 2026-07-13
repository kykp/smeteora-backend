import { and, lt, or, sql } from 'drizzle-orm';
import fp from 'fastify-plugin';
import { type FastifyPluginAsync } from 'fastify';

import { idempotencyKeys, sessions } from '../db/schema/index.js';
import { runWithoutCompanyContext } from './with-company-context.js';

// Периодический cleanup служебных таблиц. Иначе они растут монотонно и в
// прод-инстансе за месяцы забивают диск / замедляют запросы.
//
//  idempotency_keys: TTL 24 часа хватает под любые ретраи. Строки с
//                    response_body jsonb — самые тяжёлые в системе, чистим
//                    агрессивно.
//  sessions:         revoked/expired строки держим неделю на случай пост-инцидент
//                    аналитики (кто когда логинился), потом сносим.
//
// Запускаем раз в час. Первый прогон — сразу при старте (чтобы после долгой
// остановки не ждать час прежде чем разгрести накопившееся).
//
// Cleanup идёт БЕЗ company-context — таблицы служебные, RLS не применяется.

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const IDEMPOTENCY_TTL_HOURS = 24;
const SESSIONS_EXPIRED_KEEP_DAYS = 7;
const SESSIONS_REVOKED_KEEP_DAYS = 30;

const cleanupJobsPlugin: FastifyPluginAsync = async (app) => {
  const runCleanup = async (): Promise<void> => {
    try {
      await runWithoutCompanyContext(app.db, async (tx) => {
        const idemp = await tx
          .delete(idempotencyKeys)
          .where(
            lt(
              idempotencyKeys.createdAt,
              sql`now() - interval '${sql.raw(String(IDEMPOTENCY_TTL_HOURS))} hours'`,
            ),
          )
          .returning({ key: idempotencyKeys.key });

        const sess = await tx
          .delete(sessions)
          .where(
            or(
              lt(
                sessions.expiresAt,
                sql`now() - interval '${sql.raw(String(SESSIONS_EXPIRED_KEEP_DAYS))} days'`,
              ),
              and(
                sql`${sessions.revokedAt} IS NOT NULL`,
                lt(
                  sessions.revokedAt,
                  sql`now() - interval '${sql.raw(String(SESSIONS_REVOKED_KEEP_DAYS))} days'`,
                ),
              ),
            ),
          )
          .returning({ id: sessions.id });

        if (idemp.length > 0 || sess.length > 0) {
          app.log.info(
            { idempotency: idemp.length, sessions: sess.length },
            'cleanup служебных таблиц',
          );
        }
      });
    } catch (err) {
      app.log.error({ err }, 'cleanup упал, попробуем через час');
    }
  };

  // Первый прогон — с небольшой задержкой, чтобы не блокировать старт.
  const initialTimer = setTimeout(() => void runCleanup(), 5_000);
  const intervalTimer = setInterval(() => void runCleanup(), CLEANUP_INTERVAL_MS);
  initialTimer.unref();
  intervalTimer.unref();

  app.addHook('onClose', async () => {
    clearTimeout(initialTimer);
    clearInterval(intervalTimer);
  });
};

export default fp(cleanupJobsPlugin, { name: 'cleanup-jobs', dependencies: ['db'] });
