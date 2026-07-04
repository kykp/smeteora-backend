import { and, count, desc, eq, gt, sql } from 'drizzle-orm';
import { type Db } from '../../db/client.js';
import {
  invitations,
  memberships,
  type Invitation,
  type Membership,
} from '../../db/schema/index.js';
import { type InvitationStatus } from '../../db/constants.js';
import { type InvitableRole } from '@smeteora/shared';

// Slой БД для invitations. Все методы принимают tx первым аргументом.
// В админском флоу tx открывается через withCompanyContext (SET LOCAL company).
// В анонимном accept/preview — через runWithInvitationToken (SET LOCAL token_hash).

type ListParams = {
  companyId: string;
  status?: InvitationStatus | undefined;
  limit: number;
  offset: number;
};

export const listByCompany = async (
  tx: Db,
  params: ListParams,
): Promise<{ items: Invitation[]; total: number }> => {
  const conditions = [
    eq(invitations.companyId, params.companyId),
    ...(params.status !== undefined ? [eq(invitations.status, params.status)] : []),
  ];

  const items = await tx
    .select()
    .from(invitations)
    .where(and(...conditions))
    .orderBy(desc(invitations.createdAt))
    .limit(params.limit)
    .offset(params.offset);

  const [countRow] = await tx
    .select({ value: count() })
    .from(invitations)
    .where(and(...conditions));

  return { items, total: countRow?.value ?? 0 };
};

// Поиск pending-приглашения по (company, email) — для отказа от дублей
// на этапе создания. Не полагаемся только на unique index: partial индекс
// не срабатывает для accepted/revoked, а хочется 409 с внятной ошибкой.
export const findPendingByCompanyEmail = async (
  tx: Db,
  params: { companyId: string; email: string },
): Promise<Invitation | undefined> => {
  const rows = await tx
    .select()
    .from(invitations)
    .where(
      and(
        eq(invitations.companyId, params.companyId),
        eq(invitations.email, params.email),
        eq(invitations.status, 'pending'),
      ),
    )
    .limit(1);
  return rows[0];
};

// Активный membership в компании — чтобы не пригласить уже работающего сотрудника.
export const findActiveMembershipInCompany = async (
  tx: Db,
  params: { userId: string; companyId: string },
): Promise<Membership | undefined> => {
  const rows = await tx
    .select()
    .from(memberships)
    .where(
      and(
        eq(memberships.userId, params.userId),
        eq(memberships.companyId, params.companyId),
        eq(memberships.status, 'active'),
      ),
    )
    .limit(1);
  return rows[0];
};

type InsertInput = {
  companyId: string;
  invitedByUserId: string;
  email: string;
  role: InvitableRole;
  tokenHash: string;
  expiresAt: Date;
};

export const insert = async (tx: Db, params: InsertInput): Promise<Invitation> => {
  const [row] = await tx.insert(invitations).values(params).returning();
  if (!row) throw new Error('invitations insert вернул пусто');
  return row;
};

// Помечает pending → revoked. Возвращает true если что-то реально изменилось.
// Если приглашения нет / оно уже не pending — false (route отдаст 404).
export const revoke = async (
  tx: Db,
  params: { id: string; companyId: string },
): Promise<boolean> => {
  const [row] = await tx
    .update(invitations)
    .set({ status: 'revoked' })
    .where(
      and(
        eq(invitations.id, params.id),
        eq(invitations.companyId, params.companyId),
        eq(invitations.status, 'pending'),
      ),
    )
    .returning({ id: invitations.id });
  return row !== undefined;
};

// Поиск АКТИВНОГО (pending и не истёкшего) приглашения по token_hash.
// Вызывается только внутри runWithInvitationToken — RLS уже отсёк всё где
// token_hash не совпадает, но мы всё равно явно фильтруем: RLS показал бы
// строку даже если она revoked/expired.
export const findPendingByTokenHash = async (
  tx: Db,
  tokenHash: string,
): Promise<Invitation | undefined> => {
  const rows = await tx
    .select()
    .from(invitations)
    .where(
      and(
        eq(invitations.tokenHash, tokenHash),
        eq(invitations.status, 'pending'),
        gt(invitations.expiresAt, sql`now()`),
      ),
    )
    .limit(1);
  return rows[0];
};

// Помечает invitation принятой. Вызывается из accept-транзакции под
// token-контекстом (RLS-политика invitations_update_by_token разрешает).
export const markAccepted = async (tx: Db, invitationId: string): Promise<void> => {
  await tx
    .update(invitations)
    .set({ status: 'accepted', acceptedAt: sql`now()` })
    .where(eq(invitations.id, invitationId));
};
