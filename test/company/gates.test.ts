import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { buildTestApp } from '../setup/build-test-app.js';
import { closeTestDb, truncateAll } from '../setup/test-db.js';
import { registerOwner, addMembership, switchTo } from '../projects/helpers.js';

describe('company — role-гейт + анон', () => {
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

  it('GET /company без cookie → 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/company' });
    expect(res.statusCode).toBe(401);
  });

  it('PATCH /company без cookie → 401', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/company',
      payload: { inn: '1234567890' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('viewer может GET, но не может PATCH → 403', async () => {
    // Owner-компания A + owner-компания B, потом добавляем юзера B как viewer в A.
    const a = await registerOwner(app, { email: 'a@a.com', companyName: 'AA' });
    const b = await registerOwner(app, { email: 'b@b.com', companyName: 'BB' });
    const viewerMembership = await addMembership({
      userId: b.userId,
      companyId: a.companyId,
      role: 'viewer',
    });
    await switchTo(app, { cookie: b.cookie, membershipId: viewerMembership.id });

    const get = await app.inject({
      method: 'GET',
      url: '/api/v1/company',
      headers: { cookie: b.cookie },
    });
    expect(get.statusCode).toBe(200);
    expect(get.json().name).toBe('AA');

    const patch = await app.inject({
      method: 'PATCH',
      url: '/api/v1/company',
      headers: { cookie: b.cookie },
      payload: { name: 'HACKED' },
    });
    expect(patch.statusCode).toBe(403);
  });

  it('member тоже не может PATCH → 403 (admin+ only)', async () => {
    const a = await registerOwner(app, { email: 'a2@a.com', companyName: 'A2' });
    const b = await registerOwner(app, { email: 'b2@b.com', companyName: 'B2' });
    const memberMembership = await addMembership({
      userId: b.userId,
      companyId: a.companyId,
      role: 'member',
    });
    await switchTo(app, { cookie: b.cookie, membershipId: memberMembership.id });

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/company',
      headers: { cookie: b.cookie },
      payload: { phone: '+7...' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('admin может PATCH', async () => {
    const a = await registerOwner(app, { email: 'a3@a.com', companyName: 'A3' });
    const b = await registerOwner(app, { email: 'b3@b.com', companyName: 'B3' });
    const adminMembership = await addMembership({
      userId: b.userId,
      companyId: a.companyId,
      role: 'admin',
    });
    await switchTo(app, { cookie: b.cookie, membershipId: adminMembership.id });

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/company',
      headers: { cookie: b.cookie },
      payload: { phone: '+79991234567' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().phone).toBe('+79991234567');
  });

  it('юзер А не может увидеть/изменить компанию Б — только свою', async () => {
    // Каждый юзер видит только свою активную компанию — GET не принимает id, всё берётся из session.
    const a = await registerOwner(app, { email: 'x@x.com', companyName: 'X-компания' });
    const b = await registerOwner(app, { email: 'y@y.com', companyName: 'Y-компания' });

    const aRes = await app.inject({
      method: 'GET',
      url: '/api/v1/company',
      headers: { cookie: a.cookie },
    });
    expect(aRes.json().name).toBe('X-компания');

    const bRes = await app.inject({
      method: 'GET',
      url: '/api/v1/company',
      headers: { cookie: b.cookie },
    });
    expect(bRes.json().name).toBe('Y-компания');

    // PATCH из-под A изменяет только X-компанию, Y-компания нетронута.
    await app.inject({
      method: 'PATCH',
      url: '/api/v1/company',
      headers: { cookie: a.cookie },
      payload: { name: 'X-новое' },
    });
    const bAfter = await app.inject({
      method: 'GET',
      url: '/api/v1/company',
      headers: { cookie: b.cookie },
    });
    expect(bAfter.json().name).toBe('Y-компания');
  });
});
