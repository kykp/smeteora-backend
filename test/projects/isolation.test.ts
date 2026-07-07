import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { buildTestApp } from '../setup/build-test-app.js';
import { closeTestDb, getSetupDb, getTestDb, truncateAll } from '../setup/test-db.js';
import { runWithoutCompanyContext } from '../../src/plugins/with-company-context.js';
import { projects } from '../../src/db/schema/index.js';
import { createProjectViaApi, registerOwner } from './helpers.js';

// Cross-tenant изоляция projects: юзер компании А НЕ видит проекты компании Б.
// Ключевой inv-т: 404 (не 403), чтобы не подтверждать существование чужих ресурсов.
describe('projects — изоляция между компаниями', () => {
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

  it('GET /projects/:id — id чужого проекта → 404', async () => {
    const a = await registerOwner(app, { email: 'a@a.com', companyName: 'A1' });
    const b = await registerOwner(app, { email: 'b@b.com', companyName: 'B1' });

    const bProject = await createProjectViaApi(app, { cookie: b.cookie, name: 'B secret' });

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${bProject.id}`,
      headers: { cookie: a.cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it('PATCH /projects/:id — попытка обновить чужой → 404', async () => {
    const a = await registerOwner(app, { email: 'a2@a.com', companyName: 'A2' });
    const b = await registerOwner(app, { email: 'b2@b.com', companyName: 'B2' });

    const bProject = await createProjectViaApi(app, { cookie: b.cookie, name: 'B untouched' });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${bProject.id}`,
      headers: { cookie: a.cookie },
      payload: { name: 'HACKED' },
    });
    expect(res.statusCode).toBe(404);

    // Убеждаемся что реально не изменилось — читаем через setup-роль (BYPASSRLS).
    const { db: setup } = getSetupDb();
    const [row] = await setup.select().from(projects).where(eq(projects.id, bProject.id));
    expect(row?.name).toBe('B untouched');
  });

  it('DELETE /projects/:id — попытка удалить чужой → 404, строка на месте', async () => {
    const a = await registerOwner(app, { email: 'a3@a.com', companyName: 'A3' });
    const b = await registerOwner(app, { email: 'b3@b.com', companyName: 'B3' });

    const bProject = await createProjectViaApi(app, { cookie: b.cookie, name: 'Alive' });

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/projects/${bProject.id}`,
      headers: { cookie: a.cookie },
    });
    expect(res.statusCode).toBe(404);

    const { db: setup } = getSetupDb();
    const [row] = await setup.select().from(projects).where(eq(projects.id, bProject.id));
    expect(row?.deletedAt).toBeNull();
  });

  it('GET /projects — видно только свою компанию', async () => {
    const a = await registerOwner(app, { email: 'a4@a.com', companyName: 'A4' });
    const b = await registerOwner(app, { email: 'b4@b.com', companyName: 'B4' });

    await createProjectViaApi(app, { cookie: a.cookie, name: 'A only 1' });
    await createProjectViaApi(app, { cookie: a.cookie, name: 'A only 2' });
    await createProjectViaApi(app, { cookie: b.cookie, name: 'B only' });

    const resA = await app.inject({
      method: 'GET',
      url: '/api/v1/projects',
      headers: { cookie: a.cookie },
    });
    expect(resA.statusCode).toBe(200);
    // Изоляция проверяется по количеству и именам — companyId в ответе не отдаётся.
    expect(resA.json().total).toBe(2);
    const namesA = resA
      .json()
      .items.map((p: { name: string }) => p.name)
      .sort();
    expect(namesA).toEqual(['A only 1', 'A only 2']);

    const resB = await app.inject({
      method: 'GET',
      url: '/api/v1/projects',
      headers: { cookie: b.cookie },
    });
    expect(resB.statusCode).toBe(200);
    expect(resB.json().total).toBe(1);
    expect(resB.json().items[0].name).toBe('B only');
  });

  it('RLS: без SET LOCAL app.current_company_id — под ролью app 0 строк', async () => {
    const a = await registerOwner(app, { email: 'a5@a.com', companyName: 'A5' });
    await createProjectViaApi(app, { cookie: a.cookie, name: 'anywhere' });

    const { db } = getTestDb();
    // Транзакция без setCompanyContext: RLS-политика projects_tenant_isolation
    // отсекает всё → 0 строк даже если данные физически есть.
    const rows = await runWithoutCompanyContext(db, (tx) =>
      tx.select({ id: projects.id }).from(projects),
    );

    expect(rows).toHaveLength(0);
  });
});
