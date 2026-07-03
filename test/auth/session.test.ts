import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { buildTestApp } from '../setup/build-test-app.js';
import { closeTestDb, getSetupDb, truncateAll } from '../setup/test-db.js';
import { sessions } from '../../src/db/schema/index.js';

const registerAndGetCookie = async (app: FastifyInstance, email = 'me@a.com'): Promise<string> => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { email, password: 'password1234', companyName: 'Компания А' },
  });
  const c = res.cookies[0];
  if (!c?.value) throw new Error(`cookie не установлена, статус=${res.statusCode}`);
  return `${c.name}=${c.value}`;
};

describe('GET /api/v1/auth/me + logout + session-гейты', () => {
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

  it('без cookie → 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/auth/me' });
    expect(res.statusCode).toBe(401);
  });

  it('с валидной cookie → 200 и данные юзера', async () => {
    const cookie = await registerAndGetCookie(app);
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.email).toBe('me@a.com');
    expect(res.json().role).toBe('owner');
  });

  it('после logout cookie невалидна → 401 на /me', async () => {
    const cookie = await registerAndGetCookie(app);
    const logout = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { cookie },
    });
    expect(logout.statusCode).toBe(200);

    // Прошлая cookie теперь ведёт на revoked session.
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(401);
  });

  it('session с expires_at в прошлом → 401', async () => {
    const cookie = await registerAndGetCookie(app);
    // Ручной ретро-датировкой expires_at через migrator-роль.
    const { db: setup } = getSetupDb();
    await setup.update(sessions).set({ expiresAt: sql`now() - interval '1 minute'` });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(401);
  });

  it('session с revoked_at → 401', async () => {
    const cookie = await registerAndGetCookie(app);
    const { db: setup } = getSetupDb();
    await setup.update(sessions).set({ revokedAt: sql`now()` });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(401);
  });

  it('битая подпись cookie → 401', async () => {
    await registerAndGetCookie(app);
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: 'smt_session=this-is-not-a-signed-value' },
    });
    expect(res.statusCode).toBe(401);
  });
});
