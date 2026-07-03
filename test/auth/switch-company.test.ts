import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { buildTestApp } from '../setup/build-test-app.js';
import { closeTestDb, getSetupDb, truncateAll } from '../setup/test-db.js';
import { memberships, users } from '../../src/db/schema/index.js';
import { type Role } from '../../src/db/constants.js';

const registerAndGetCookie = async (app: FastifyInstance, email: string): Promise<string> => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { email, password: 'password1234', companyName: 'Компания А' },
  });
  const c = res.cookies[0];
  if (!c?.value) throw new Error(`cookie не установлена, статус=${res.statusCode}`);
  return `${c.name}=${c.value}`;
};

describe('POST /api/v1/auth/switch-company', () => {
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

  it('юзер в двух компаниях — может переключаться, /me показывает активную', async () => {
    const cookieA = await registerAndGetCookie(app, 'multi@a.com');

    // Заводим ему membership в компании Б напрямую (эмуляция принятого приглашения).
    // Сначала регистрируем отдельного owner'а для компании Б, чтобы Б появилась.
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'ownerb@b.com', password: 'password1234', companyName: 'Компания Б' },
    });

    const { db: setup } = getSetupDb();
    const [meUser] = await setup
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, 'multi@a.com'));
    const [ownerBmembership] = await setup
      .select({ companyId: memberships.companyId })
      .from(memberships)
      .innerJoin(users, eq(memberships.userId, users.id))
      .where(eq(users.email, 'ownerb@b.com'));

    if (!meUser || !ownerBmembership) throw new Error('setup failed');

    await setup.insert(memberships).values({
      userId: meUser.id,
      companyId: ownerBmembership.companyId,
      role: 'member' satisfies Role,
    });

    // Сейчас /me показывает компанию А (owner-membership из регистрации).
    const meBefore = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: cookieA },
    });
    expect(meBefore.json().company.name).toBe('Компания А');
    expect(meBefore.json().memberships).toHaveLength(2);

    // Находим membership id для компании Б в /me-ответе.
    const bMembership = meBefore
      .json()
      .memberships.find((m: { companyName: string; id: string }) => m.companyName === 'Компания Б');
    expect(bMembership).toBeDefined();

    const switched = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/switch-company',
      headers: { cookie: cookieA },
      payload: { membershipId: bMembership.id },
    });
    expect(switched.statusCode).toBe(200);
    expect(switched.json().company.name).toBe('Компания Б');
    expect(switched.json().role).toBe('member');

    // /me с той же cookie показывает уже компанию Б.
    const meAfter = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: cookieA },
    });
    expect(meAfter.json().company.name).toBe('Компания Б');
  });

  it('переключение на чужой membership id → 404 (не 403 — не подтверждаем существование)', async () => {
    const cookieA = await registerAndGetCookie(app, 'a@a.com');
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'b@b.com', password: 'password1234', companyName: 'Компания Б' },
    });

    const { db: setup } = getSetupDb();
    const [otherMembership] = await setup
      .select({ id: memberships.id })
      .from(memberships)
      .innerJoin(users, eq(memberships.userId, users.id))
      .where(eq(users.email, 'b@b.com'));
    if (!otherMembership) throw new Error('setup failed');

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/switch-company',
      headers: { cookie: cookieA },
      payload: { membershipId: otherMembership.id },
    });
    expect(res.statusCode).toBe(404);
  });

  it('без cookie → 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/switch-company',
      payload: { membershipId: '00000000-0000-0000-0000-000000000000' },
    });
    expect(res.statusCode).toBe(401);
  });
});
