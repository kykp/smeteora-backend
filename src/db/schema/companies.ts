import { pgTable, uuid, text, timestamp, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// companies — тенант. Реквизиты (inn/kpp/ogrn/…) заполняются постепенно,
// на регистрации только name. Enum'ы (legal_form) валидируются в Zod, БД принимает
// свободный text — так не таскаем миграцию на каждое расширение перечня.
export const companies = pgTable(
  'companies',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    name: text('name').notNull(),

    // Реквизиты — все опциональные.
    legalForm: text('legal_form'),
    inn: text('inn'),
    kpp: text('kpp'),
    ogrn: text('ogrn'),
    legalAddress: text('legal_address'),
    actualAddress: text('actual_address'),
    bankName: text('bank_name'),
    bik: text('bik'),
    checkingAccount: text('checking_account'),
    correspondentAccount: text('correspondent_account'),
    directorName: text('director_name'),
    directorPosition: text('director_position'),
    phone: text('phone'),
    email: text('email'),

    // Логотип. logo_key — путь в FileStorage. logo_content_type — MIME для отдачи.
    // null = логотип не установлен.
    logoKey: text('logo_key'),
    logoContentType: text('logo_content_type'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    index('companies_active_idx')
      .on(t.createdAt)
      .where(sql`${t.deletedAt} IS NULL`),
  ],
);

export type Company = typeof companies.$inferSelect;
export type NewCompany = typeof companies.$inferInsert;
