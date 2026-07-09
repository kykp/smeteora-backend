import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { and, eq, sql } from 'drizzle-orm';
import { buildTestApp } from '../setup/build-test-app.js';
import { closeTestDb, getSetupDb, truncateAll } from '../setup/test-db.js';
import { memberships, sessions } from '../../src/db/schema/index.js';
import { addMembership, registerOwner, switchTo } from './helpers.js';

// Проверяем три класса гейтов:
//   Гейт 3 (role) — viewer/member/admin/owner ограничения по эндпоинтам.
//   Гейт 1 (session valid) — no cookie / revoked / expired → 401.
//   Гейт 2 (membership active) — disabled membership → 401.
describe('projects — role/session/membership гейты', () => {
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

  // Хелпер: возвращает cookie для юзера в компании cid с ролью role.
  // Внутри: регистрируем нового owner-юзера отдельно (чтобы компания существовала),
  // добавляем viewer/member/admin membership для нашего юзера, свитчимся туда.
  const cookieAs = async (
    role: 'viewer' | 'member' | 'admin' | 'owner',
    idx = 0,
  ): Promise<string> => {
    const suffix = `${role}-${idx}`;
    if (role === 'owner') {
      const own = await registerOwner(app, {
        email: `own-${suffix}@x.com`,
        companyName: `Own ${suffix}`,
      });
      return own.cookie;
    }

    // Регистрируем два owner'а: их компании нужны как "хозяева".
    // Первый — это будущий юзер с role != owner. Он сначала owner своей компании
    // (регистрация всегда создаёт owner-membership), потом мы добавляем ему
    // membership с role в чужой компании и switch'имся туда.
    const me = await registerOwner(app, {
      email: `me-${suffix}@x.com`,
      companyName: `Мой личный ${suffix}`,
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

  // ── Role: viewer ────────────────────────────────────────────────
  it('viewer: GET разрешён, POST запрещён → 403', async () => {
    const cookie = await cookieAs('viewer');

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/projects',
      headers: { cookie },
    });
    expect(list.statusCode).toBe(200);

    const post = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { cookie },
      payload: { name: 'nope' },
    });
    expect(post.statusCode).toBe(403);
    expect(post.json().error.code).toBe('forbidden');
  });

  it('viewer: PATCH запрещён → 403', async () => {
    const cookie = await cookieAs('viewer', 1);

    // Проект создать некому под этой cookie — используем свежий owner'а
    // чтобы был проект в целевой компании. Но у viewer'а нет проектов в его
    // текущей активной. Достаточно проверить preHandler на любом валидном UUID —
    // requireRole сработает до того как хендлер полезет в БД.
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/projects/00000000-0000-0000-0000-000000000000',
      headers: { cookie },
      payload: { name: 'x' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('viewer: DELETE запрещён → 403', async () => {
    const cookie = await cookieAs('viewer', 2);
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/projects/00000000-0000-0000-0000-000000000000',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(403);
  });

  // ── Role: member ───────────────────────────────────────────────
  it('member: POST/PATCH разрешены, DELETE запрещён → 403', async () => {
    const cookie = await cookieAs('member');

    const post = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { cookie },
      payload: { name: 'member creates' },
    });
    expect(post.statusCode).toBe(201);
    const id = post.json().id;

    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${id}`,
      headers: { cookie },
      payload: { status: 'in-progress' },
    });
    expect(patch.statusCode).toBe(200);

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v1/projects/${id}`,
      headers: { cookie },
    });
    expect(del.statusCode).toBe(403);
  });

  // ── Role: admin ────────────────────────────────────────────────
  it('admin: DELETE разрешён → 200', async () => {
    const cookie = await cookieAs('admin');

    const post = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { cookie },
      payload: { name: 'admin creates' },
    });
    expect(post.statusCode).toBe(201);
    const id = post.json().id;

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v1/projects/${id}`,
      headers: { cookie },
    });
    expect(del.statusCode).toBe(200);
  });

  // ── Session gate ───────────────────────────────────────────────
  it('без cookie → 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/projects',
    });
    expect(res.statusCode).toBe(401);
  });

  it('битая cookie → 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/projects',
      headers: { cookie: 'smt_session=totally-not-signed' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('revoked session → 401', async () => {
    const owner = await registerOwner(app, {
      email: 'revoke@a.com',
      companyName: 'Revoke',
    });

    // Помечаем сессию отозванной напрямую в БД.
    const { db: setup } = getSetupDb();
    await setup
      .update(sessions)
      .set({ revokedAt: sql`now()` })
      .where(eq(sessions.userId, owner.userId));

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/projects',
      headers: { cookie: owner.cookie },
    });
    expect(res.statusCode).toBe(401);
  });

  it('expired session → 401', async () => {
    const owner = await registerOwner(app, {
      email: 'expired@a.com',
      companyName: 'Expired',
    });

    const { db: setup } = getSetupDb();
    // Сдвигаем expires_at в прошлое.
    await setup
      .update(sessions)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(eq(sessions.userId, owner.userId));

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/projects',
      headers: { cookie: owner.cookie },
    });
    expect(res.statusCode).toBe(401);
  });

  // ── Membership gate ───────────────────────────────────────────
  it('disabled membership → 401', async () => {
    const owner = await registerOwner(app, {
      email: 'disabled@a.com',
      companyName: 'Disabled',
    });

    const { db: setup } = getSetupDb();
    await setup
      .update(memberships)
      .set({ status: 'disabled' })
      .where(and(eq(memberships.userId, owner.userId), eq(memberships.companyId, owner.companyId)));

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/projects',
      headers: { cookie: owner.cookie },
    });
    expect(res.statusCode).toBe(401);
  });
});
