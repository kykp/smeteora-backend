import { z } from 'zod';

import { CATALOG_SOURCES } from './catalog.js';

// Контракт /api/v1/works — каталог монтажных работ и категорий работ.
// Модель проще, чем у products: одна цена, нет brand/sku/vendor. Позиция
// при добавлении в смету автоматом получает kind='work' → падает в раздел
// «Монтаж». Импорт из прайс-листов не поддерживается — расценки вводятся
// руками (или через онбординговый пресет).

const uuidSchema = z.string().uuid();

const decimalStringSchema = (label: string) =>
  z
    .string()
    .regex(/^\d+(\.\d+)?$/, `Ожидается число как строка (${label})`)
    .refine(
      (v) => Number.isFinite(Number(v)) && Number(v) >= 0,
      `${label} не может быть отрицательным`,
    );

// ── Категории работ ─────────────────────────────────────────────────

export const WORK_CATEGORY_CODE_MAX = 60;
export const WORK_CATEGORY_NAME_MIN = 1;
export const WORK_CATEGORY_NAME_MAX = 200;

export const workCategorySchema = z.object({
  id: uuidSchema,
  companyId: uuidSchema.nullable(),
  source: z.enum(CATALOG_SOURCES),
  code: z.string().max(WORK_CATEGORY_CODE_MAX),
  name: z.string().min(WORK_CATEGORY_NAME_MIN).max(WORK_CATEGORY_NAME_MAX),
  sortOrder: z.number().int(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type WorkCategoryDto = z.infer<typeof workCategorySchema>;

export const listWorkCategoriesResponseSchema = z.object({
  items: z.array(workCategorySchema),
});
export type ListWorkCategoriesResponse = z.infer<typeof listWorkCategoriesResponseSchema>;

export const createWorkCategoryBodySchema = z.object({
  code: z.string().trim().min(1).max(WORK_CATEGORY_CODE_MAX),
  name: z.string().trim().min(WORK_CATEGORY_NAME_MIN).max(WORK_CATEGORY_NAME_MAX),
  sortOrder: z.number().int().optional(),
});
export type CreateWorkCategoryBody = z.infer<typeof createWorkCategoryBodySchema>;

export const updateWorkCategoryBodySchema = z
  .object({
    code: z.string().trim().min(1).max(WORK_CATEGORY_CODE_MAX).optional(),
    name: z.string().trim().min(WORK_CATEGORY_NAME_MIN).max(WORK_CATEGORY_NAME_MAX).optional(),
    sortOrder: z.number().int().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: 'Нужно передать хотя бы одно поле для обновления',
  });
export type UpdateWorkCategoryBody = z.infer<typeof updateWorkCategoryBodySchema>;

// ── Позиции каталога работ ──────────────────────────────────────────

export const WORK_ITEM_NAME_MIN = 1;
export const WORK_ITEM_NAME_MAX = 500;
export const WORK_ITEM_DESCRIPTION_MAX = 4000;
export const WORK_ITEM_LIST_DEFAULT_LIMIT = 40;
export const WORK_ITEM_LIST_MAX_LIMIT = 200;

export const workItemSchema = z.object({
  id: uuidSchema,
  companyId: uuidSchema.nullable(),
  source: z.enum(CATALOG_SOURCES),
  categoryId: uuidSchema,
  unitId: uuidSchema,
  name: z.string().min(WORK_ITEM_NAME_MIN).max(WORK_ITEM_NAME_MAX),
  description: z.string().max(WORK_ITEM_DESCRIPTION_MAX).nullable(),
  // Расценка за единицу. null = «работа заведена, цена не проставлена» —
  // валидный кейс онбординга: юзер получает пресет, заполняет цифры по мере
  // готовности. При добавлении в смету c null-price строка создаётся с
  // price='0' и юзер тут же увидит что цену надо задать.
  price: z.string().nullable(),
  // Себестоимость: сколько мы платим бригаде/субподрядчику. Отдельно от
  // price — нужно для калькулятора рентабельности сметы.
  cost: z.string().nullable(),
  // Триггер автодобавления: список товарных categoryId, при добавлении
  // товара из которых в смету — эта работа добавляется автоматом. Пустой
  // массив = автопривязки нет.
  triggerCategoryIds: z.array(uuidSchema),
  meta: z.record(z.unknown()),
  isActive: z.boolean(),
  // В скольких сметах компании работа когда-либо встречалась (COUNT DISTINCT
  // estimate_id через catalog_snapshot.workItemId). Фронт использует для
  // сортировки и бейджика «Часто». 0 для платформенных работ и без использования.
  usageCount: z.number().int().min(0).default(0),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type WorkItemDto = z.infer<typeof workItemSchema>;

const multiUuidField = z
  .union([uuidSchema, z.array(uuidSchema)])
  .transform((v) => (Array.isArray(v) ? v : [v]))
  .optional();

export const listWorkItemsQuerySchema = z.object({
  categoryId: multiUuidField,
  q: z.string().trim().min(1).max(200).optional(),
  scope: z.enum(['all', 'own', 'platform']).default('all'),
  isActive: z.coerce.boolean().optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(WORK_ITEM_LIST_MAX_LIMIT)
    .default(WORK_ITEM_LIST_DEFAULT_LIMIT),
  offset: z.coerce.number().int().min(0).default(0),
  // 'name' — алфавитная сортировка (default). 'popularity' — по usageCount
  // DESC, потом по имени. Для боковой панели редактора: часто применяемые
  // работы всплывают сверху.
  sortBy: z.enum(['name', 'popularity']).default('name'),
});
export type ListWorkItemsQuery = z.infer<typeof listWorkItemsQuerySchema>;

export const listWorkItemsResponseSchema = z.object({
  items: z.array(workItemSchema),
  total: z.number().int().min(0),
  limit: z.number().int().min(1),
  offset: z.number().int().min(0),
});
export type ListWorkItemsResponse = z.infer<typeof listWorkItemsResponseSchema>;

export const createWorkItemBodySchema = z.object({
  categoryId: uuidSchema,
  unitId: uuidSchema,
  name: z.string().trim().min(WORK_ITEM_NAME_MIN).max(WORK_ITEM_NAME_MAX),
  description: z.string().trim().max(WORK_ITEM_DESCRIPTION_MAX).nullish(),
  price: decimalStringSchema('price').nullish(),
  cost: decimalStringSchema('cost').nullish(),
  triggerCategoryIds: z.array(uuidSchema).optional(),
  meta: z.record(z.unknown()).optional(),
  isActive: z.boolean().optional(),
});
export type CreateWorkItemBody = z.infer<typeof createWorkItemBodySchema>;

export const updateWorkItemBodySchema = z
  .object({
    categoryId: uuidSchema.optional(),
    unitId: uuidSchema.optional(),
    name: z.string().trim().min(WORK_ITEM_NAME_MIN).max(WORK_ITEM_NAME_MAX).optional(),
    description: z.string().trim().max(WORK_ITEM_DESCRIPTION_MAX).nullish(),
    price: decimalStringSchema('price').nullish(),
    cost: decimalStringSchema('cost').nullish(),
    triggerCategoryIds: z.array(uuidSchema).optional(),
    meta: z.record(z.unknown()).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: 'Нужно передать хотя бы одно поле для обновления',
  });
export type UpdateWorkItemBody = z.infer<typeof updateWorkItemBodySchema>;

// ── Применить пресет ─────────────────────────────────────────────
// Идемпотентно добавляет недостающие типовые работы. Юзер получает 13
// типовых работ низковольтника с price=null.

export const applyDefaultsResponseSchema = z.object({
  addedCount: z.number().int().min(0),
});
export type ApplyDefaultsResponse = z.infer<typeof applyDefaultsResponseSchema>;

// ── Общие ─────────────────────────────────────────────────────────

export const workIdParamSchema = z.object({ id: uuidSchema });
export const workOkResponseSchema = z.object({ ok: z.literal(true) });

// ── Пути ──────────────────────────────────────────────────────────

export const WORKS_BASE_PATH = '/works';
export const WORK_ITEMS_BASE_PATH = '/work-items';
export const WORK_CATEGORIES_BASE_PATH = '/work-categories';

export const worksPaths = Object.freeze({
  listWorkItems: WORK_ITEMS_BASE_PATH,
  createWorkItem: WORK_ITEMS_BASE_PATH,
  applyDefaults: `${WORK_ITEMS_BASE_PATH}/apply-defaults`,
  getWorkItem: (id: string): string => `${WORK_ITEMS_BASE_PATH}/${id}`,
  updateWorkItem: (id: string): string => `${WORK_ITEMS_BASE_PATH}/${id}`,
  deleteWorkItem: (id: string): string => `${WORK_ITEMS_BASE_PATH}/${id}`,

  listWorkCategories: WORK_CATEGORIES_BASE_PATH,
  createWorkCategory: WORK_CATEGORIES_BASE_PATH,
  updateWorkCategory: (id: string): string => `${WORK_CATEGORIES_BASE_PATH}/${id}`,
  deleteWorkCategory: (id: string): string => `${WORK_CATEGORIES_BASE_PATH}/${id}`,
});
