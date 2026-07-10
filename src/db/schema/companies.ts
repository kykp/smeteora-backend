import { pgTable, uuid, text, timestamp, boolean, integer, index } from 'drizzle-orm/pg-core';
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

    // Что показывать в PDF смет. По умолчанию всё включено — юзер может отключить
    // блоки, которые не хочет светить клиенту (банковские реквизиты, контакты и т.п.).
    pdfShowLogo: boolean('pdf_show_logo').notNull().default(true),
    pdfShowAddresses: boolean('pdf_show_addresses').notNull().default(true),
    pdfShowBank: boolean('pdf_show_bank').notNull().default(true),
    pdfShowDirector: boolean('pdf_show_director').notNull().default(true),
    // Срок действия КП в календарных днях. null = не показывать в PDF.
    // На PDF рендерится как «Цены действительны до DD.MM.YYYY» (сегодня + N).
    pdfOfferValidityDays: integer('pdf_offer_validity_days'),

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
