import fp from 'fastify-plugin';
import { type FastifyPluginAsync, type FastifyRequest } from 'fastify';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { sessions, memberships, companies, type Session } from '../db/schema/index.js';
import { type Role } from '../db/constants.js';
import { UnauthorizedError } from '../lib/errors.js';
import { SESSION_COOKIE_NAME } from '../lib/session-cookie.js';

// AuthContext заполняется authenticate() из cookie + БД. Хендлеры читают
// его через request.ctx, никаких прямых обращений к sessions в бизнес-коде.
export type AuthContext = {
  readonly userId: string;
  readonly membershipId: string;
  readonly companyId: string;
  readonly role: Role;
  readonly sessionId: string;
};

declare module 'fastify' {
  interface FastifyRequest {
    ctx?: AuthContext;
  }
  interface FastifyInstance {
    authenticate: (request: FastifyRequest) => Promise<void>;
  }
}

// last_seen_at обновляем не чаще раза в минуту — иначе на каждый запрос
// пишем в БД, а throughput у sessions только на чтение.
const LAST_SEEN_THROTTLE_MS = 60_000;

const readSessionIdFromCookie = (request: FastifyRequest): string | null => {
  const raw = request.cookies[SESSION_COOKIE_NAME];
  if (!raw) return null;
  const unsigned = request.unsignCookie(raw);
  if (!unsigned.valid || !unsigned.value) return null;
  return unsigned.value;
};

const authPlugin: FastifyPluginAsync = async (app) => {
  const authenticate = async (request: FastifyRequest): Promise<void> => {
    const sessionId = readSessionIdFromCookie(request);
    if (!sessionId) throw new UnauthorizedError();

    // Один запрос собирает: активную сессию + membership + компанию.
    // Гейты 1+2 сразу: revoked_at IS NULL, expires_at > now(), status='active',
    // companies.deleted_at IS NULL.
    const rows = await app.db
      .select({
        sessionId: sessions.id,
        userId: sessions.userId,
        membershipId: memberships.id,
        companyId: memberships.companyId,
        role: memberships.role,
        lastSeenAt: sessions.lastSeenAt,
      })
      .from(sessions)
      .innerJoin(memberships, eq(sessions.activeMembershipId, memberships.id))
      .innerJoin(companies, eq(memberships.companyId, companies.id))
      .where(
        and(
          eq(sessions.id, sessionId),
          isNull(sessions.revokedAt),
          gt(sessions.expiresAt, sql`now()`),
          eq(memberships.status, 'active'),
          isNull(companies.deletedAt),
        ),
      )
      .limit(1);

    const row = rows[0];
    if (!row) throw new UnauthorizedError();

    request.ctx = {
      userId: row.userId,
      membershipId: row.membershipId,
      companyId: row.companyId,
      role: row.role,
      sessionId: row.sessionId,
    };

    // Throttle: обновляем last_seen_at только если прошла минута с прошлого раза.
    const now = Date.now();
    if (now - row.lastSeenAt.getTime() > LAST_SEEN_THROTTLE_MS) {
      // Fire-and-forget: обновление last_seen_at не должно блокировать запрос
      // и его failure не должно валить запрос. Логируем ошибку если случится.
      void app.db
        .update(sessions)
        .set({ lastSeenAt: new Date() })
        .where(eq(sessions.id, sessionId))
        .catch((err: unknown) => {
          request.log.warn({ err }, 'не удалось обновить sessions.last_seen_at');
        });
    }
  };

  app.decorate('authenticate', authenticate);
};

export default fp(authPlugin, { name: 'auth', dependencies: ['security', 'db'] });

// Утилита для тестов и внутренних сервисов: интерпретирует Session-строку
// как разрешённую если она не отозвана и не протухла.
export const isSessionUsable = (s: Pick<Session, 'revokedAt' | 'expiresAt'>): boolean =>
  s.revokedAt === null && s.expiresAt.getTime() > Date.now();
