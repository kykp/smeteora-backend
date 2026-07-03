import { and, eq, isNull, sql } from 'drizzle-orm';
import { type Db } from '../../db/client.js';
import {
  companies,
  memberships,
  sessions,
  users,
  type Company,
  type Membership,
  type User,
} from '../../db/schema/index.js';
import { type Role } from '../../db/constants.js';

// Слой БД для auth-модуля. Все методы принимают Db (транзакцию) первым аргументом.
// Здесь только Drizzle-запросы, никакой бизнес-логики.

export const findUserByEmail = async (db: Db, email: string): Promise<User | undefined> => {
  const rows = await db
    .select()
    .from(users)
    .where(and(eq(users.email, email), isNull(users.deletedAt)))
    .limit(1);
  return rows[0];
};

export const findUserById = async (db: Db, userId: string): Promise<User | undefined> => {
  const rows = await db
    .select()
    .from(users)
    .where(and(eq(users.id, userId), isNull(users.deletedAt)))
    .limit(1);
  return rows[0];
};

export const insertUser = async (
  db: Db,
  params: { email: string; passwordHash: string; name: string | null },
): Promise<User> => {
  const [row] = await db.insert(users).values(params).returning();
  if (!row) throw new Error('users insert вернул пусто');
  return row;
};

export const insertCompany = async (db: Db, name: string): Promise<Company> => {
  const [row] = await db.insert(companies).values({ name }).returning();
  if (!row) throw new Error('companies insert вернул пусто');
  return row;
};

export const insertMembership = async (
  db: Db,
  params: { userId: string; companyId: string; role: Role },
): Promise<Membership> => {
  const [row] = await db.insert(memberships).values(params).returning();
  if (!row) throw new Error('memberships insert вернул пусто');
  return row;
};

// Все активные membership'ы пользователя — для UI switch-workspace и /me.
export const listActiveMembershipsForUser = async (
  db: Db,
  userId: string,
): Promise<
  Array<{
    membershipId: string;
    companyId: string;
    companyName: string;
    role: Role;
    status: 'active' | 'disabled';
  }>
> => {
  const rows = await db
    .select({
      membershipId: memberships.id,
      companyId: memberships.companyId,
      companyName: companies.name,
      role: memberships.role,
      status: memberships.status,
    })
    .from(memberships)
    .innerJoin(companies, eq(memberships.companyId, companies.id))
    .where(and(eq(memberships.userId, userId), isNull(companies.deletedAt)));
  return rows;
};

export const findMembershipForUser = async (
  db: Db,
  params: { userId: string; membershipId: string },
): Promise<Membership | undefined> => {
  const rows = await db
    .select()
    .from(memberships)
    .where(and(eq(memberships.id, params.membershipId), eq(memberships.userId, params.userId)))
    .limit(1);
  return rows[0];
};

export const findCompanyById = async (db: Db, companyId: string): Promise<Company | undefined> => {
  const rows = await db
    .select()
    .from(companies)
    .where(and(eq(companies.id, companyId), isNull(companies.deletedAt)))
    .limit(1);
  return rows[0];
};

// ── Sessions ──

export const insertSession = async (
  db: Db,
  params: {
    userId: string;
    activeMembershipId: string;
    expiresAt: Date;
    ip: string | null;
    userAgent: string | null;
  },
): Promise<string> => {
  const [row] = await db.insert(sessions).values(params).returning({ id: sessions.id });
  if (!row) throw new Error('sessions insert вернул пусто');
  return row.id;
};

export const revokeSession = async (db: Db, sessionId: string): Promise<void> => {
  await db
    .update(sessions)
    .set({ revokedAt: sql`now()` })
    .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)));
};

export const revokeAllUserSessions = async (db: Db, userId: string): Promise<void> => {
  await db
    .update(sessions)
    .set({ revokedAt: sql`now()` })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
};

export const updateSessionActiveMembership = async (
  db: Db,
  params: { sessionId: string; activeMembershipId: string },
): Promise<void> => {
  await db
    .update(sessions)
    .set({ activeMembershipId: params.activeMembershipId })
    .where(eq(sessions.id, params.sessionId));
};
