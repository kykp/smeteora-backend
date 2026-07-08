import { pgTable, uuid, text, timestamp, inet, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// Одноразовые токены для входа по email (magic link).
//
// token_hash — sha256(hex) от plain-токена. Токен 32 байта, энтропия ≈256 бит:
// argon2 не нужен, brute-force по хешу невозможен даже при утечке БД.
//
// Не под RLS — токены до/без сессии, компании ещё нет. Изоляция обеспечивается
// тем, что ручка verify не отдаёт данные токена наружу, а сам токен передаётся
// только на email (внешний канал доверия).
export const magicLinkTokens = pgTable(
  'magic_link_tokens',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    email: text('email').notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    ip: inet('ip'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Быстрый lookup при verify — по хешу.
    index('magic_link_tokens_hash_idx').on(t.tokenHash),
    // Для rate-limit'а и cleanup'а по email.
    index('magic_link_tokens_email_active_idx')
      .on(t.email, t.expiresAt)
      .where(sql`${t.usedAt} IS NULL`),
  ],
);

export type MagicLinkToken = typeof magicLinkTokens.$inferSelect;
export type NewMagicLinkToken = typeof magicLinkTokens.$inferInsert;
