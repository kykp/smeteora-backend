import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { and, eq, isNotNull } from 'drizzle-orm';
import { buildTestApp } from '../setup/build-test-app.js';
import { closeTestDb, getSetupDb, truncateAll } from '../setup/test-db.js';
import { sessions, users } from '../../src/db/schema/index.js';

const register = async (
  app: FastifyInstance,
  email: string,
  password = 'password1234',
  userName?: string,
): Promise<string> => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: {
      email,
      password,
      companyName: 'Компания X',
      ...(userName ? { userName } : {}),
    },
  });
  if (res.statusCode !== 201) {
    throw new Error(`register вернул ${res.statusCode}: ${res.body}`);
  }
  const c = res.cookies[0];
  if (!c?.value) throw new Error('no cookie');
  return `${c.name}=${c.value}`;
};

const login = async (
  app: FastifyInstance,
  email: string,
  password: string,
): Promise<{ cookie: string; statusCode: number }> => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password },
  });
  const c = res.cookies[0];
  return {
    cookie: c ? `${c.name}=${c.value}` : '',
    statusCode: res.statusCode,
  };
};

describe('PATCH /auth/me', () => {
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

  it('меняет name', async () => {
    const cookie = await register(app, 'me@a.com', 'password1234', 'Старое имя');
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/auth/me',
      headers: { cookie },
      payload: { name: 'Новое имя' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.name).toBe('Новое имя');
  });

  it('name: null → сбрасывает имя в БД', async () => {
    const cookie = await register(app, 'n@a.com', 'password1234', 'Было');
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/auth/me',
      headers: { cookie },
      payload: { name: null },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.name).toBeNull();
  });

  it('пустое тело → 400', async () => {
    const cookie = await register(app, 'e@a.com');
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/auth/me',
      headers: { cookie },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('без cookie → 401', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/auth/me',
      payload: { name: 'A' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('name из пробелов → 400', async () => {
    const cookie = await register(app, 's@a.com');
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/auth/me',
      headers: { cookie },
      payload: { name: '   ' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /auth/change-password', () => {
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

  it('happy path: меняет пароль, старый больше не работает, новый — работает', async () => {
    const cookie = await register(app, 'p@a.com', 'oldpassword1');

    const change = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/change-password',
      headers: { cookie },
      payload: { currentPassword: 'oldpassword1', newPassword: 'newpassword2' },
    });
    expect(change.statusCode).toBe(200);
    expect(change.json()).toEqual({ ok: true });

    // Старый пароль больше не проходит.
    const oldLogin = await login(app, 'p@a.com', 'oldpassword1');
    expect(oldLogin.statusCode).toBe(401);

    // Новый — работает.
    const newLogin = await login(app, 'p@a.com', 'newpassword2');
    expect(newLogin.statusCode).toBe(200);
  });

  it('текущий пароль неверный → 401', async () => {
    const cookie = await register(app, 'w@a.com', 'realpassword1');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/change-password',
      headers: { cookie },
      payload: { currentPassword: 'WRONGpassword', newPassword: 'newpassword2' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('новый пароль совпадает с текущим → 409', async () => {
    const cookie = await register(app, 'same@a.com', 'password1234');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/change-password',
      headers: { cookie },
      payload: { currentPassword: 'password1234', newPassword: 'password1234' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('после смены пароля другие сессии отозваны, текущая — жива', async () => {
    const cookie1 = await register(app, 'multi@a.com', 'password1234');
    // Второй логин на другом «устройстве» — второй session_id.
    const secondLogin = await login(app, 'multi@a.com', 'password1234');
    expect(secondLogin.statusCode).toBe(200);

    // Смена пароля первой сессией.
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/change-password',
      headers: { cookie: cookie1 },
      payload: { currentPassword: 'password1234', newPassword: 'password5678' },
    });

    // Первая сессия жива — /me возвращает 200.
    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: cookie1 },
    });
    expect(me.statusCode).toBe(200);

    // Вторая — отозвана: /me → 401.
    const me2 = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: secondLogin.cookie },
    });
    expect(me2.statusCode).toBe(401);
  });

  it('OAuth-only юзер (password_hash IS NULL) → 409 при попытке сменить', async () => {
    const cookie = await register(app, 'oauth@a.com', 'password1234');

    // Затираем password_hash в БД, эмулируя OAuth-only юзера.
    const { db } = getSetupDb();
    await db.update(users).set({ passwordHash: null }).where(eq(users.email, 'oauth@a.com'));

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/change-password',
      headers: { cookie },
      payload: { currentPassword: 'password1234', newPassword: 'newpassword2' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toContain('OAuth');
  });

  it('без cookie → 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/change-password',
      payload: { currentPassword: 'a12345678', newPassword: 'b12345678' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('короткий newPassword → 400 validation', async () => {
    const cookie = await register(app, 'short@a.com', 'password1234');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/change-password',
      headers: { cookie },
      payload: { currentPassword: 'password1234', newPassword: '123' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('в БД остаются: текущая session активна, остальные revoked_at != null', async () => {
    const cookie1 = await register(app, 'db@a.com', 'password1234');
    await login(app, 'db@a.com', 'password1234'); // session #2
    await login(app, 'db@a.com', 'password1234'); // session #3

    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/change-password',
      headers: { cookie: cookie1 },
      payload: { currentPassword: 'password1234', newPassword: 'password5678' },
    });

    const { db } = getSetupDb();
    const [user] = await db.select({ id: users.id }).from(users).where(eq(users.email, 'db@a.com'));
    if (!user) throw new Error('user not found');
    const rows = await db
      .select({ id: sessions.id, revokedAt: sessions.revokedAt })
      .from(sessions)
      .where(eq(sessions.userId, user.id));
    expect(rows).toHaveLength(3);
    const active = rows.filter((r) => r.revokedAt === null);
    expect(active).toHaveLength(1);
    const revoked = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.userId, user.id), isNotNull(sessions.revokedAt)));
    expect(revoked).toHaveLength(2);
  });
});
