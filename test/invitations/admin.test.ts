import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { buildTestApp } from '../setup/build-test-app.js';
import { closeTestDb, getSetupDb, truncateAll } from '../setup/test-db.js';
import { invitations } from '../../src/db/schema/index.js';
import { createInvitationViaApi, registerOwner, setupCompanyWithInvitation } from './helpers.js';

describe('invitations — admin эндпоинты', () => {
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

  // ── POST /invitations ───────────────────────────────────────────
  it('POST /invitations — создаёт pending, возвращает token + acceptUrl', async () => {
    const owner = await registerOwner(app, {
      email: 'owner@a.com',
      companyName: 'Компания А',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/invitations',
      headers: { cookie: owner.cookie },
      payload: { email: 'invitee@a.com', role: 'member' },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.invitation.email).toBe('invitee@a.com');
    expect(body.invitation.role).toBe('member');
    expect(body.invitation.status).toBe('pending');
    expect(body.invitation.companyId).toBe(owner.companyId);
    expect(body.invitation.invitedByUserId).toBe(owner.userId);
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(body.acceptUrl).toContain('/accept-invitation?token=');
    expect(body.acceptUrl).toContain(body.token);
  });

  it('POST /invitations — email нормализуется (trim + lowercase)', async () => {
    const owner = await registerOwner(app, {
      email: 'own@x.com',
      companyName: 'Ы1',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/invitations',
      headers: { cookie: owner.cookie },
      payload: { email: '  Foo@Bar.COM  ', role: 'viewer' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().invitation.email).toBe('foo@bar.com');
  });

  it('POST /invitations — дубликат pending на тот же email → 409', async () => {
    const owner = await registerOwner(app, {
      email: 'own@d.com',
      companyName: 'Дубль',
    });
    await createInvitationViaApi(app, {
      cookie: owner.cookie,
      email: 'dup@x.com',
      role: 'member',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/invitations',
      headers: { cookie: owner.cookie },
      payload: { email: 'dup@x.com', role: 'admin' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('conflict');
  });

  it('POST /invitations — приглашение уже активного участника → 409', async () => {
    // Регистрируем двух юзеров как owner'ов двух компаний.
    const a = await registerOwner(app, { email: 'a@aa.com', companyName: 'AA1' });
    const b = await registerOwner(app, { email: 'b@bb.com', companyName: 'BB1' });

    // Добавляем B как member компании A напрямую через setup DB.
    const { db: setup } = getSetupDb();
    const { memberships } = await import('../../src/db/schema/index.js');
    await setup.insert(memberships).values({
      userId: b.userId,
      companyId: a.companyId,
      role: 'member',
    });

    // Теперь A пытается пригласить b@bb.com — а он уже активный член.
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/invitations',
      headers: { cookie: a.cookie },
      payload: { email: 'b@bb.com', role: 'viewer' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('conflict');
  });

  it('POST /invitations — попытка пригласить с ролью owner → 400', async () => {
    const owner = await registerOwner(app, {
      email: 'own@own.com',
      companyName: 'Own',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/invitations',
      headers: { cookie: owner.cookie },
      payload: { email: 'candidate@x.com', role: 'owner' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /invitations — кривой email → 400', async () => {
    const owner = await registerOwner(app, {
      email: 'own@own.com',
      companyName: 'Own',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/invitations',
      headers: { cookie: owner.cookie },
      payload: { email: 'not-an-email', role: 'member' },
    });
    expect(res.statusCode).toBe(400);
  });

  // ── GET /invitations ────────────────────────────────────────────
  it('GET /invitations — возвращает список своей компании', async () => {
    const owner = await registerOwner(app, {
      email: 'own@ls.com',
      companyName: 'LS',
    });
    await createInvitationViaApi(app, {
      cookie: owner.cookie,
      email: 'i1@x.com',
      role: 'member',
    });
    await createInvitationViaApi(app, {
      cookie: owner.cookie,
      email: 'i2@x.com',
      role: 'admin',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/invitations',
      headers: { cookie: owner.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(2);
    expect(body.items.map((i: { email: string }) => i.email).sort()).toEqual([
      'i1@x.com',
      'i2@x.com',
    ]);
  });

  it('GET /invitations?status=pending — фильтр по status', async () => {
    const owner = await registerOwner(app, {
      email: 'own@f.com',
      companyName: 'F1',
    });
    const inv1 = await createInvitationViaApi(app, {
      cookie: owner.cookie,
      email: 'p@x.com',
      role: 'member',
    });
    const inv2 = await createInvitationViaApi(app, {
      cookie: owner.cookie,
      email: 'r@x.com',
      role: 'member',
    });
    // Ревокаем второй — фильтр pending должен вернуть только первый.
    await app.inject({
      method: 'POST',
      url: `/api/v1/invitations/${inv2.invitationId}/revoke`,
      headers: { cookie: owner.cookie },
    });
    void inv1;

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/invitations?status=pending',
      headers: { cookie: owner.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(1);
    expect(body.items[0].email).toBe('p@x.com');
  });

  it('GET /invitations — не видно приглашений другой компании', async () => {
    const a = await registerOwner(app, { email: 'a@is.com', companyName: 'A1' });
    const b = await registerOwner(app, { email: 'b@is.com', companyName: 'B1' });
    await createInvitationViaApi(app, {
      cookie: a.cookie,
      email: 'aa@x.com',
      role: 'viewer',
    });
    await createInvitationViaApi(app, {
      cookie: b.cookie,
      email: 'bb@x.com',
      role: 'viewer',
    });

    const resA = await app.inject({
      method: 'GET',
      url: '/api/v1/invitations',
      headers: { cookie: a.cookie },
    });
    expect(resA.json().total).toBe(1);
    expect(resA.json().items[0].email).toBe('aa@x.com');
  });

  // ── POST /invitations/:id/revoke ────────────────────────────────
  it('POST /invitations/:id/revoke — pending → revoked', async () => {
    const { ownerCookie, invitationId } = await setupCompanyWithInvitation(app, {
      ownerEmail: 'own@rv.com',
      companyName: 'RV',
      inviteeEmail: 'inv@x.com',
      role: 'member',
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/invitations/${invitationId}/revoke`,
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    // Проверяем что реально изменилось.
    const { db: setup } = getSetupDb();
    const [row] = await setup
      .select({ status: invitations.status })
      .from(invitations)
      .where(eq(invitations.id, invitationId));
    expect(row?.status).toBe('revoked');
  });

  it('POST /invitations/:id/revoke — повторный revoke → 404', async () => {
    const { ownerCookie, invitationId } = await setupCompanyWithInvitation(app, {
      ownerEmail: 'own@r2.com',
      companyName: 'R2',
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
      url: `/api/v1/invitations/${invitationId}/revoke`,
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it('POST /invitations/:id/revoke — чужое приглашение → 404 (не 403)', async () => {
    const a = await registerOwner(app, { email: 'a@rv.com', companyName: 'AA' });
    const bInv = await setupCompanyWithInvitation(app, {
      ownerEmail: 'b@rv.com',
      companyName: 'BB',
      inviteeEmail: 'inv@x.com',
      role: 'member',
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/invitations/${bInv.invitationId}/revoke`,
      headers: { cookie: a.cookie },
    });
    expect(res.statusCode).toBe(404);
  });
});
