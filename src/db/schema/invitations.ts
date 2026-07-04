import { pgTable, uuid, text, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { companies } from './companies.js';
import { users } from './users.js';
import { INVITATION_STATUSES, ROLES } from '../constants.js';

// Приглашение сотрудника в компанию. token хранится как SHA-256 hex — токен
// высокоэнтропийный (32 crypto-байта), argon2 не нужен, sha256 достаточно.
// Плоский токен показывается ровно один раз при создании — как у API-ключей.
export const invitations = pgTable(
  'invitations',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    invitedByUserId: uuid('invited_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'set null' }),
    email: text('email').notNull(),
    role: text('role', { enum: ROLES }).notNull(),
    status: text('status', { enum: INVITATION_STATUSES }).notNull().default('pending'),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('invitations_company_idx').on(t.companyId),
    index('invitations_email_pending_idx')
      .on(t.email)
      .where(sql`${t.status} = 'pending'`),
    // Быстрый lookup по token_hash в accept-флоу + защита от повторов активного токена.
    uniqueIndex('invitations_token_hash_pending_idx')
      .on(t.tokenHash)
      .where(sql`${t.status} = 'pending'`),
    // Нельзя иметь два pending приглашения на один и тот же email в одну и ту же компанию.
    uniqueIndex('invitations_company_email_pending_idx')
      .on(t.companyId, t.email)
      .where(sql`${t.status} = 'pending'`),
  ],
);

export type Invitation = typeof invitations.$inferSelect;
export type NewInvitation = typeof invitations.$inferInsert;
