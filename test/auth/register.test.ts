import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { buildTestApp } from '../setup/build-test-app.js';
import { closeTestDb, truncateAll } from '../setup/test-db.js';
import { SESSION_COOKIE_NAME } from '../../src/lib/session-cookie.js';

describe('POST /api/v1/auth/register', () => {
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

  it('регистрирует user + company + owner-membership + session, ставит cookie', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        email: 'owner@a.com',
        password: 'password1234',
        companyName: 'Компания А',
        userName: 'Иван',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.user.email).toBe('owner@a.com');
    expect(body.user.name).toBe('Иван');
    expect(body.company.name).toBe('Компания А');
    expect(body.role).toBe('owner');
    expect(body.memberships).toHaveLength(1);
    expect(body.memberships[0].role).toBe('owner');
    expect(body.memberships[0].isActive).toBe(true);

    const cookies = res.cookies;
    expect(cookies).toHaveLength(1);
    const c = cookies[0];
    expect(c?.name).toBe(SESSION_COOKIE_NAME);
    expect(c?.httpOnly).toBe(true);
    expect(c?.sameSite).toBe('Strict');
    expect(c?.value).toBeTruthy();
  });

  it('email нормализуется: toLowerCase + trim', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        email: '  Mixed@Case.COM  ',
        password: 'password1234',
        companyName: 'Компания Б',
      },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().user.email).toBe('mixed@case.com');
  });

  it('повторная регистрация с тем же email → 409 conflict', async () => {
    const payload = {
      email: 'dup@a.com',
      password: 'password1234',
      companyName: 'Компания А',
    };
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload,
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { ...payload, companyName: 'Другая компания' },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('conflict');
  });

  it('слабый пароль (< 8) → 400 validation', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        email: 'weak@a.com',
        password: '1234',
        companyName: 'Компания А',
      },
    });

    expect(res.statusCode).toBe(400);
  });

  it('кривой email → 400 validation', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        email: 'not-an-email',
        password: 'password1234',
        companyName: 'Компания А',
      },
    });

    expect(res.statusCode).toBe(400);
  });
});
