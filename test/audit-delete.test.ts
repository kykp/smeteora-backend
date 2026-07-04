import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { buildTestApp } from './setup/build-test-app.js';
import { closeTestDb, getSetupDb, truncateAll } from './setup/test-db.js';
import { auditLog } from '../src/db/schema/index.js';
import { registerOwner } from './projects/helpers.js';
import { createEmptyEstimate, createProjectViaApi } from './estimates/helpers.js';

// Проверяем что DELETE в доменных модулях оставляет запись в audit_log.
// CLAUDE.md прямо требует аудита на удаление project/estimate/etc.
describe('audit_log — на удалении доменных сущностей', () => {
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

  it('DELETE /projects/:id — пишет audit-запись action=project.delete', async () => {
    const owner = await registerOwner(app, { email: 'ap@a.com', companyName: 'AP' });
    const project = await createProjectViaApi(app, { cookie: owner.cookie });

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/projects/${project.id}`,
      headers: { cookie: owner.cookie },
    });
    expect(res.statusCode).toBe(200);

    // Читаем audit-запись через setup-роль (BYPASSRLS).
    const { db: setup } = getSetupDb();
    const rows = await setup
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'project.delete'), eq(auditLog.entityId, project.id)));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.companyId).toBe(owner.companyId);
    expect(rows[0]?.userId).toBe(owner.userId);
    expect(rows[0]?.entityType).toBe('project');
  });

  it('DELETE /estimates/:id — пишет audit-запись action=estimate.delete', async () => {
    const owner = await registerOwner(app, { email: 'ae@a.com', companyName: 'AE' });
    const project = await createProjectViaApi(app, { cookie: owner.cookie });
    const est = await createEmptyEstimate(app, { cookie: owner.cookie, projectId: project.id });

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/estimates/${est.id}`,
      headers: { cookie: owner.cookie },
    });
    expect(res.statusCode).toBe(200);

    const { db: setup } = getSetupDb();
    const rows = await setup
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'estimate.delete'), eq(auditLog.entityId, est.id)));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.companyId).toBe(owner.companyId);
    expect(rows[0]?.entityType).toBe('estimate');
  });

  it('DELETE чужого — audit-запись НЕ появляется', async () => {
    const a = await registerOwner(app, { email: 'ax@a.com', companyName: 'AX' });
    const b = await registerOwner(app, { email: 'bx@b.com', companyName: 'BX' });
    const bProject = await createProjectViaApi(app, { cookie: b.cookie });

    // A пытается удалить проект B → 404, транзакция откатилась целиком.
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/projects/${bProject.id}`,
      headers: { cookie: a.cookie },
    });
    expect(res.statusCode).toBe(404);

    const { db: setup } = getSetupDb();
    const rows = await setup.select().from(auditLog).where(eq(auditLog.entityId, bProject.id));
    expect(rows).toHaveLength(0);
  });
});
