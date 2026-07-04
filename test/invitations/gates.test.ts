import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { and, eq, sql } from 'drizzle-orm';
import { buildTestApp } from '../setup/build-test-app.js';
import { closeTestDb, getSetupDb, truncateAll } from '../setup/test-db.js';
import { memberships, sessions } from '../../src/db/schema/index.js';
import { addMembership, registerOwner, switchTo } from './helpers.js';

// Гейты для admin-эндпоинтов invitations. accept/preview публичные — не тестируем тут.
describe('invitations — role/session/membership гейты', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  beforeEach(async () => {
    await truncateAll();
  });

  // Тот же паттерн что в projects/gates.test.ts: регистрируем юзера
  // owner'ом своей компании, потом добавляем ему membership с нужной ролью
  // в чужую и свитчимся туда.
  const cookieAs = async (
    role: 'viewer' | 'member' | 'admin' | 'owner',
    suffix: string,
  ): Promise<string> => {
    if (role === 'owner') {
      const own = await registerOwner(app, {
        email: `own-${suffix}@x.com`,
        companyName: `Own ${suffix}`,
      });
      return own.cookie;
    }

    const me = await registerOwner(app, {
      email: `me-${suffix}@x.com`,
      companyName: `Мой ${suffix}`,
    });
    const foreign = await registerOwner(app, {
      email: `foreign-${suffix}@x.com`,
      companyName: `Чужая ${suffix}`,
    });
    const added = await addMembership({
      userId: me.userId,
      companyId: foreign.companyId,
      role,
    });
    await switchTo(app, { cookie: me.cookie, membershipId: added.id });
    return me.cookie;
  };

  it('viewer: POST /invitations → 403', async () => {
    const cookie = await cookieAs('viewer', 'v1');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/invitations',
      headers: { cookie },
      payload: { email: 'x@x.com', role: 'viewer' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('viewer: GET /invitations → 403', async () => {
    const cookie = await cookieAs('viewer', 'v2');
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/invitations',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it('member: POST /invitations → 403', async () => {
    const cookie = await cookieAs('member', 'm1');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/invitations',
      headers: { cookie },
      payload: { email: 'x@x.com', role: 'viewer' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('member: POST /invitations/:id/revoke → 403', async () => {
    const cookie = await cookieAs('member', 'm2');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/invitations/00000000-0000-0000-0000-000000000000/revoke',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it('admin: GET /invitations → 200', async () => {
    const cookie = await cookieAs('admin', 'ad');
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/invitations',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
  });

  it('без cookie на POST /invitations → 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/invitations',
      payload: { email: 'x@x.com', role: 'viewer' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('revoked session → 401 на GET /invitations', async () => {
    const owner = await registerOwner(app, {
      email: 'rev@x.com',
      companyName: 'Rev',
    });
    const { db: setup } = getSetupDb();
    await setup
      .update(sessions)
      .set({ revokedAt: sql`now()` })
      .where(eq(sessions.userId, owner.userId));

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/invitations',
      headers: { cookie: owner.cookie },
    });
    expect(res.statusCode).toBe(401);
  });

  it('disabled membership → 401 на GET /invitations', async () => {
    const owner = await registerOwner(app, {
      email: 'dis@x.com',
      companyName: 'Dis',
    });
    const { db: setup } = getSetupDb();
    await setup
      .update(memberships)
      .set({ status: 'disabled' })
      .where(and(eq(memberships.userId, owner.userId), eq(memberships.companyId, owner.companyId)));

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/invitations',
      headers: { cookie: owner.cookie },
    });
    expect(res.statusCode).toBe(401);
  });
});
