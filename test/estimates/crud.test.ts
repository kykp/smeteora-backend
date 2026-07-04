import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { buildTestApp } from '../setup/build-test-app.js';
import { closeTestDb, truncateAll } from '../setup/test-db.js';
import { registerOwner } from '../projects/helpers.js';
import { createEmptyEstimate, createProjectViaApi } from './helpers.js';

describe('estimates — CRUD (happy path)', () => {
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

  it('POST /estimates — создаёт смету, дефолты: status=draft, currency=RUB, vatMode=none', async () => {
    const { cookie, companyId } = await registerOwner(app, {
      email: 'own@a.com',
      companyName: 'AA',
    });
    const project = await createProjectViaApi(app, { cookie });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/estimates',
      headers: { cookie },
      payload: { projectId: project.id, title: 'ЖК Ромашка, черновая' },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.estimate.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.estimate.companyId).toBe(companyId);
    expect(body.estimate.projectId).toBe(project.id);
    expect(body.estimate.title).toBe('ЖК Ромашка, черновая');
    expect(body.estimate.status).toBe('draft');
    expect(body.estimate.currency).toBe('RUB');
    expect(body.estimate.vatMode).toBe('none');
    expect(body.totals.total).toBe('0.00');
    expect(body.sections).toEqual([]);
    expect(body.lineItems).toEqual([]);
  });

  it('POST /estimates — projectId не в своей компании → 400', async () => {
    const { cookie } = await registerOwner(app, { email: 'a2@a.com', companyName: 'A2' });
    const b = await registerOwner(app, { email: 'b2@b.com', companyName: 'B2' });
    const bProject = await createProjectViaApi(app, { cookie: b.cookie });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/estimates',
      headers: { cookie },
      payload: { projectId: bProject.id, title: 'Не своё' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation');
  });

  it('POST /estimates — vatMode=added без vatRate → 400', async () => {
    const { cookie } = await registerOwner(app, { email: 'v@a.com', companyName: 'VV' });
    const project = await createProjectViaApi(app, { cookie });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/estimates',
      headers: { cookie },
      payload: { projectId: project.id, title: 'X', vatMode: 'added' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /estimates — discountPercent и discountAmount одновременно → 400', async () => {
    const { cookie } = await registerOwner(app, { email: 'd@a.com', companyName: 'DD' });
    const project = await createProjectViaApi(app, { cookie });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/estimates',
      headers: { cookie },
      payload: {
        projectId: project.id,
        title: 'X',
        discountPercent: '10',
        discountAmount: '100',
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('GET /estimates — пустой список для новой компании', async () => {
    const { cookie } = await registerOwner(app, { email: 'e@a.com', companyName: 'EE' });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/estimates',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toEqual([]);
    expect(res.json().total).toBe(0);
  });

  it('GET /estimates?projectId=... — фильтрует по проекту', async () => {
    const { cookie } = await registerOwner(app, { email: 'f@a.com', companyName: 'FF' });
    const p1 = await createProjectViaApi(app, { cookie, name: 'P1' });
    const p2 = await createProjectViaApi(app, { cookie, name: 'P2' });

    await createEmptyEstimate(app, { cookie, projectId: p1.id });
    await createEmptyEstimate(app, { cookie, projectId: p1.id });
    await createEmptyEstimate(app, { cookie, projectId: p2.id });

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/estimates?projectId=${p1.id}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(2);
  });

  it('GET /estimates/:id — возвращает пустое дерево для только что созданной сметы', async () => {
    const { cookie } = await registerOwner(app, { email: 'g@a.com', companyName: 'GG' });
    const project = await createProjectViaApi(app, { cookie });
    const est = await createEmptyEstimate(app, { cookie, projectId: project.id });

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/estimates/${est.id}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().estimate.id).toBe(est.id);
    expect(res.json().sections).toEqual([]);
    expect(res.json().lineItems).toEqual([]);
  });

  it('GET /estimates/:id — несуществующий id → 404', async () => {
    const { cookie } = await registerOwner(app, { email: 'nf@a.com', companyName: 'NF' });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/estimates/00000000-0000-0000-0000-000000000000',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it('DELETE /estimates/:id — soft-delete, повторный DELETE → 404', async () => {
    const { cookie } = await registerOwner(app, { email: 'd2@a.com', companyName: 'D2' });
    const project = await createProjectViaApi(app, { cookie });
    const est = await createEmptyEstimate(app, { cookie, projectId: project.id });

    const first = await app.inject({
      method: 'DELETE',
      url: `/api/v1/estimates/${est.id}`,
      headers: { cookie },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ ok: true });

    const get = await app.inject({
      method: 'GET',
      url: `/api/v1/estimates/${est.id}`,
      headers: { cookie },
    });
    expect(get.statusCode).toBe(404);

    const second = await app.inject({
      method: 'DELETE',
      url: `/api/v1/estimates/${est.id}`,
      headers: { cookie },
    });
    expect(second.statusCode).toBe(404);
  });
});
