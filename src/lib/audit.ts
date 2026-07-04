import { type Db } from '../db/client.js';
import { auditLog } from '../db/schema/index.js';

// Универсальная точка записи в audit_log.
//
// Вызывается ВНУТРИ доменной транзакции (request.tx) — audit-запись должна
// быть частью того же коммита что и породившее её действие: если DELETE упал,
// в логе не должно остаться "удалили" без реального удаления.
//
// RLS на audit_log требует установленного app.current_company_id — helper это
// не проверяет, но передаётся tx, в котором контекст уже стоит (гарантирует
// withCompanyContext preHandler).
export type AuditEntry = {
  companyId: string;
  userId: string;
  sessionId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  meta?: Record<string, unknown>;
  ip?: string | null;
  userAgent?: string | null;
};

export const writeAudit = async (tx: Db, entry: AuditEntry): Promise<void> => {
  await tx.insert(auditLog).values({
    companyId: entry.companyId,
    userId: entry.userId,
    sessionId: entry.sessionId,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    meta: entry.meta ?? null,
    ip: entry.ip ?? null,
    userAgent: entry.userAgent ?? null,
  });
};
