import { and, asc, count, eq, isNull, or, sql, type SQL } from 'drizzle-orm';
import { type Db } from '../../db/client.js';
import {
  products,
  productCategories,
  units,
  type Product,
  type ProductCategory,
  type Unit,
} from '../../db/schema/index.js';

// ── Units ─────────────────────────────────────────────────────────

export const listUnits = async (tx: Db): Promise<Unit[]> => {
  return tx.select().from(units).orderBy(asc(units.sortOrder), asc(units.shortName));
};

export const findUnitById = async (tx: Db, id: string): Promise<Unit | undefined> => {
  const rows = await tx.select().from(units).where(eq(units.id, id)).limit(1);
  return rows[0];
};

// ── Categories ────────────────────────────────────────────────────

// RLS уже отсекает: приложение видит свои (company_id = current) + платформенные
// (company_id IS NULL). Дублируем условие в запросе для явности + чтобы если
// tx откроется без RLS-контекста, запрос вернул пусто, а не тихо всё.
const categoryVisibility = (companyId: string): SQL =>
  or(eq(productCategories.companyId, companyId), isNull(productCategories.companyId)) ?? sql`false`;

export const listCategories = async (tx: Db, companyId: string): Promise<ProductCategory[]> => {
  return tx
    .select()
    .from(productCategories)
    .where(and(categoryVisibility(companyId), isNull(productCategories.deletedAt)))
    .orderBy(asc(productCategories.sortOrder), asc(productCategories.name));
};

export const findCategoryById = async (
  tx: Db,
  params: { id: string; companyId: string },
): Promise<ProductCategory | undefined> => {
  const rows = await tx
    .select()
    .from(productCategories)
    .where(
      and(
        eq(productCategories.id, params.id),
        categoryVisibility(params.companyId),
        isNull(productCategories.deletedAt),
      ),
    )
    .limit(1);
  return rows[0];
};

type InsertCategoryInput = {
  companyId: string;
  code: string;
  name: string;
  parentId: string | null;
  sortOrder: number;
};

export const insertCategory = async (
  tx: Db,
  params: InsertCategoryInput,
): Promise<ProductCategory> => {
  const [row] = await tx
    .insert(productCategories)
    .values({
      companyId: params.companyId,
      source: 'company',
      code: params.code,
      name: params.name,
      parentId: params.parentId,
      sortOrder: params.sortOrder,
    })
    .returning();
  if (!row) throw new Error('categories insert вернул пусто');
  return row;
};

type CategoryPatch = {
  code?: string;
  name?: string;
  parentId?: string | null;
  sortOrder?: number;
};

export const updateCategory = async (
  tx: Db,
  params: { id: string; companyId: string; patch: CategoryPatch },
): Promise<ProductCategory | undefined> => {
  if (Object.keys(params.patch).length === 0) {
    return findCategoryById(tx, { id: params.id, companyId: params.companyId });
  }
  const [row] = await tx
    .update(productCategories)
    .set(params.patch)
    .where(
      and(
        eq(productCategories.id, params.id),
        eq(productCategories.companyId, params.companyId),
        isNull(productCategories.deletedAt),
      ),
    )
    .returning();
  return row;
};

export const softDeleteCategory = async (
  tx: Db,
  params: { id: string; companyId: string },
): Promise<boolean> => {
  const [row] = await tx
    .update(productCategories)
    .set({ deletedAt: sql`now()` })
    .where(
      and(
        eq(productCategories.id, params.id),
        eq(productCategories.companyId, params.companyId),
        isNull(productCategories.deletedAt),
      ),
    )
    .returning({ id: productCategories.id });
  return row !== undefined;
};

// ── Products ──────────────────────────────────────────────────────

type ListProductsParams = {
  companyId: string;
  categoryId?: string | undefined;
  q?: string | undefined;
  brand?: string | undefined;
  scope: 'all' | 'own' | 'platform';
  isActive?: boolean | undefined;
  limit: number;
  offset: number;
};

