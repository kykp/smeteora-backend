import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import { buildTestApp } from '../setup/build-test-app.js';
import { closeTestDb, getSetupDb, truncateAll } from '../setup/test-db.js';
import { invitations } from '../../src/db/schema/index.js';
import { registerOwner, setupCompanyWithInvitation } from './helpers.js';
import { SESSION_COOKIE_NAME } from '../../src/lib/session-cookie.js';

describe('invitations — preview + accept (анонимный флоу)', () => {
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

  // ── Preview ─────────────────────────────────────────────────────
  it('POST /invitations/preview — валидный токен: возвращает companyName + role + email', async () => {
    const { token } = await setupCompanyWithInvitation(app, {
      ownerEmail: 'own@p.com',
      companyName: 'Preview Co',
      inviteeEmail: 'inv@x.com',
      role: 'member',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/invitations/preview',
      payload: { token },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.companyName).toBe('Preview Co');
    expect(body.role).toBe('member');
    expect(body.email).toBe('inv@x.com');
    expect(body.userExists).toBe(false);
  });

  it('POST /invitations/preview — userExists=true если юзер с таким email уже есть', async () => {
    // Регистрируем юзера с email X.
    await registerOwner(app, { email: 'existing@x.com', companyName: 'Own' });

    // Другой owner приглашает того же email в свою компанию.
    const { token } = await setupCompanyWithInvitation(app, {
      ownerEmail: 'inviter@x.com',
      companyName: 'Inviter Co',
      inviteeEmail: 'existing@x.com',
      role: 'viewer',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/invitations/preview',
      payload: { token },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().userExists).toBe(true);
  });

  it('POST /invitations/preview — несуществующий токен → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/invitations/preview',
      payload: { token: 'not-a-real-token-just-random-string-of-chars' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation');
  });

  it('POST /invitations/preview — истёкший токен → 400', async () => {
    const { token, invitationId } = await setupCompanyWithInvitation(app, {
      ownerEmail: 'own@ex.com',
      companyName: 'Ex',
      inviteeEmail: 'inv@x.com',
      role: 'member',
    });

    // Сдвигаем expires_at в прошлое.
    const { db: setup } = getSetupDb();
    await setup
      .update(invitations)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(eq(invitations.id, invitationId));

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/invitations/preview',
      payload: { token },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /invitations/preview — revoked токен → 400', async () => {
    const { token, ownerCookie, invitationId } = await setupCompanyWithInvitation(app, {
      ownerEmail: 'own@rv.com',
      companyName: 'RV',
      inviteeEmail: 'inv@x.com',
      role: 'member',
    });
    await app.inject({
      method: 'POST',
      url: `/api/v1/invitations/${invitationId}/revoke`,
      headers: { cookie: ownerCookie },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/invitations/preview',
      payload: { token },
    });
    expect(res.statusCode).toBe(400);
  });

  // ── Accept: новый юзер ──────────────────────────────────────────
  it('POST /invitations/accept — новый юзер: регистрирует + membership + session', async () => {
    const { token, ownerCompanyId } = await setupCompanyWithInvitation(app, {
      ownerEmail: 'inviter@ac.com',
      companyName: 'Accept Co',
      inviteeEmail: 'newbie@ac.com',
      role: 'member',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/invitations/accept',
      payload: {
        token,
        password: 'password1234',
        userName: 'Новичок',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user.email).toBe('newbie@ac.com');
    expect(body.user.name).toBe('Новичок');
    expect(body.company.id).toBe(ownerCompanyId);
    expect(body.company.name).toBe('Accept Co');
    expect(body.role).toBe('member');
    expect(body.memberships).toHaveLength(1);

    // Session cookie установлена.
    const c = res.cookies[0];
    if (!c) throw new Error('cookie не установлена');
    expect(c.name).toBe(SESSION_COOKIE_NAME);
    expect(c.value).toBeTruthy();

    // /me с этой cookie возвращает того же юзера.
    const cookieHeader = `${c.name}=${c.value}`;
    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: cookieHeader },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.email).toBe('newbie@ac.com');
  });

  it('POST /invitations/accept — новый юзер без password → 400', async () => {
    const { token } = await setupCompanyWithInvitation(app, {
      ownerEmail: 'inviter@np.com',
      companyName: 'NP',
      inviteeEmail: 'newbie@np.com',
      role: 'viewer',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/invitations/accept',
      payload: { token },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation');
  });

  // ── Accept: существующий юзер ──────────────────────────────────
  it('POST /invitations/accept — существующий юзер: добавляется membership, session переключается', async () => {
    // Юзер уже существует со своей компанией.
    const existing = await registerOwner(app, {
      email: 'existing@ae.com',
      companyName: 'Own Corp',
    });

    // Другой owner приглашает того же email.
    const { token, ownerCompanyId } = await setupCompanyWithInvitation(app, {
      ownerEmail: 'inv@ae.com',
      companyName: 'Second Co',
      inviteeEmail: 'existing@ae.com',
      role: 'admin',
    });

    // Existing user (без cookie — accept public) принимает приглашение.
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/invitations/accept',
      payload: { token },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user.email).toBe('existing@ae.com');
    // Активная компания сейчас — вторая (та куда пригласили).
    expect(body.company.id).toBe(ownerCompanyId);
    expect(body.role).toBe('admin');
    // В memberships должны быть обе компании.
    expect(body.memberships).toHaveLength(2);

    // Пароль не был обязателен — существующий юзер уже с паролем.
    void existing;
  });

  it('POST /invitations/accept — повторный accept того же токена → 400', async () => {
    const { token } = await setupCompanyWithInvitation(app, {
      ownerEmail: 'inv@r2.com',
      companyName: 'R2',
      inviteeEmail: 'newbie@r2.com',
      role: 'member',
    });

    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/invitations/accept',
      payload: { token, password: 'password1234' },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/invitations/accept',
      payload: { token, password: 'password1234' },
    });
    expect(second.statusCode).toBe(400);
  });

  it('POST /invitations/accept — revoked токен → 400', async () => {
    const { token, ownerCookie, invitationId } = await setupCompanyWithInvitation(app, {
      ownerEmail: 'inv@rv2.com',
      companyName: 'RV2',
      inviteeEmail: 'newbie@rv2.com',
      role: 'member',
    });
    await app.inject({
      method: 'POST',
      url: `/api/v1/invitations/${invitationId}/revoke`,
      headers: { cookie: ownerCookie },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/invitations/accept',
      payload: { token, password: 'password1234' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /invitations/accept — expired токен → 400', async () => {
    const { token, invitationId } = await setupCompanyWithInvitation(app, {
      ownerEmail: 'inv@ex2.com',
      companyName: 'EX2',
      inviteeEmail: 'newbie@ex2.com',
      role: 'member',
    });
    const { db: setup } = getSetupDb();
    await setup
      .update(invitations)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(eq(invitations.id, invitationId));

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/invitations/accept',
      payload: { token, password: 'password1234' },
    });
    expect(res.statusCode).toBe(400);
  });
});
