import { pgTable, uuid, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// users — учётка человека. НЕ привязана к компании (только через memberships).
// Один email = одна учётка.
export const users = pgTable(
  'users',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    email: text('email').notNull(),
    // Nullable: юзер зашедший только через OAuth не имеет пароля.
    // При регистрации email+password — обязателен.
    passwordHash: text('password_hash'),
    name: text('name'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    // Email уникален среди активных учёток. Удалённый (deleted) email можно переиспользовать.
    uniqueIndex('users_email_unique_active_idx')
      .on(t.email)
      .where(sql`${t.deletedAt} IS NULL`),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
