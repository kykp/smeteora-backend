import { pgTable, uuid, text, timestamp, integer, jsonb, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { companies } from './companies.js';
import { memberships } from './memberships.js';
import { CATALOG_OFFER_SOURCES, PRICE_LIST_UPLOAD_STATUSES } from '../constants.js';

// История загрузок прайс-листов в каталог. Одна строка = один залитый файл.
// Все каналы ingest'а (manual/csv/xlsx/pdf/api) сходятся сюда — единый лог того,
// откуда пришли товары. source_metadata jsonb хранит специфику канала (например,
// имя листа Excel, разделитель CSV, id внешней системы).
//
// storage_key — ключ файла в FileStorage, пока не commit'нули. После commit'а
// файл можно удалять по фоновой джобе (в MVP держим — история для аудита).
//
// summary jsonb — краткий отчёт результата commit'а:
//   { rowsCreated, rowsUpdated, rowsSkipped, errors: [{ row, message }] }
export const priceListUploads = pgTable(
  'price_list_uploads',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    membershipId: uuid('membership_id')
      .notNull()
      .references(() => memberships.id, { onDelete: 'cascade' }),
    source: text('source', { enum: CATALOG_OFFER_SOURCES }).notNull(),
    sourceMetadata: jsonb('source_metadata')
      .notNull()
      .default(sql`'{}'::jsonb`),
    status: text('status', { enum: PRICE_LIST_UPLOAD_STATUSES }).notNull(),

    originalFilename: text('original_filename').notNull(),
    storageKey: text('storage_key').notNull(),
    mimeType: text('mime_type'),
    sizeBytes: integer('size_bytes').notNull(),

    rowsTotal: integer('rows_total').notNull().default(0),
    rowsCreated: integer('rows_created').notNull().default(0),
    rowsUpdated: integer('rows_updated').notNull().default(0),
    rowsSkipped: integer('rows_skipped').notNull().default(0),

    summary: jsonb('summary')
      .notNull()
      .default(sql`'{}'::jsonb`),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    committedAt: timestamp('committed_at', { withTimezone: true }),
  },
  (t) => [
    index('price_list_uploads_company_idx')
      .on(t.companyId, t.createdAt)
      .where(sql`${t.status} <> 'discarded'`),
  ],
);

export type PriceListUpload = typeof priceListUploads.$inferSelect;
export type NewPriceListUpload = typeof priceListUploads.$inferInsert;
