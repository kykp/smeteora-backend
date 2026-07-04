import { and, count, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
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
import { type EstimateStatus, type VatMode, type LineItemKind } from '../../db/constants.js';

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

type ListParams = {
  companyId: string;
  projectId?: string | undefined;
  status?: EstimateStatus | undefined;
  limit: number;
  offset: number;
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
    .orderBy(desc(estimates.createdAt))
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
        meta: sql`EXCLUDED.meta`,
      },
    })
    .returning();
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
  discountPercent: string;
  vatRateOverride: string | null;
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
    discountPercent: r.discountPercent,
    vatRateOverride: r.vatRateOverride,
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
        discountPercent: sql`EXCLUDED.discount_percent`,
        vatRateOverride: sql`EXCLUDED.vat_rate_override`,
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