// Полнотекстовый поиск через to_tsvector — тот же индекс что и в миграции.
// plainto_tsquery терпимо парсит юзер-строку («камера hikvision») в query.
const fullTextMatch = (q: string): SQL =>
  sql`to_tsvector('russian', coalesce(${products.name}, '') || ' ' || coalesce(${products.sku}, '') || ' ' || coalesce(${products.brand}, '')) @@ plainto_tsquery('russian', ${q})`;

const buildProductConditions = (params: ListProductsParams): SQL[] => {
  const conditions: SQL[] = [isNull(products.deletedAt)];

  // Visibility scope
  if (params.scope === 'own') {
    conditions.push(eq(products.companyId, params.companyId));
  } else if (params.scope === 'platform') {
    conditions.push(isNull(products.companyId));
  } else {
    conditions.push(
      or(eq(products.companyId, params.companyId), isNull(products.companyId)) ?? sql`false`,
    );
  }

  if (params.categoryId !== undefined) {
    conditions.push(eq(products.categoryId, params.categoryId));
  }
  if (params.brand !== undefined) {
    conditions.push(eq(products.brand, params.brand));
  }
  if (params.isActive !== undefined) {
    conditions.push(eq(products.isActive, params.isActive));
  }
  if (params.q !== undefined && params.q.length > 0) {
    conditions.push(fullTextMatch(params.q));
  }

  return conditions;
};

export const listProducts = async (
  tx: Db,
  params: ListProductsParams,
): Promise<{ items: Product[]; total: number }> => {
  const conditions = buildProductConditions(params);
  const items = await tx
    .select()
    .from(products)
    .where(and(...conditions))
    .orderBy(asc(products.name))
    .limit(params.limit)
    .offset(params.offset);

  const [countRow] = await tx
    .select({ value: count() })
    .from(products)
    .where(and(...conditions));

  return { items, total: countRow?.value ?? 0 };
};

export const findProductById = async (
  tx: Db,
  params: { id: string; companyId: string },
): Promise<Product | undefined> => {
  const rows = await tx
    .select()
    .from(products)
    .where(
      and(
        eq(products.id, params.id),
        or(eq(products.companyId, params.companyId), isNull(products.companyId)) ?? sql`false`,
        isNull(products.deletedAt),
      ),
    )
    .limit(1);
  return rows[0];
};

type InsertProductInput = {
  companyId: string;
  categoryId: string;
  unitId: string;
  name: string;
  sku: string | null;
  brand: string | null;
  description: string | null;
  buyPrice: string | null;
  sellPrice: string | null;
  attributes: Record<string, unknown>;
  isActive: boolean;
};

export const insertProduct = async (tx: Db, params: InsertProductInput): Promise<Product> => {
  const [row] = await tx
    .insert(products)
    .values({
      companyId: params.companyId,
      source: 'company',
      categoryId: params.categoryId,
      unitId: params.unitId,
      name: params.name,
      sku: params.sku,
      brand: params.brand,
      description: params.description,
      buyPrice: params.buyPrice,
      sellPrice: params.sellPrice,
      attributes: params.attributes,
      isActive: params.isActive,
    })
    .returning();
  if (!row) throw new Error('products insert вернул пусто');
  return row;
};

type ProductPatch = {
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
};

export const updateProduct = async (
  tx: Db,
  params: { id: string; companyId: string; patch: ProductPatch },
): Promise<Product | undefined> => {
  if (Object.keys(params.patch).length === 0) {
    return findProductById(tx, { id: params.id, companyId: params.companyId });
  }
  const [row] = await tx
    .update(products)
    .set(params.patch)
    .where(
      and(
        eq(products.id, params.id),
        eq(products.companyId, params.companyId),
        isNull(products.deletedAt),
      ),
    )
    .returning();
  return row;
};

export const softDeleteProduct = async (
  tx: Db,
  params: { id: string; companyId: string },
): Promise<boolean> => {
  const [row] = await tx
    .update(products)
    .set({ deletedAt: sql`now()` })
    .where(
      and(
        eq(products.id, params.id),
        eq(products.companyId, params.companyId),
        isNull(products.deletedAt),
      ),
    )
    .returning({ id: products.id });
  return row !== undefined;
};
