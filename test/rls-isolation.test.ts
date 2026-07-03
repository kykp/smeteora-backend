// Фундаментальный тест изоляции: RLS на audit_log блокирует чтение чужих строк.
// Этот тест — доказательство что механизм withCompanyContext + RLS работает.
// Все будущие доменные тесты полагаются на этот же механизм.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { getTestDb, getSetupDb, closeTestDb, truncateAll } from './setup/test-db.js';
import { seedCompanyWithOwner, seedAuditLogEntry } from './setup/fixtures.js';
import { auditLog } from '../src/db/schema/index.js';
import {
  runInCompanyContext,
  runWithoutCompanyContext,
} from '../src/plugins/with-company-context.js';

describe('RLS: изоляция audit_log между компаниями', () => {
  beforeAll(async () => {
    // Прогрев пула — чтобы первый тест не платил cold-start.
    getTestDb();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  beforeEach(async () => {
    await truncateAll();
  });

  it('без SET LOCAL app.current_company_id — под ролью app RLS возвращает 0 строк', async () => {
    const { companyId, userId } = await seedCompanyWithOwner({
      companyName: 'Компания А',
      userEmail: 'a@example.com',
    });
    await seedAuditLogEntry({ companyId, userId, action: 'test.event' });

    const { db } = getTestDb();

    // Транзакция без setCompanyContext: current_setting вернёт NULL,
    // RLS-политика audit_log_tenant_isolation отсечёт всё.
    const rows = await runWithoutCompanyContext(db, (tx) =>
      tx.select({ id: auditLog.id }).from(auditLog),
    );

    expect(rows).toHaveLength(0);
  });

  it('с SET LOCAL company=A — видны только строки A, но не B', async () => {
    const a = await seedCompanyWithOwner({
      companyName: 'Компания А',
      userEmail: 'a@example.com',
    });
    const b = await seedCompanyWithOwner({
      companyName: 'Компания Б',
      userEmail: 'b@example.com',
    });

    const aEntryId = await seedAuditLogEntry({
      companyId: a.companyId,
      userId: a.userId,
      action: 'test.event.a',
    });
    await seedAuditLogEntry({
      companyId: b.companyId,
      userId: b.userId,
      action: 'test.event.b',
    });

    const { db } = getTestDb();

    const rowsForA = await runInCompanyContext(db, a.companyId, (tx) =>
      tx
        .select({ id: auditLog.id, companyId: auditLog.companyId, action: auditLog.action })
        .from(auditLog),
    );

    expect(rowsForA).toHaveLength(1);
    expect(rowsForA[0]?.id).toBe(aEntryId);
    expect(rowsForA[0]?.companyId).toBe(a.companyId);
    expect(rowsForA[0]?.action).toBe('test.event.a');
  });

  it('переключение контекста внутри одного пула не протекает: A потом B', async () => {
    const a = await seedCompanyWithOwner({
      companyName: 'Компания А',
      userEmail: 'a@example.com',
    });
    const b = await seedCompanyWithOwner({
      companyName: 'Компания Б',
      userEmail: 'b@example.com',
    });

    await seedAuditLogEntry({ companyId: a.companyId, userId: a.userId, action: 'a1' });
    await seedAuditLogEntry({ companyId: b.companyId, userId: b.userId, action: 'b1' });

    const { db } = getTestDb();

    const rowsA = await runInCompanyContext(db, a.companyId, (tx) => tx.select().from(auditLog));
    const rowsB = await runInCompanyContext(db, b.companyId, (tx) => tx.select().from(auditLog));

    expect(rowsA).toHaveLength(1);
    expect(rowsA[0]?.action).toBe('a1');
    expect(rowsB).toHaveLength(1);
    expect(rowsB[0]?.action).toBe('b1');
  });

  it('RLS блокирует UPDATE чужих строк: под контекстом A нельзя обновить строку B', async () => {
    const a = await seedCompanyWithOwner({
      companyName: 'Компания А',
      userEmail: 'a@example.com',
    });
    const b = await seedCompanyWithOwner({
      companyName: 'Компания Б',
      userEmail: 'b@example.com',
    });

    const bEntryId = await seedAuditLogEntry({
      companyId: b.companyId,
      userId: b.userId,
      action: 'original',
    });

    const { db } = getTestDb();

    // Пытаемся из под A обновить запись B — RLS должен вернуть 0 обновлённых строк.
    const updated = await runInCompanyContext(db, a.companyId, (tx) =>
      tx
        .update(auditLog)
        .set({ action: 'HACKED' })
        .where(eq(auditLog.id, bEntryId))
        .returning({ id: auditLog.id }),
    );

    expect(updated).toHaveLength(0);

    // Проверочное чтение — через migrator-роль (bypass RLS), чтобы отделить
    // "запись физически не изменилась" от "RLS её просто скрыл".
    const setupDb = getSetupDb().db;
    const [check] = await setupDb
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.id, bEntryId));
    expect(check?.action).toBe('original');
  });

  it('current_setting(app.current_company_id) действительно установлен внутри runInCompanyContext', async () => {
    const a = await seedCompanyWithOwner({
      companyName: 'Компания А',
      userEmail: 'a@example.com',
    });

    const { db } = getTestDb();

    const raw = await runInCompanyContext(db, a.companyId, (tx) =>
      tx.execute(sql`SELECT current_setting('app.current_company_id', true) AS cid`),
    );

    // execute возвращает { rows: [{ cid: '<uuid>' }] } — точный тип зависит от драйвера,
    // проверяем через сериализацию.
    const rowsUnknown: unknown = (raw as { rows: unknown }).rows;
    expect(Array.isArray(rowsUnknown)).toBe(true);
    const first = (rowsUnknown as readonly { cid: string }[])[0];
    expect(first?.cid).toBe(a.companyId);
  });
});
