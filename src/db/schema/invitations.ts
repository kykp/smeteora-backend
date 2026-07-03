import { pgTable, uuid, text, timestamp, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { companies } from './companies.js';
import { users } from './users.js';
import { INVITATION_STATUSES, ROLES } from '../constants.js';

// Приглашение сотрудника в компанию. token — signed, TTL проверяется на бэке.
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
  ],
);

export type Invitation = typeof invitations.$inferSelect;
export type NewInvitation = typeof invitations.$inferInsert;
