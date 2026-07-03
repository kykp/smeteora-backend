import { getSetupDb } from './test-db.js';
import { companies, users, memberships, auditLog } from '../../src/db/schema/index.js';
import { type Role } from '../../src/db/constants.js';

// Создаёт компанию с owner-юзером и membership'ом. Возвращает id'шники.
// Пароль-хеш — фиктивный (реальный argon2 добавим в auth-инкременте).
export const seedCompanyWithOwner = async (params: {
  companyName: string;
  userEmail: string;
  userName?: string;
}): Promise<{ companyId: string; userId: string; membershipId: string }> => {
  const { db } = getSetupDb();

  const [company] = await db
    .insert(companies)
    .values({ name: params.companyName })
    .returning({ id: companies.id });
  if (!company) throw new Error('failed to create company');

  const [user] = await db
    .insert(users)
    .values({
      email: params.userEmail,
      passwordHash: 'stub-hash-for-tests',
      name: params.userName ?? null,
    })
    .returning({ id: users.id });
  if (!user) throw new Error('failed to create user');

  const [membership] = await db
    .insert(memberships)
    .values({ userId: user.id, companyId: company.id, role: 'owner' satisfies Role })
    .returning({ id: memberships.id });
  if (!membership) throw new Error('failed to create membership');

  return { companyId: company.id, userId: user.id, membershipId: membership.id };
};

// Добавляет запись в audit_log — использую в RLS-тесте.
export const seedAuditLogEntry = async (params: {
  companyId: string;
  userId: string;
  action: string;
}): Promise<string> => {
  const { db } = getSetupDb();
  const [entry] = await db
    .insert(auditLog)
    .values({
      companyId: params.companyId,
      userId: params.userId,
      action: params.action,
    })
    .returning({ id: auditLog.id });
  if (!entry) throw new Error('failed to create audit entry');
  return entry.id;
};
