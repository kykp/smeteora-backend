import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { and, eq, sql } from 'drizzle-orm';
import { buildTestApp } from '../setup/build-test-app.js';
import { closeTestDb, getSetupDb, truncateAll } from '../setup/test-db.js';
import { memberships, sessions } from '../../src/db/schema/index.js';
import { addMembership, registerOwner, switchTo } from '../projects/helpers.js';
import { createEmptyEstimate, createProjectViaApi } from './helpers.js';

describe('estimates — role/session/membership гейты', () => {
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

  // Возвращает cookie юзера, у которого активная роль role в чужой компании.
  // Проекты и сметы в этой компании доступны его viewer/member/admin membership'у.
  const setupWithRole = async (
    role: 'viewer' | 'member' | 'admin' | 'owner',
    suffix: string,
  ): Promise<{ cookie: string; projectId: string; estimateId: string }> => {
    // Owner делает и проект и смету, чтобы для non-owner мы могли проверить операции.
    const owner = await registerOwner(app, {
      email: `own-${suffix}@x.com`,
      companyName: `Own ${suffix}`,
    });
    const project = await createProjectViaApi(app, { cookie: owner.cookie });
    const est = await createEmptyEstimate(app, {
      cookie: owner.cookie,
      projectId: project.id,
    });

    if (role === 'owner')
      return { cookie: owner.cookie, projectId: project.id, estimateId: est.id };

    const other = await registerOwner(app, {
      email: `me-${suffix}@x.com`,
      companyName: `Мой ${suffix}`,
    });
    const added = await addMembership({
      userId: other.userId,
      companyId: owner.companyId,
      role,
    });
    await switchTo(app, { cookie: other.cookie, membershipId: added.id });
    return { cookie: other.cookie, projectId: project.id, estimateId: est.id };
  };

  it('viewer: GET разрешён, POST → 403', async () => {
    const { cookie, projectId } = await setupWithRole('viewer', 'v');

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/estimates',
      headers: { cookie },
    });
    expect(list.statusCode).toBe(200);

    const post = await app.inject({
      method: 'POST',
      url: '/api/v1/estimates',
      headers: { cookie },
      payload: { projectId, title: 'nope' },
    });
    expect(post.statusCode).toBe(403);
  });

  it('viewer: PUT tree → 403', async () => {
    const { cookie, estimateId } = await setupWithRole('viewer', 'v2');
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/estimates/${estimateId}/tree`,
      headers: { cookie },
      payload: { sections: [], lineItems: [] },
    });
    expect(res.statusCode).toBe(403);
  });

  it('viewer: DELETE → 403', async () => {
    const { cookie, estimateId } = await setupWithRole('viewer', 'v3');
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/estimates/${estimateId}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it('member: POST/PUT разрешены, DELETE → 403', async () => {
    const { cookie, projectId, estimateId } = await setupWithRole('member', 'm');

    const post = await app.inject({
      method: 'POST',
      url: '/api/v1/estimates',
      headers: { cookie },
      payload: { projectId, title: 'ok' },
    });
    expect(post.statusCode).toBe(201);

    const put = await app.inject({
      method: 'PUT',
      url: `/api/v1/estimates/${estimateId}/tree`,
      headers: { cookie },
      payload: { sections: [], lineItems: [] },
    });
    expect(put.statusCode).toBe(200);

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v1/estimates/${estimateId}`,
      headers: { cookie },
    });
    expect(del.statusCode).toBe(403);
  });

  it('admin: DELETE разрешён', async () => {
    const { cookie, estimateId } = await setupWithRole('admin', 'a');
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/estimates/${estimateId}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
  });

  it('без cookie → 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/estimates' });
    expect(res.statusCode).toBe(401);
  });

  it('revoked session → 401', async () => {
    const owner = await registerOwner(app, { email: 'rev@a.com', companyName: 'Rev' });
    const { db: setup } = getSetupDb();
    await setup
      .update(sessions)
      .set({ revokedAt: sql`now()` })
      .where(eq(sessions.userId, owner.userId));

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/estimates',
      headers: { cookie: owner.cookie },
    });
    expect(res.statusCode).toBe(401);
  });

  it('disabled membership → 401', async () => {
    const owner = await registerOwner(app, { email: 'dis@a.com', companyName: 'Dis' });
    const { db: setup } = getSetupDb();
    await setup
      .update(memberships)
      .set({ status: 'disabled' })
      .where(and(eq(memberships.userId, owner.userId), eq(memberships.companyId, owner.companyId)));

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/estimates',
      headers: { cookie: owner.cookie },
    });
    expect(res.statusCode).toBe(401);
  });
});
