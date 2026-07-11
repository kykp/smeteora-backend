import { and, asc, count, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { type Db } from '../../db/client.js';
import {
  workItems,
  workCategories,
  type WorkItem,
  type WorkCategory,
} from '../../db/schema/index.js';

// RLS уже отсекает: приложение видит свои (company_id = current) + платформенные
// (company_id IS NULL). Дублируем условие в запросе для явности + чтобы если
// tx откроется без RLS-контекста, запрос вернул пусто, а не тихо всё.
const categoryVisibility = (companyId: string): SQL =>
  or(eq(workCategories.companyId, companyId), isNull(workCategories.companyId)) ?? sql`false`;

// ── Категории ───────────────────────────────────────────────────────

export const listCategories = async (tx: Db, companyId: string): Promise<WorkCategory[]> => {
  return tx
    .select()
    .from(workCategories)
    .where(and(categoryVisibility(companyId), isNull(workCategories.deletedAt)))
    .orderBy(asc(workCategories.sortOrder), asc(workCategories.name));
};

export const findCategoryById = async (
  tx: Db,
  params: { id: string; companyId: string },
): Promise<WorkCategory | undefined> => {
  const rows = await tx
    .select()
    .from(workCategories)
    .where(
      and(
        eq(workCategories.id, params.id),
        categoryVisibility(params.companyId),
        isNull(workCategories.deletedAt),
      ),
    )
    .limit(1);
  return rows[0];
};

type InsertCategoryInput = {
  companyId: string;
  code: string;
  name: string;
  sortOrder: number;
};

export const insertCategory = async (
  tx: Db,
  params: InsertCategoryInput,
): Promise<WorkCategory> => {
  const [row] = await tx
    .insert(workCategories)
    .values({
      companyId: params.companyId,
      source: 'company',
      code: params.code,
      name: params.name,
      sortOrder: params.sortOrder,
    })
    .returning();
  if (!row) throw new Error('work_categories insert вернул пусто');
  return row;
};

type CategoryPatch = {
  code?: string;
  name?: string;
  sortOrder?: number;
};

export const updateCategory = async (
  tx: Db,
  params: { id: string; companyId: string; patch: CategoryPatch },
): Promise<WorkCategory | undefined> => {
  if (Object.keys(params.patch).length === 0) {
    return findCategoryById(tx, { id: params.id, companyId: params.companyId });
  }
  const [row] = await tx
    .update(workCategories)
    .set(params.patch)
    .where(
      and(
        eq(workCategories.id, params.id),
        eq(workCategories.companyId, params.companyId),
        isNull(workCategories.deletedAt),
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
    .update(workCategories)
    .set({ deletedAt: sql`now()` })
    .where(
      and(
        eq(workCategories.id, params.id),
        eq(workCategories.companyId, params.companyId),
        isNull(workCategories.deletedAt),
      ),
    )
    .returning({ id: workCategories.id });
  return row !== undefined;
};

// ── Позиции ─────────────────────────────────────────────────────────

type ListWorkItemsParams = {
  companyId: string;
  categoryIds?: string[] | undefined;
  q?: string | undefined;
  scope: 'all' | 'own' | 'platform';
  isActive?: boolean | undefined;
  limit: number;
  offset: number;
};

const escapeLike = (s: string): string => s.replace(/[\\%_]/g, '\\$&');

const searchMatch = (q: string): SQL => {
  const pattern = `%${escapeLike(q)}%`;
  return sql`(
    ${workItems.name} ILIKE ${pattern}
    OR coalesce(${workItems.description}, '') ILIKE ${pattern}
  )`;
};

const buildConditions = (params: ListWorkItemsParams): SQL[] => {
  const conditions: SQL[] = [isNull(workItems.deletedAt)];

  if (params.scope === 'own') {
    conditions.push(eq(workItems.companyId, params.companyId));
  } else if (params.scope === 'platform') {
    conditions.push(isNull(workItems.companyId));
  } else {
    conditions.push(
      or(eq(workItems.companyId, params.companyId), isNull(workItems.companyId)) ?? sql`false`,
    );
  }

  if (params.categoryIds && params.categoryIds.length > 0) {
    conditions.push(inArray(workItems.categoryId, params.categoryIds));
  }
  if (params.isActive !== undefined) {
    conditions.push(eq(workItems.isActive, params.isActive));
  }
  if (params.q !== undefined && params.q.length > 0) {
    conditions.push(searchMatch(params.q));
  }

  return conditions;
};

export const listItems = async (
  tx: Db,
  params: ListWorkItemsParams,
): Promise<{ items: WorkItem[]; total: number }> => {
  const conditions = buildConditions(params);
  const items = await tx
    .select()
    .from(workItems)
    .where(and(...conditions))
    .orderBy(asc(workItems.name))
    .limit(params.limit)
    .offset(params.offset);

  const [countRow] = await tx
    .select({ value: count() })
    .from(workItems)
    .where(and(...conditions));

  return { items, total: countRow?.value ?? 0 };
};

export const findItemById = async (
  tx: Db,
  params: { id: string; companyId: string },
): Promise<WorkItem | undefined> => {
  const rows = await tx
    .select()
    .from(workItems)
    .where(
      and(
        eq(workItems.id, params.id),
        or(eq(workItems.companyId, params.companyId), isNull(workItems.companyId)) ?? sql`false`,
        isNull(workItems.deletedAt),
      ),
    )
    .limit(1);
  return rows[0];
};

type InsertItemInput = {
  companyId: string;
  categoryId: string;
  unitId: string;
  name: string;
  description: string | null;
  price: string | null;
  cost: string | null;
  triggerCategoryIds: string[];
  meta: Record<string, unknown>;
  isActive: boolean;
};

export const insertItem = async (tx: Db, params: InsertItemInput): Promise<WorkItem> => {
  const [row] = await tx
    .insert(workItems)
    .values({
      companyId: params.companyId,
      source: 'company',
      categoryId: params.categoryId,
      unitId: params.unitId,
      name: params.name,
      description: params.description,
      price: params.price,
      cost: params.cost,
      triggerCategoryIds: params.triggerCategoryIds,
      meta: params.meta,
      isActive: params.isActive,
    })
    .returning();
  if (!row) throw new Error('work_items insert вернул пусто');
  return row;
};

type ItemPatch = {
  categoryId?: string;
  unitId?: string;
  name?: string;
  description?: string | null;
  price?: string | null;
  cost?: string | null;
  triggerCategoryIds?: string[];
  meta?: Record<string, unknown>;
  isActive?: boolean;
};

export const updateItem = async (
  tx: Db,
  params: { id: string; companyId: string; patch: ItemPatch },
): Promise<WorkItem | undefined> => {
  if (Object.keys(params.patch).length === 0) {
    return findItemById(tx, { id: params.id, companyId: params.companyId });
  }
  const [row] = await tx
    .update(workItems)
    .set(params.patch)
    .where(
      and(
        eq(workItems.id, params.id),
        eq(workItems.companyId, params.companyId),
        isNull(workItems.deletedAt),
      ),
    )
    .returning();
  return row;
};

// Работы, у которых триггер срабатывает на данную товарную категорию.
// Используется автопривязкой при добавлении товара в смету. Фильтр
// исключает деактивированные (is_active=false) и удалённые — их не хотим
// тянуть в новые сметы.
export const listItemsTriggeredByCategory = async (
  tx: Db,
  params: { companyId: string; productCategoryId: string },
): Promise<WorkItem[]> => {
  return tx
    .select()
    .from(workItems)
    .where(
      and(
        eq(workItems.companyId, params.companyId),
        eq(workItems.isActive, true),
        isNull(workItems.deletedAt),
        sql`${workItems.triggerCategoryIds} @> ARRAY[${params.productCategoryId}]::uuid[]`,
      ),
    )
    .orderBy(asc(workItems.name));
};

export const softDeleteItem = async (
  tx: Db,
  params: { id: string; companyId: string },
): Promise<boolean> => {
  const [row] = await tx
    .update(workItems)
    .set({ deletedAt: sql`now()` })
    .where(
      and(
        eq(workItems.id, params.id),
        eq(workItems.companyId, params.companyId),
        isNull(workItems.deletedAt),
      ),
    )
    .returning({ id: workItems.id });
  return row !== undefined;
};
