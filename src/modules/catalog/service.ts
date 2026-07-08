import { eq } from 'drizzle-orm';
import { type Db } from '../../db/client.js';
import { companies, type Product, type ProductCategory, type Unit } from '../../db/schema/index.js';
import { NotFoundError, ValidationError } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import * as repo from './repo.js';
import {
  type ClearProductsBody,
  type ClearProductsResponse,
  type CreateCategoryBody,
  type CreateProductBody,
  type ListBrandsQuery,
  type ListBrandsResponse,
  type ListProductsQuery,
  type ListProductsResponse,
  type ProductCategoryDto,
  type ProductDto,
  type UnitDto,
  type UpdateCategoryBody,
  type UpdateProductBody,
} from './schema.js';

// ── Мапперы Drizzle → DTO ────────────────────────────────────────

const toUnitDto = (row: Unit): UnitDto => ({
  id: row.id,
  code: row.code,
  shortName: row.shortName,
  fullName: row.fullName,
  sortOrder: row.sortOrder,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

const toCategoryDto = (row: ProductCategory): ProductCategoryDto => ({
  id: row.id,
  companyId: row.companyId,
  source: row.source,
  parentId: row.parentId,
  code: row.code,
  name: row.name,
  sortOrder: row.sortOrder,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

const toProductDto = (row: Product): ProductDto => ({
  id: row.id,
  companyId: row.companyId,
  source: row.source,
  categoryId: row.categoryId,
  unitId: row.unitId,
  name: row.name,
  sku: row.sku,
  brand: row.brand,
  description: row.description,
  buyPrice: row.buyPrice,
  sellPrice: row.sellPrice,
  attributes: row.attributes as Record<string, unknown>,
  isActive: row.isActive,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

// ── Общее: normalize empty strings → null для nullable-полей ─────

const emptyToNull = (v: string | null | undefined): string | null => {
  if (v === undefined || v === null) return null;
  const trimmed = v.trim();
  return trimmed.length === 0 ? null : trimmed;
};

// ── Units ─────────────────────────────────────────────────────────

export const listUnits = async (tx: Db): Promise<{ items: UnitDto[] }> => {
  const rows = await repo.listUnits(tx);
  return { items: rows.map(toUnitDto) };
};

// ── Categories ────────────────────────────────────────────────────

export const listCategories = async (
  tx: Db,
  ctx: { companyId: string },
): Promise<{ items: ProductCategoryDto[] }> => {
  const rows = await repo.listCategories(tx, ctx.companyId);
  return { items: rows.map(toCategoryDto) };
};

export const createCategory = async (
  tx: Db,
  ctx: { companyId: string },
  body: CreateCategoryBody,
): Promise<ProductCategoryDto> => {
  // parent должен принадлежать той же компании или быть платформенным.
  if (body.parentId) {
    const parent = await repo.findCategoryById(tx, {
      id: body.parentId,
      companyId: ctx.companyId,
    });
    if (!parent) throw new ValidationError('Родительская категория не найдена');
  }
  const row = await repo.insertCategory(tx, {
    companyId: ctx.companyId,
    code: body.code,
    name: body.name,
    parentId: body.parentId ?? null,
    sortOrder: body.sortOrder ?? 0,
  });
  return toCategoryDto(row);
};

export const updateCategory = async (
  tx: Db,
  ctx: { companyId: string },
  id: string,
  body: UpdateCategoryBody,
): Promise<ProductCategoryDto> => {
  const patch: {
    code?: string;
    name?: string;
    parentId?: string | null;
    sortOrder?: number;
  } = {};
  if (body.code !== undefined) patch.code = body.code;
  if (body.name !== undefined) patch.name = body.name;
  if (body.parentId !== undefined) patch.parentId = body.parentId;
  if (body.sortOrder !== undefined) patch.sortOrder = body.sortOrder;

  const row = await repo.updateCategory(tx, { id, companyId: ctx.companyId, patch });
  if (!row) throw new NotFoundError('Категория не найдена');
  return toCategoryDto(row);
};

export const softDeleteCategory = async (
  tx: Db,
  ctx: { companyId: string; userId: string; sessionId: string },
  id: string,
): Promise<void> => {
  const ok = await repo.softDeleteCategory(tx, { id, companyId: ctx.companyId });
  if (!ok) throw new NotFoundError('Категория не найдена');
  await writeAudit(tx, {
    companyId: ctx.companyId,
    userId: ctx.userId,
    sessionId: ctx.sessionId,
    action: 'category.delete',
    entityType: 'product_category',
    entityId: id,
  });
};

// ── Brands ─────────────────────────────────────────────────────────

export const listBrands = async (
  tx: Db,
  ctx: { companyId: string },
  query: ListBrandsQuery,
): Promise<ListBrandsResponse> => {
  const items = await repo.listBrands(tx, {
    companyId: ctx.companyId,
    scope: query.scope,
  });
  return { items };
};

// ── Products ──────────────────────────────────────────────────────

export const listProducts = async (
  tx: Db,
  ctx: { companyId: string },
  query: ListProductsQuery,
): Promise<ListProductsResponse> => {
  const { items, total } = await repo.listProducts(tx, {
    companyId: ctx.companyId,
    categoryIds: query.categoryId,
    q: query.q,
    brands: query.brand,
    scope: query.scope,
    isActive: query.isActive,
    limit: query.limit,
    offset: query.offset,
  });
  return {
    items: items.map(toProductDto),
    total,
    limit: query.limit,
    offset: query.offset,
  };
};

export const getProduct = async (
  tx: Db,
  ctx: { companyId: string },
  id: string,
): Promise<ProductDto> => {
  const row = await repo.findProductById(tx, { id, companyId: ctx.companyId });
  if (!row) throw new NotFoundError('Товар не найден');
  return toProductDto(row);
};

// Проверяет: категория и единица доступны компании (свои + platform).
// Иначе юзер может подсунуть чужой category_id и создать товар в чужой категории.
const validateCategoryAndUnit = async (
  tx: Db,
  companyId: string,
  categoryId: string,
  unitId: string,
): Promise<void> => {
  const [category, unit] = await Promise.all([
    repo.findCategoryById(tx, { id: categoryId, companyId }),
    repo.findUnitById(tx, unitId),
  ]);
  if (!category) throw new ValidationError('Категория не найдена');
  if (!unit) throw new ValidationError('Единица измерения не найдена');
};

export const createProduct = async (
  tx: Db,
  ctx: { companyId: string },
  body: CreateProductBody,
): Promise<ProductDto> => {
  await validateCategoryAndUnit(tx, ctx.companyId, body.categoryId, body.unitId);
  const row = await repo.insertProduct(tx, {
    companyId: ctx.companyId,
    categoryId: body.categoryId,
    unitId: body.unitId,
    name: body.name.trim(),
    sku: emptyToNull(body.sku),
    brand: emptyToNull(body.brand),
    description: emptyToNull(body.description),
    buyPrice: body.buyPrice ?? null,
    sellPrice: body.sellPrice ?? null,
    attributes: body.attributes ?? {},
    isActive: body.isActive ?? true,
  });
  return toProductDto(row);
};

export const updateProduct = async (
  tx: Db,
  ctx: { companyId: string },
  id: string,
  body: UpdateProductBody,
): Promise<ProductDto> => {
  if (body.categoryId !== undefined || body.unitId !== undefined) {
    // Проверяем только те что меняются. Для не-меняющегося берём текущее значение.
    const current = await repo.findProductById(tx, { id, companyId: ctx.companyId });
    if (!current) throw new NotFoundError('Товар не найден');
    await validateCategoryAndUnit(
      tx,
      ctx.companyId,
      body.categoryId ?? current.categoryId,
      body.unitId ?? current.unitId,
    );
  }
  const patch: {
    categoryId?: string;
    unitId?: string;
    name?: string;
    sku?: string | null;
    brand?: string | null;
    description?: string | null;
    buyPrice?: string | null;
    sellPrice?: string | null;
    attributes?: Record<string, unknown>;
    isActive?: boolean;
  } = {};
  if (body.categoryId !== undefined) patch.categoryId = body.categoryId;
  if (body.unitId !== undefined) patch.unitId = body.unitId;
  if (body.name !== undefined) patch.name = body.name.trim();
  if (body.sku !== undefined) patch.sku = emptyToNull(body.sku);
  if (body.brand !== undefined) patch.brand = emptyToNull(body.brand);
  if (body.description !== undefined) patch.description = emptyToNull(body.description);
  if (body.buyPrice !== undefined) patch.buyPrice = body.buyPrice;
  if (body.sellPrice !== undefined) patch.sellPrice = body.sellPrice;
  if (body.attributes !== undefined) patch.attributes = body.attributes;
  if (body.isActive !== undefined) patch.isActive = body.isActive;

  const row = await repo.updateProduct(tx, { id, companyId: ctx.companyId, patch });
  if (!row) throw new NotFoundError('Товар не найден');
  return toProductDto(row);
};

export const softDeleteProduct = async (
  tx: Db,
  ctx: { companyId: string; userId: string; sessionId: string },
  id: string,
): Promise<void> => {
  const ok = await repo.softDeleteProduct(tx, { id, companyId: ctx.companyId });
  if (!ok) throw new NotFoundError('Товар не найден');
  await writeAudit(tx, {
    companyId: ctx.companyId,
    userId: ctx.userId,
    sessionId: ctx.sessionId,
    action: 'product.delete',
    entityType: 'product',
    entityId: id,
  });
};

// Массовая очистка каталога — soft-delete всех своих товаров компании.
// Требует ввод имени компании как «второй ключ» — защита от случайного клика
// (сама роль admin — первый). Регистр и лишние пробелы не важны.
export const clearOwnProducts = async (
  tx: Db,
  ctx: { companyId: string; userId: string; sessionId: string },
  body: ClearProductsBody,
): Promise<ClearProductsResponse> => {
  const [company] = await tx
    .select({ name: companies.name })
    .from(companies)
    .where(eq(companies.id, ctx.companyId))
    .limit(1);
  if (!company) throw new NotFoundError('Компания не найдена');

  const normalize = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ');
  if (normalize(body.confirm) !== normalize(company.name)) {
    throw new ValidationError('Название компании не совпадает — операция отменена');
  }

  const deletedCount = await repo.softDeleteOwnProducts(tx, ctx.companyId);

  await writeAudit(tx, {
    companyId: ctx.companyId,
    userId: ctx.userId,
    sessionId: ctx.sessionId,
    action: 'catalog.clear',
    entityType: 'products',
    entityId: ctx.companyId,
    meta: { deletedCount },
  });

  return { deletedCount };
};
