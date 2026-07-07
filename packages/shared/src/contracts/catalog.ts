import { z } from 'zod';

// Контракт /api/v1/catalog — товары, категории, единицы измерения.
// Все три ресурса под одним префиксом чтобы не плодить top-level модули на фронте.

export const CATALOG_SOURCES = ['platform', 'company'] as const;
export type CatalogSource = (typeof CATALOG_SOURCES)[number];

const uuidSchema = z.string().uuid();

// Денежные поля — строки для точности round-trip (как в estimates).
const decimalStringSchema = (label: string) =>
  z
    .string()
    .regex(/^\d+(\.\d+)?$/, `Ожидается число как строка (${label})`)
    .refine(
      (v) => Number.isFinite(Number(v)) && Number(v) >= 0,
      `${label} не может быть отрицательным`,
    );

// ── Единицы измерения ───────────────────────────────────────────

export const UNIT_CODE_MAX = 20;
export const UNIT_NAME_MAX = 40;

export const unitSchema = z.object({
  id: uuidSchema,
  code: z.string().max(UNIT_CODE_MAX),
  shortName: z.string().max(UNIT_NAME_MAX),
  fullName: z.string().max(UNIT_NAME_MAX),
  sortOrder: z.number().int(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type UnitDto = z.infer<typeof unitSchema>;

export const listUnitsResponseSchema = z.object({
  items: z.array(unitSchema),
});
export type ListUnitsResponse = z.infer<typeof listUnitsResponseSchema>;

// ── Категории ────────────────────────────────────────────────────

export const CATEGORY_CODE_MAX = 60;
export const CATEGORY_NAME_MIN = 1;
export const CATEGORY_NAME_MAX = 200;

export const productCategorySchema = z.object({
  id: uuidSchema,
  companyId: uuidSchema.nullable(), // null = платформенная
  source: z.enum(CATALOG_SOURCES),
  parentId: uuidSchema.nullable(),
  code: z.string().max(CATEGORY_CODE_MAX),
  name: z.string().min(CATEGORY_NAME_MIN).max(CATEGORY_NAME_MAX),
  sortOrder: z.number().int(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ProductCategoryDto = z.infer<typeof productCategorySchema>;

export const listCategoriesResponseSchema = z.object({
  items: z.array(productCategorySchema),
});
export type ListCategoriesResponse = z.infer<typeof listCategoriesResponseSchema>;

export const createCategoryBodySchema = z.object({
  code: z.string().trim().min(1).max(CATEGORY_CODE_MAX),
  name: z.string().trim().min(CATEGORY_NAME_MIN).max(CATEGORY_NAME_MAX),
  parentId: uuidSchema.nullish(),
  sortOrder: z.number().int().optional(),
});
export type CreateCategoryBody = z.infer<typeof createCategoryBodySchema>;

export const updateCategoryBodySchema = z
  .object({
    code: z.string().trim().min(1).max(CATEGORY_CODE_MAX).optional(),
    name: z.string().trim().min(CATEGORY_NAME_MIN).max(CATEGORY_NAME_MAX).optional(),
    parentId: uuidSchema.nullish(),
    sortOrder: z.number().int().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: 'Нужно передать хотя бы одно поле для обновления',
  });
export type UpdateCategoryBody = z.infer<typeof updateCategoryBodySchema>;

// ── Товары ───────────────────────────────────────────────────────

export const PRODUCT_NAME_MIN = 1;
export const PRODUCT_NAME_MAX = 500;
export const PRODUCT_SKU_MAX = 100;
export const PRODUCT_BRAND_MAX = 200;
export const PRODUCT_DESCRIPTION_MAX = 4000;
export const PRODUCT_LIST_DEFAULT_LIMIT = 40;
export const PRODUCT_LIST_MAX_LIMIT = 200;

export const productSchema = z.object({
  id: uuidSchema,
  companyId: uuidSchema.nullable(),
  source: z.enum(CATALOG_SOURCES),
  categoryId: uuidSchema,
  unitId: uuidSchema,
  name: z.string().min(PRODUCT_NAME_MIN).max(PRODUCT_NAME_MAX),
  sku: z.string().max(PRODUCT_SKU_MAX).nullable(),
  brand: z.string().max(PRODUCT_BRAND_MAX).nullable(),
  description: z.string().max(PRODUCT_DESCRIPTION_MAX).nullable(),
  buyPrice: z.string().nullable(), // decimal-as-string
  sellPrice: z.string().nullable(),
  attributes: z.record(z.unknown()),
  isActive: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ProductDto = z.infer<typeof productSchema>;

export const listProductsQuerySchema = z.object({
  categoryId: uuidSchema.optional(),
  q: z.string().trim().min(1).max(200).optional(),
  brand: z.string().trim().min(1).max(PRODUCT_BRAND_MAX).optional(),
  // scope: 'all' — свои + платформа (default), 'own' — только свои, 'platform' — только платформа
  scope: z.enum(['all', 'own', 'platform']).default('all'),
  isActive: z.coerce.boolean().optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(PRODUCT_LIST_MAX_LIMIT)
    .default(PRODUCT_LIST_DEFAULT_LIMIT),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListProductsQuery = z.infer<typeof listProductsQuerySchema>;

export const listProductsResponseSchema = z.object({
  items: z.array(productSchema),
  total: z.number().int().min(0),
  limit: z.number().int().min(1),
  offset: z.number().int().min(0),
});
export type ListProductsResponse = z.infer<typeof listProductsResponseSchema>;

export const createProductBodySchema = z.object({
  categoryId: uuidSchema,
  unitId: uuidSchema,
  name: z.string().trim().min(PRODUCT_NAME_MIN).max(PRODUCT_NAME_MAX),
  sku: z.string().trim().max(PRODUCT_SKU_MAX).nullish(),
  brand: z.string().trim().max(PRODUCT_BRAND_MAX).nullish(),
  description: z.string().trim().max(PRODUCT_DESCRIPTION_MAX).nullish(),
  buyPrice: decimalStringSchema('buyPrice').nullish(),
  sellPrice: decimalStringSchema('sellPrice').nullish(),
  attributes: z.record(z.unknown()).optional(),
  isActive: z.boolean().optional(),
});
export type CreateProductBody = z.infer<typeof createProductBodySchema>;

export const updateProductBodySchema = z
  .object({
    categoryId: uuidSchema.optional(),
    unitId: uuidSchema.optional(),
    name: z.string().trim().min(PRODUCT_NAME_MIN).max(PRODUCT_NAME_MAX).optional(),
    sku: z.string().trim().max(PRODUCT_SKU_MAX).nullish(),
    brand: z.string().trim().max(PRODUCT_BRAND_MAX).nullish(),
    description: z.string().trim().max(PRODUCT_DESCRIPTION_MAX).nullish(),
    buyPrice: decimalStringSchema('buyPrice').nullish(),
    sellPrice: decimalStringSchema('sellPrice').nullish(),
    attributes: z.record(z.unknown()).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: 'Нужно передать хотя бы одно поле для обновления',
  });
export type UpdateProductBody = z.infer<typeof updateProductBodySchema>;

// ── Общие ─────────────────────────────────────────────────────────

export const idParamSchema = z.object({ id: uuidSchema });
export const okResponseSchema = z.object({ ok: z.literal(true) });

// ── Пути ──────────────────────────────────────────────────────────

export const CATALOG_BASE_PATH = '/catalog';
export const PRODUCTS_BASE_PATH = '/products';
export const CATEGORIES_BASE_PATH = '/categories';
export const UNITS_BASE_PATH = '/units';

export const catalogPaths = Object.freeze({
  listProducts: PRODUCTS_BASE_PATH,
  createProduct: PRODUCTS_BASE_PATH,
  getProduct: (id: string): string => `${PRODUCTS_BASE_PATH}/${id}`,
  updateProduct: (id: string): string => `${PRODUCTS_BASE_PATH}/${id}`,
  deleteProduct: (id: string): string => `${PRODUCTS_BASE_PATH}/${id}`,

  listCategories: CATEGORIES_BASE_PATH,
  createCategory: CATEGORIES_BASE_PATH,
  updateCategory: (id: string): string => `${CATEGORIES_BASE_PATH}/${id}`,
  deleteCategory: (id: string): string => `${CATEGORIES_BASE_PATH}/${id}`,

  listUnits: UNITS_BASE_PATH,
});
