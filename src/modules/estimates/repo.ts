import { and, asc, count, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { type Db } from '../../db/client.js';
import {
  estimates,
  estimateSections,
  estimateLineItems,
  type Estimate,
  type EstimateSection,
  type EstimateLineItem,
  type NewEstimateSection,
  type NewEstimateLineItem,
} from '../../db/schema/index.js';
import {
  type EstimateMode,
  type EstimateStatus,
  type PriceBasis,
  type VatMode,
  type LineItemKind,
  type TaxRegime,
  type TaxBaseKind,
} from '../../db/constants.js';

// ── expose для service (archive/unarchive) ──────────────────────
// Отдельный метод смены статуса. Через updateEstimateHeader статус НЕ проходит
// намеренно — status меняется только через явные операции (archive/unarchive/
// будущий send), не как обычное поле шапки.
export const setEstimateStatus = async (
  tx: Db,
  params: { id: string; companyId: string; status: EstimateStatus },
) => {
  const [row] = await tx
    .update(estimates)
    .set({ status: params.status })
    .where(
      and(
        eq(estimates.id, params.id),
        eq(estimates.companyId, params.companyId),
        isNull(estimates.deletedAt),
      ),
    )
    .returning();
  return row;
};

// Все методы принимают tx с уже установленным app.current_company_id.
// RLS отсекает чужие компании; belt-and-suspenders — явный WHERE company_id.

// ── Estimates (шапка) ────────────────────────────────────────────

export type EstimateSortOption =
  | 'updatedAt.desc'
  | 'updatedAt.asc'
  | 'createdAt.desc'
  | 'createdAt.asc'
  | 'title.asc'
  | 'title.desc';

type ListParams = {
  companyId: string;
  projectId?: string | undefined;
  status?: EstimateStatus | undefined;
  sort: EstimateSortOption;
  limit: number;
  offset: number;
};

// Тайбрейкер id: если два ряда имеют одинаковое updatedAt/createdAt/title —
// порядок стабильный между страницами, иначе offset-пагинация может дать
// дубли или пропуски.
const buildOrderBy = (sort: EstimateSortOption): SQL[] => {
  switch (sort) {
    case 'updatedAt.asc':
      return [asc(estimates.updatedAt), asc(estimates.id)];
    case 'createdAt.desc':
      return [desc(estimates.createdAt), desc(estimates.id)];
    case 'createdAt.asc':
      return [asc(estimates.createdAt), asc(estimates.id)];
    case 'title.asc':
      return [asc(estimates.title), asc(estimates.id)];
    case 'title.desc':
      return [desc(estimates.title), desc(estimates.id)];
    case 'updatedAt.desc':
    default:
      return [desc(estimates.updatedAt), desc(estimates.id)];
  }
};

export const listByCompany = async (
  tx: Db,
  params: ListParams,
): Promise<{ items: Estimate[]; total: number }> => {
  const conditions = [
    eq(estimates.companyId, params.companyId),
    isNull(estimates.deletedAt),
    ...(params.projectId !== undefined ? [eq(estimates.projectId, params.projectId)] : []),
    ...(params.status !== undefined ? [eq(estimates.status, params.status)] : []),
  ];

  const items = await tx
    .select()
    .from(estimates)
    .where(and(...conditions))
    .orderBy(...buildOrderBy(params.sort))
    .limit(params.limit)
    .offset(params.offset);

  const [countRow] = await tx
    .select({ value: count() })
    .from(estimates)
    .where(and(...conditions));

  return { items, total: countRow?.value ?? 0 };
};

export const findEstimateById = async (
  tx: Db,
  params: { id: string; companyId: string },
): Promise<Estimate | undefined> => {
  const rows = await tx
    .select()
    .from(estimates)
    .where(
      and(
        eq(estimates.id, params.id),
        eq(estimates.companyId, params.companyId),
        isNull(estimates.deletedAt),
      ),
    )
    .limit(1);
  return rows[0];
};

export type InsertEstimateInput = {
  companyId: string;
  projectId: string;
  number: string | null;
  title: string;
  currency: string;
  vatMode: VatMode;
  vatRate: string | null;
  discountPercent: string | null;
  discountAmount: string | null;
  mode: EstimateMode;
  notes: string | null;
  meta: Record<string, unknown>;
  createdBy: string | null;
};

export const insertEstimate = async (tx: Db, input: InsertEstimateInput): Promise<Estimate> => {
  const [row] = await tx.insert(estimates).values(input).returning();
  if (!row) throw new Error('estimates insert вернул пусто');
  return row;
};

export type UpdateEstimateHeader = {
  number?: string | null;
  title?: string;
  currency?: string;
  vatMode?: VatMode;
  vatRate?: string | null;
  discountPercent?: string | null;
  discountAmount?: string | null;
  mode?: EstimateMode;
  taxRegime?: TaxRegime;
  taxRate?: string | null;
  taxBaseKind?: TaxBaseKind | null;
  notes?: string | null;
  meta?: Record<string, unknown>;
};

export const updateEstimateHeader = async (
  tx: Db,
  params: { id: string; companyId: string; patch: UpdateEstimateHeader },
): Promise<Estimate | undefined> => {
  if (Object.keys(params.patch).length === 0) {
    return findEstimateById(tx, { id: params.id, companyId: params.companyId });
  }
  const [row] = await tx
    .update(estimates)
    .set(params.patch)
    .where(
      and(
        eq(estimates.id, params.id),
        eq(estimates.companyId, params.companyId),
        isNull(estimates.deletedAt),
      ),
    )
    .returning();
  return row;
};

export const softDeleteEstimate = async (
  tx: Db,
  params: { id: string; companyId: string },
): Promise<boolean> => {
  const [row] = await tx
    .update(estimates)
    .set({ deletedAt: sql`now()` })
    .where(
      and(
        eq(estimates.id, params.id),
        eq(estimates.companyId, params.companyId),
        isNull(estimates.deletedAt),
      ),
    )
    .returning({ id: estimates.id });
  return row !== undefined;
};

// Атомарно инкрементит version + updated_at сметы. Возвращает:
//   { ok: true, version } — если expectedVersion не задан или совпал;
//   { ok: false, current } — если expectedVersion задан и не совпал
//     (кто-то уже обновил смету). current — актуальная версия для 409.
//   { ok: false, current: null } — сметы нет / она удалена.
//
// Используется во ВСЕХ доменных мутациях сметы (шапка, строки, разделы).
// Через WHERE version = $expected гарантирует atomic compare-and-swap.
export type BumpVersionResult =
  { ok: true; version: number } | { ok: false; current: number | null };

export const bumpEstimateVersion = async (
  tx: Db,
  params: { id: string; companyId: string; expectedVersion: number | null },
): Promise<BumpVersionResult> => {
  const conditions = [
    eq(estimates.id, params.id),
    eq(estimates.companyId, params.companyId),
    isNull(estimates.deletedAt),
  ];
  if (params.expectedVersion !== null) {
    conditions.push(eq(estimates.version, params.expectedVersion));
  }
  const [row] = await tx
    .update(estimates)
    .set({ version: sql`${estimates.version} + 1`, updatedAt: sql`now()` })
    .where(and(...conditions))
    .returning({ version: estimates.version });
  if (row !== undefined) {
    return { ok: true, version: row.version };
  }
  // UPDATE вернул 0 строк — либо не совпал expectedVersion, либо сметы нет.
  const current = await findEstimateById(tx, {
    id: params.id,
    companyId: params.companyId,
  });
  return { ok: false, current: current?.version ?? null };
};

// ── Sections ─────────────────────────────────────────────────────

export const listSectionsByEstimate = async (
  tx: Db,
  params: { estimateId: string; companyId: string },
): Promise<EstimateSection[]> =>
  tx
    .select()
    .from(estimateSections)
    .where(
      and(
        eq(estimateSections.estimateId, params.estimateId),
        eq(estimateSections.companyId, params.companyId),
      ),
    )
    .orderBy(estimateSections.sortOrder, estimateSections.createdAt);

export type UpsertSectionInput = {
  id: string;
  companyId: string;
  estimateId: string;
  parentId: string | null;
  title: string;
  sortOrder: number;
  defaultMarginPercent: string | null;
  defaultDiscountPercent: string | null;
  meta: Record<string, unknown>;
};

// Bulk-upsert через ON CONFLICT (id). Обновляем поля если строка уже есть.
// Возвращает актуальные строки.
export const upsertSections = async (
  tx: Db,
  rows: UpsertSectionInput[],
): Promise<EstimateSection[]> => {
  if (rows.length === 0) return [];
  const values: NewEstimateSection[] = rows.map((r) => ({
    id: r.id,
    companyId: r.companyId,
    estimateId: r.estimateId,
    parentId: r.parentId,
    title: r.title,
    sortOrder: r.sortOrder,
    defaultMarginPercent: r.defaultMarginPercent,
    defaultDiscountPercent: r.defaultDiscountPercent,
    meta: r.meta,
  }));
  return tx
    .insert(estimateSections)
    .values(values)
    .onConflictDoUpdate({
      target: estimateSections.id,
      set: {
        parentId: sql`EXCLUDED.parent_id`,
        title: sql`EXCLUDED.title`,
        sortOrder: sql`EXCLUDED.sort_order`,
        defaultMarginPercent: sql`EXCLUDED.default_margin_percent`,
        defaultDiscountPercent: sql`EXCLUDED.default_discount_percent`,
        meta: sql`EXCLUDED.meta`,
      },
    })
    .returning();
};

// ── Single-row CRUD sections (для отдельных POST/PATCH/DELETE) ──

export type InsertSectionInput = Omit<UpsertSectionInput, 'id'> & { id?: string };

export const insertSection = async (
  tx: Db,
  input: InsertSectionInput,
): Promise<EstimateSection> => {
  const [row] = await tx
    .insert(estimateSections)
    .values({
      ...(input.id !== undefined ? { id: input.id } : {}),
      companyId: input.companyId,
      estimateId: input.estimateId,
      parentId: input.parentId,
      title: input.title,
      sortOrder: input.sortOrder,
      defaultMarginPercent: input.defaultMarginPercent,
      defaultDiscountPercent: input.defaultDiscountPercent,
      meta: input.meta,
    })
    .returning();
  if (!row) throw new Error('sections insert вернул пусто');
  return row;
};

export const findSectionById = async (
  tx: Db,
  params: { id: string; estimateId: string; companyId: string },
): Promise<EstimateSection | undefined> => {
  const rows = await tx
    .select()
    .from(estimateSections)
    .where(
      and(
        eq(estimateSections.id, params.id),
        eq(estimateSections.estimateId, params.estimateId),
        eq(estimateSections.companyId, params.companyId),
      ),
    )
    .limit(1);
  return rows[0];
};

export type UpdateSectionPatch = Partial<{
  parentId: string | null;
  title: string;
  sortOrder: number;
  defaultMarginPercent: string | null;
  defaultDiscountPercent: string | null;
  meta: Record<string, unknown>;
}>;

export const updateSection = async (
  tx: Db,
  params: {
    id: string;
    estimateId: string;
    companyId: string;
    patch: UpdateSectionPatch;
  },
): Promise<EstimateSection | undefined> => {
  if (Object.keys(params.patch).length === 0) {
    return findSectionById(tx, params);
  }
  const [row] = await tx
    .update(estimateSections)
    .set(params.patch)
    .where(
      and(
        eq(estimateSections.id, params.id),
        eq(estimateSections.estimateId, params.estimateId),
        eq(estimateSections.companyId, params.companyId),
      ),
    )
    .returning();
  return row;
};

export const deleteSection = async (
  tx: Db,
  params: { id: string; estimateId: string; companyId: string },
): Promise<boolean> => {
  const [row] = await tx
    .delete(estimateSections)
    .where(
      and(
        eq(estimateSections.id, params.id),
        eq(estimateSections.estimateId, params.estimateId),
        eq(estimateSections.companyId, params.companyId),
      ),
    )
    .returning({ id: estimateSections.id });
  return row !== undefined;
};

export const maxSectionSortOrder = async (
  tx: Db,
  params: { estimateId: string; companyId: string },
): Promise<number> => {
  const [row] = await tx
    .select({ max: sql<number | null>`max(${estimateSections.sortOrder})` })
    .from(estimateSections)
    .where(
      and(
        eq(estimateSections.estimateId, params.estimateId),
        eq(estimateSections.companyId, params.companyId),
      ),
    );
  return row?.max ?? -1;
};

export const deleteSections = async (
  tx: Db,
  params: { estimateId: string; companyId: string; ids: string[] },
): Promise<void> => {
  if (params.ids.length === 0) return;
  await tx
    .delete(estimateSections)
    .where(
      and(
        eq(estimateSections.estimateId, params.estimateId),
        eq(estimateSections.companyId, params.companyId),
        inArray(estimateSections.id, params.ids),
      ),
    );
};

// ── Line items ───────────────────────────────────────────────────

export const listLineItemsByEstimate = async (
  tx: Db,
  params: { estimateId: string; companyId: string },
): Promise<EstimateLineItem[]> =>
  tx
    .select()
    .from(estimateLineItems)
    .where(
      and(
        eq(estimateLineItems.estimateId, params.estimateId),
        eq(estimateLineItems.companyId, params.companyId),
      ),
    )
    .orderBy(estimateLineItems.sortOrder, estimateLineItems.createdAt);

export type UpsertLineItemInput = {
  id: string;
  companyId: string;
  estimateId: string;
  sectionId: string | null;
  productId: string | null;
  catalogSnapshot: Record<string, unknown> | null;
  kind: LineItemKind;
  name: string;
  unit: string;
  quantity: string;
  price: string;
  cost: string;
  discountPercent: string;
  vatRateOverride: string | null;
  customMarginPercent: string | null;
  customDiscountPercent: string | null;
  priceBasis: PriceBasis;
  expenseCategory: string | null;
  sortOrder: number;
  meta: Record<string, unknown>;
};

export const upsertLineItems = async (
  tx: Db,
  rows: UpsertLineItemInput[],
): Promise<EstimateLineItem[]> => {
  if (rows.length === 0) return [];
  const values: NewEstimateLineItem[] = rows.map((r) => ({
    id: r.id,
    companyId: r.companyId,
    estimateId: r.estimateId,
    sectionId: r.sectionId,
    productId: r.productId,
    catalogSnapshot: r.catalogSnapshot,
    kind: r.kind,
    name: r.name,
    unit: r.unit,
    quantity: r.quantity,
    price: r.price,
    cost: r.cost,
    discountPercent: r.discountPercent,
    vatRateOverride: r.vatRateOverride,
    customMarginPercent: r.customMarginPercent,
    customDiscountPercent: r.customDiscountPercent,
    priceBasis: r.priceBasis,
    expenseCategory: r.expenseCategory,
    sortOrder: r.sortOrder,
    meta: r.meta,
  }));
  return tx
    .insert(estimateLineItems)
    .values(values)
    .onConflictDoUpdate({
      target: estimateLineItems.id,
      set: {
        sectionId: sql`EXCLUDED.section_id`,
        productId: sql`EXCLUDED.product_id`,
        catalogSnapshot: sql`EXCLUDED.catalog_snapshot`,
        kind: sql`EXCLUDED.kind`,
        name: sql`EXCLUDED.name`,
        unit: sql`EXCLUDED.unit`,
        quantity: sql`EXCLUDED.quantity`,
        price: sql`EXCLUDED.price`,
        cost: sql`EXCLUDED.cost`,
        discountPercent: sql`EXCLUDED.discount_percent`,
        vatRateOverride: sql`EXCLUDED.vat_rate_override`,
        customMarginPercent: sql`EXCLUDED.custom_margin_percent`,
        customDiscountPercent: sql`EXCLUDED.custom_discount_percent`,
        priceBasis: sql`EXCLUDED.price_basis`,
        expenseCategory: sql`EXCLUDED.expense_category`,
        sortOrder: sql`EXCLUDED.sort_order`,
        meta: sql`EXCLUDED.meta`,
      },
    })
    .returning();
};

export const deleteLineItems = async (
  tx: Db,
  params: { estimateId: string; companyId: string; ids: string[] },
): Promise<void> => {
  if (params.ids.length === 0) return;
  await tx
    .delete(estimateLineItems)
    .where(
      and(
        eq(estimateLineItems.estimateId, params.estimateId),
        eq(estimateLineItems.companyId, params.companyId),
        inArray(estimateLineItems.id, params.ids),
      ),
    );
};

// ── Single-row CRUD line_items (для отдельных POST/PATCH/DELETE эндпоинтов) ──

export type InsertLineItemInput = Omit<UpsertLineItemInput, 'id'> & { id?: string };

export const insertLineItem = async (
  tx: Db,
  input: InsertLineItemInput,
): Promise<EstimateLineItem> => {
  const [row] = await tx
    .insert(estimateLineItems)
    .values({
      // id, если передан — используем; иначе генерирует БД через default.
      ...(input.id !== undefined ? { id: input.id } : {}),
      companyId: input.companyId,
      estimateId: input.estimateId,
      sectionId: input.sectionId,
      productId: input.productId,
      catalogSnapshot: input.catalogSnapshot,
      kind: input.kind,
      name: input.name,
      unit: input.unit,
      quantity: input.quantity,
      price: input.price,
      cost: input.cost,
      discountPercent: input.discountPercent,
      vatRateOverride: input.vatRateOverride,
      customMarginPercent: input.customMarginPercent,
      customDiscountPercent: input.customDiscountPercent,
      priceBasis: input.priceBasis,
      expenseCategory: input.expenseCategory,
      sortOrder: input.sortOrder,
      meta: input.meta,
    })
    .returning();
  if (!row) throw new Error('line_items insert вернул пусто');
  return row;
};

export const findLineItemById = async (
  tx: Db,
  params: { id: string; estimateId: string; companyId: string },
): Promise<EstimateLineItem | undefined> => {
  const rows = await tx
    .select()
    .from(estimateLineItems)
    .where(
      and(
        eq(estimateLineItems.id, params.id),
        eq(estimateLineItems.estimateId, params.estimateId),
        eq(estimateLineItems.companyId, params.companyId),
      ),
    )
    .limit(1);
  return rows[0];
};

export type UpdateLineItemPatch = Partial<{
  sectionId: string | null;
  productId: string | null;
  catalogSnapshot: Record<string, unknown> | null;
  kind: LineItemKind;
  name: string;
  unit: string;
  quantity: string;
  price: string;
  cost: string;
  discountPercent: string;
  vatRateOverride: string | null;
  customMarginPercent: string | null;
  customDiscountPercent: string | null;
  priceBasis: PriceBasis;
  expenseCategory: string | null;
  sortOrder: number;
  meta: Record<string, unknown>;
}>;

export const updateLineItem = async (
  tx: Db,
  params: {
    id: string;
    estimateId: string;
    companyId: string;
    patch: UpdateLineItemPatch;
  },
): Promise<EstimateLineItem | undefined> => {
  if (Object.keys(params.patch).length === 0) {
    return findLineItemById(tx, params);
  }
  const [row] = await tx
    .update(estimateLineItems)
    .set(params.patch)
    .where(
      and(
        eq(estimateLineItems.id, params.id),
        eq(estimateLineItems.estimateId, params.estimateId),
        eq(estimateLineItems.companyId, params.companyId),
      ),
    )
    .returning();
  return row;
};

export const deleteLineItem = async (
  tx: Db,
  params: { id: string; estimateId: string; companyId: string },
): Promise<boolean> => {
  const [row] = await tx
    .delete(estimateLineItems)
    .where(
      and(
        eq(estimateLineItems.id, params.id),
        eq(estimateLineItems.estimateId, params.estimateId),
        eq(estimateLineItems.companyId, params.companyId),
      ),
    )
    .returning({ id: estimateLineItems.id });
  return row !== undefined;
};

// Максимальный sortOrder среди строк сметы. Используется для новой строки
// без явного sortOrder — идёт в конец.
export const maxLineItemSortOrder = async (
  tx: Db,
  params: { estimateId: string; companyId: string },
): Promise<number> => {
  const [row] = await tx
    .select({ max: sql<number | null>`max(${estimateLineItems.sortOrder})` })
    .from(estimateLineItems)
    .where(
      and(
        eq(estimateLineItems.estimateId, params.estimateId),
        eq(estimateLineItems.companyId, params.companyId),
      ),
    );
  return row?.max ?? -1;
};
