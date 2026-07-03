import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import { buildTestApp } from '../setup/build-test-app.js';
import { closeTestDb, getSetupDb, truncateAll } from '../setup/test-db.js';
import { memberships, users } from '../../src/db/schema/index.js';

const registerUser = async (
  app: FastifyInstance,
  overrides: Partial<{ email: string; password: string; companyName: string }> = {},
) => {
  return app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: {
      email: 'a@a.com',
      password: 'password1234',
      companyName: 'Компания А',
      ...overrides,
    },
  });
};

describe('POST /api/v1/auth/login', () => {
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

  it('happy path: правильный email/password → 200 + cookie', async () => {
    await registerUser(app);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'a@a.com', password: 'password1234' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['set-cookie']).toBeDefined();
    expect(res.json().user.email).toBe('a@a.com');
  });

  it('неверный пароль → 401', async () => {
    await registerUser(app);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'a@a.com', password: 'WRONGpassword' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('unauthorized');
  });

  it('несуществующий email → 401 (тот же ответ, что при неверном пароле)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'nobody@a.com', password: 'password1234' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('membership disabled — 401 (учётка отключена)', async () => {
    await registerUser(app);
    // Отключаем membership через migrator-роль (bypass RLS).
    const { db: setup } = getSetupDb();
    const [u] = await setup.select({ id: users.id }).from(users).limit(1);
    if (!u) throw new Error('no user');
    await setup.update(memberships).set({ status: 'disabled' }).where(eq(memberships.userId, u.id));

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'a@a.com', password: 'password1234' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('user удалён (deleted_at выставлен) — 401', async () => {
    await registerUser(app);
    const { db: setup } = getSetupDb();
    await setup.update(users).set({ deletedAt: sql`now()` });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'a@a.com', password: 'password1234' },
    });
    expect(res.statusCode).toBe(401);
  });
});
