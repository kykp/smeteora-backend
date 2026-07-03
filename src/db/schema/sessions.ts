import { pgTable, uuid, text, timestamp, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
// pg-core не экспортирует inet напрямую до 0.44 — используем text для ip адреса.
// Валидация формата — на слое приложения (zod), для RLS/индексов текст достаточен.
import { users } from './users.js';
import { memberships } from './memberships.js';

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    activeMembershipId: uuid('active_membership_id')
      .notNull()
      .references(() => memberships.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    ip: text('ip'),
    userAgent: text('user_agent'),
  },
  (t) => [
    // Индекс активных сессий пользователя — для logout everywhere и подсчёта устройств.
    index('sessions_user_active_idx')
      .on(t.userId)
      .where(sql`${t.revokedAt} IS NULL`),
    // Индекс для фоновой cleanup-джобы, удаляющей протухшее.
    index('sessions_expires_cleanup_idx')
      .on(t.expiresAt)
      .where(sql`${t.revokedAt} IS NULL`),
  ],
);

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
