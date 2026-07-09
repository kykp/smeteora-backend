import { pgTable, uuid, text, timestamp, integer, inet, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// Одноразовые email-OTP коды для входа.
//
// code_hash — sha256(hex) от plain-кода. Код — 6 цифр (10^6 вариантов), поэтому
// главную защиту от подбора обеспечивают не хэш и не энтропия, а attempts:
// после N неверных попыток запись становится невалидной, а сам запрос отсекается
// по паре (email, code) — не по коду сам по себе. То есть подобрать «любой
// активный код» невозможно, только код для конкретного email.
//
// Не под RLS — код существует до/без сессии, компании ещё нет. Изоляция:
// verify не отдаёт наружу содержимого кода, а сам код доставляется по email
// (внешний канал доверия).
export const emailOtpCodes = pgTable(
  'email_otp_codes',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    email: text('email').notNull(),
    codeHash: text('code_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    // Счётчик неверных попыток verify. При достижении MAX_VERIFY_ATTEMPTS в
    // service код помечается used_at и больше не проходит.
    attempts: integer('attempts').notNull().default(0),
    ip: inet('ip'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Быстрый lookup при verify — по email (несколько активных кодов возможно,
    // фильтруем по expires_at и usedAt в запросе).
    index('email_otp_codes_email_active_idx')
      .on(t.email, t.expiresAt)
      .where(sql`${t.usedAt} IS NULL`),
  ],
);

export type EmailOtpCode = typeof emailOtpCodes.$inferSelect;
export type NewEmailOtpCode = typeof emailOtpCodes.$inferInsert;
