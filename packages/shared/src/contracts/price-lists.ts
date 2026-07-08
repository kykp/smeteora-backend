import { z } from 'zod';
import {
  PRODUCT_BRAND_MAX,
  PRODUCT_DESCRIPTION_MAX,
  PRODUCT_NAME_MAX,
  PRODUCT_SKU_MAX,
} from './catalog.js';

// Контракт /api/v1/price-lists — импорт CSV/XLSX в каталог.
//
// Поток:
//  1. Юзер загружает файл → POST /price-lists/parse (multipart)
//     Ответ: uploadId, headers, previewRows (первые 10), autoMapping (догадка).
//  2. Юзер видит превью, выбирает какая колонка чему соответствует,
//     задаёт дефолты (категория / единица / тип цены).
//  3. POST /price-lists/:uploadId/commit — тело { mapping, defaults }.
//     Ответ: rowsCreated/rowsUpdated/rowsSkipped + список ошибок построчно.
//
// Файл живёт в FileStorage до commit'а. После commit'а запись остаётся
// как аудит-лог откуда пришли товары.

const uuidSchema = z.string().uuid();

// ── Поля продукта в мапинге ─────────────────────────────────────
// Ровно эти ключи знает pipeline. Значение — индекс исходной колонки (0-based).
// name — единственное обязательное поле; остальные опциональны.
// Цены разделены: sellPrice = продажа клиенту, buyPrice = закупка у поставщика.
// В прайсе может быть и обе (типовой поставщик даёт свою цену + рекомендованную РРЦ).

export const PRODUCT_FIELDS = [
  'name',
  'sku',
  'brand',
  'unit',
  'sellPrice',
  'buyPrice',
  'category',
  'description',
] as const;
export type ProductField = (typeof PRODUCT_FIELDS)[number];

// ── Parse (шаг 1) ────────────────────────────────────────────────

export const PARSE_PREVIEW_ROWS = 10;
export const PRICE_LIST_MAX_ROWS = 10_000;
export const PRICE_LIST_MAX_BYTES = 20 * 1024 * 1024;

// Строка превью — массив ячеек как строки. Числа/даты приводятся к строке
// на бэке, чтобы фронт мог показать их 1:1 как в файле.
export const previewRowSchema = z.array(z.string());
export type PreviewRow = z.infer<typeof previewRowSchema>;

// Догадка автомаппера: field → индекс колонки (или null если не нашли).
export const autoMappingSchema = z.object({
  name: z.number().int().nullable(),
  sku: z.number().int().nullable(),
  brand: z.number().int().nullable(),
  unit: z.number().int().nullable(),
  sellPrice: z.number().int().nullable(),
  buyPrice: z.number().int().nullable(),
  category: z.number().int().nullable(),
  description: z.number().int().nullable(),
});
export type AutoMapping = z.infer<typeof autoMappingSchema>;

export const parsePriceListResponseSchema = z.object({
  uploadId: uuidSchema,
  originalFilename: z.string(),
  source: z.enum(['csv', 'xlsx']),
  headers: z.array(z.string()),
  previewRows: z.array(previewRowSchema),
  rowsTotal: z.number().int().min(0),
  autoMapping: autoMappingSchema,
});
export type ParsePriceListResponse = z.infer<typeof parsePriceListResponseSchema>;

// ── Commit (шаг 2) ───────────────────────────────────────────────

// Маппинг «поле → индекс колонки»; null для отсутствующих полей.
// Валидируется на сервере: name обязателен, индексы должны быть в диапазоне.
export const commitMappingSchema = z.object({
  name: z.number().int().min(0),
  sku: z.number().int().min(0).nullable(),
  brand: z.number().int().min(0).nullable(),
  unit: z.number().int().min(0).nullable(),
  sellPrice: z.number().int().min(0).nullable(),
  buyPrice: z.number().int().min(0).nullable(),
  category: z.number().int().min(0).nullable(),
  description: z.number().int().min(0).nullable(),
});
export type CommitMapping = z.infer<typeof commitMappingSchema>;

export const commitPriceListBodySchema = z.object({
  mapping: commitMappingSchema,
});
export type CommitPriceListBody = z.infer<typeof commitPriceListBodySchema>;

// Ошибка по одной строке. row — 1-based номер строки в файле (с учётом header'а).
export const commitRowErrorSchema = z.object({
  row: z.number().int().min(1),
  message: z.string(),
});
export type CommitRowError = z.infer<typeof commitRowErrorSchema>;

export const commitPriceListResponseSchema = z.object({
  uploadId: uuidSchema,
  rowsTotal: z.number().int().min(0),
  rowsCreated: z.number().int().min(0),
  rowsUpdated: z.number().int().min(0),
  rowsSkipped: z.number().int().min(0),
  errors: z.array(commitRowErrorSchema),
});
export type CommitPriceListResponse = z.infer<typeof commitPriceListResponseSchema>;

// ── История загрузок ─────────────────────────────────────────────

export const priceListUploadSchema = z.object({
  id: uuidSchema,
  source: z.enum(['csv', 'xlsx']),
  status: z.enum(['parsed', 'committed', 'discarded']),
  originalFilename: z.string(),
  sizeBytes: z.number().int().min(0),
  rowsTotal: z.number().int().min(0),
  rowsCreated: z.number().int().min(0),
  rowsUpdated: z.number().int().min(0),
  rowsSkipped: z.number().int().min(0),
  createdAt: z.string().datetime(),
  committedAt: z.string().datetime().nullable(),
});
export type PriceListUploadDto = z.infer<typeof priceListUploadSchema>;

export const listPriceListsResponseSchema = z.object({
  items: z.array(priceListUploadSchema),
});
export type ListPriceListsResponse = z.infer<typeof listPriceListsResponseSchema>;

// ── Ограничения полей ────────────────────────────────────────────
// Реэкспорт констант, которые нужны фронту при валидации формы маппинга.
export const PRICE_LIST_FIELD_MAX = Object.freeze({
  name: PRODUCT_NAME_MAX,
  sku: PRODUCT_SKU_MAX,
  brand: PRODUCT_BRAND_MAX,
  description: PRODUCT_DESCRIPTION_MAX,
});

// ── Пути ─────────────────────────────────────────────────────────

export const PRICE_LISTS_BASE_PATH = '/price-lists';

export const priceListPaths = Object.freeze({
  parse: `${PRICE_LISTS_BASE_PATH}/parse`,
  commit: (id: string): string => `${PRICE_LISTS_BASE_PATH}/${id}/commit`,
  list: PRICE_LISTS_BASE_PATH,
});
