import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { buildTestApp } from '../setup/build-test-app.js';
import { closeTestDb, getSetupDb, getTestDb, truncateAll } from '../setup/test-db.js';
import { runWithoutCompanyContext } from '../../src/plugins/with-company-context.js';
import { estimates, estimateLineItems, estimateSections } from '../../src/db/schema/index.js';
import { registerOwner } from '../projects/helpers.js';
import {
  createEmptyEstimate,
  createProjectViaApi,
  makeLineItemId,
  makeSectionId,
} from './helpers.js';

// Cross-tenant изоляция estimates. Юзер компании А не видит смет компании Б,
// даже когда знает точный uuid. Ключевой инвариант: 404 (не 403).
describe('estimates — изоляция между компаниями', () => {
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

  it('GET /estimates/:id — чужая смета → 404', async () => {
    const a = await registerOwner(app, { email: 'a@a.com', companyName: 'AA' });
    const b = await registerOwner(app, { email: 'b@b.com', companyName: 'BB' });
    const bProject = await createProjectViaApi(app, { cookie: b.cookie });
    const bEst = await createEmptyEstimate(app, {
      cookie: b.cookie,
      projectId: bProject.id,
      title: 'B secret',
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/estimates/${bEst.id}`,
      headers: { cookie: a.cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it('PUT /:id/tree — попытка изменить чужую → 404, изменения не применены', async () => {
    const a = await registerOwner(app, { email: 'a2@a.com', companyName: 'A2' });
    const b = await registerOwner(app, { email: 'b2@b.com', companyName: 'B2' });
    const bProject = await createProjectViaApi(app, { cookie: b.cookie });
    const bEst = await createEmptyEstimate(app, { cookie: b.cookie, projectId: bProject.id });

    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/estimates/${bEst.id}/tree`,
      headers: { cookie: a.cookie },
      payload: {
        estimate: { title: 'HACKED' },
        sections: [],
        lineItems: [],
      },
    });
    expect(res.statusCode).toBe(404);

    // Убеждаемся, что title не поменялся (через setup-роль).
    const { db: setup } = getSetupDb();
    const [row] = await setup.select().from(estimates).where(eq(estimates.id, bEst.id));
    expect(row?.title).not.toBe('HACKED');
  });

  it('DELETE — чужую → 404, deleted_at не установлен', async () => {
    const a = await registerOwner(app, { email: 'a3@a.com', companyName: 'A3' });
    const b = await registerOwner(app, { email: 'b3@b.com', companyName: 'B3' });
    const bProject = await createProjectViaApi(app, { cookie: b.cookie });
    const bEst = await createEmptyEstimate(app, { cookie: b.cookie, projectId: bProject.id });

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/estimates/${bEst.id}`,
      headers: { cookie: a.cookie },
    });
    expect(res.statusCode).toBe(404);

    const { db: setup } = getSetupDb();
    const [row] = await setup.select().from(estimates).where(eq(estimates.id, bEst.id));
    expect(row?.deletedAt).toBeNull();
  });

  it('GET /estimates — видно только свои', async () => {
    const a = await registerOwner(app, { email: 'a4@a.com', companyName: 'A4' });
    const b = await registerOwner(app, { email: 'b4@b.com', companyName: 'B4' });
    const aProject = await createProjectViaApi(app, { cookie: a.cookie });
    const bProject = await createProjectViaApi(app, { cookie: b.cookie });

    await createEmptyEstimate(app, { cookie: a.cookie, projectId: aProject.id });
    await createEmptyEstimate(app, { cookie: a.cookie, projectId: aProject.id });
    await createEmptyEstimate(app, { cookie: b.cookie, projectId: bProject.id });

    const resA = await app.inject({
      method: 'GET',
      url: '/api/v1/estimates',
      headers: { cookie: a.cookie },
    });
    // Изоляция проверяется по количеству — companyId в ответе не отдаётся.
    expect(resA.json().total).toBe(2);
    expect(resA.json().items.every((e: { projectId: string }) => e.projectId === aProject.id)).toBe(
      true,
    );
  });

  it('RLS: без SET LOCAL app.current_company_id — под ролью app 0 строк на трёх таблицах', async () => {
    // Создаём смету + section + line_item через API.
    const a = await registerOwner(app, { email: 'rls@a.com', companyName: 'RLS' });
    const project = await createProjectViaApi(app, { cookie: a.cookie });
    const est = await createEmptyEstimate(app, { cookie: a.cookie, projectId: project.id });
    await app.inject({
      method: 'PUT',
      url: `/api/v1/estimates/${est.id}/tree`,
      headers: { cookie: a.cookie },
      payload: {
        sections: [{ id: makeSectionId(), title: 'S', sortOrder: 0 }],
        lineItems: [
          {
            id: makeLineItemId(),
            name: 'X',
            unit: 'шт',
            quantity: '1',
            price: '10',
            sortOrder: 0,
          },
        ],
      },
    });

    // Читаем под app-ролью без контекста — RLS должна отсечь всё.
    const { db } = getTestDb();
    const rows = await runWithoutCompanyContext(db, async (tx) => {
      const e = await tx.select({ id: estimates.id }).from(estimates);
      const s = await tx.select({ id: estimateSections.id }).from(estimateSections);
      const li = await tx.select({ id: estimateLineItems.id }).from(estimateLineItems);
      return { e, s, li };
    });
    expect(rows.e).toHaveLength(0);
    expect(rows.s).toHaveLength(0);
    expect(rows.li).toHaveLength(0);
  });
});
