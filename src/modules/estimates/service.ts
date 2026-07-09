import { and, eq, isNull } from 'drizzle-orm';
import { type Db } from '../../db/client.js';
import {
  type Estimate,
  type EstimateSection,
  type EstimateLineItem,
  projects,
} from '../../db/schema/index.js';
import { ConflictError, NotFoundError, ValidationError } from '../../lib/errors.js';
import { type EstimateStatus, type VatMode, type LineItemKind } from '../../db/constants.js';
import { writeAudit } from '../../lib/audit.js';
import * as repo from './repo.js';
import {
  calcEstimate,
  calcLineItem,
  calcSectionNet,
  type CalcLineItemOutput,
} from './calculator.js';
import {
  type CreateEstimateBody,
  type EstimateHeader,
  type EstimateListItem,
  type EstimateTreeResponse,
  type ListEstimatesQuery,
  type ListEstimatesResponse,
  type UpdateEstimateBody,
  type UpsertTreeBody,
} from './schema.js';

// ── DTO мапперы ─────────────────────────────────────────────────

const asMeta = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const estimateToHeader = (row: Estimate): EstimateHeader => ({
  id: row.id,
  projectId: row.projectId,
  number: row.number,
  title: row.title,
  currency: row.currency,
  vatMode: row.vatMode,
  vatRate: row.vatRate,
  discountPercent: row.discountPercent,
  discountAmount: row.discountAmount,
  status: row.status,
  notes: row.notes,
  meta: asMeta(row.meta),
  createdBy: row.createdBy,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

// ── Валидация project'а — RLS отсечёт чужой, а soft-delete проверим руками ──

const ensureProjectExists = async (
  tx: Db,
  params: { companyId: string; projectId: string },
): Promise<void> => {
  const rows = await tx
    .select({ id: projects.id })
    .from(projects)
    .where(
      and(
        eq(projects.id, params.projectId),
        eq(projects.companyId, params.companyId),
        isNull(projects.deletedAt),
      ),
    )
    .limit(1);
  if (rows[0] === undefined) {
    // Оборачиваем как validation-ошибку: пользователь дал невалидный projectId
    // в теле create-запроса. 404 бросать не хочется — семантически это плохой input,
    // а не отсутствующий ресурс.
    throw new ValidationError('Проект не найден в текущей компании');
  }
};

// ── List ────────────────────────────────────────────────────────

// Собирает EstimateListItem: шапка + рассчитанные totals.
// Для totals нужен обход всех позиций сметы. В MVP делаем прямолинейно — N+1.
// Когда встанет вопрос производительности, вынесем в SQL-агрегат.
const buildListItem = async (
  tx: Db,
  ctx: { companyId: string },
  est: Estimate,
): Promise<EstimateListItem> => {
  const items = await repo.listLineItemsByEstimate(tx, {
    estimateId: est.id,
    companyId: ctx.companyId,
  });
  const lineOutputs = items.map((li) =>
    calcLineItem({
      id: li.id,
      sectionId: li.sectionId,
      quantity: li.quantity,
      price: li.price,
      discountPercent: li.discountPercent,
    }),
  );
  const totals = calcEstimate(
    {
      vatMode: est.vatMode,
      vatRate: est.vatRate,
      discountPercent: est.discountPercent,
      discountAmount: est.discountAmount,
    },
    lineOutputs,
  );
  return { ...estimateToHeader(est), totals };
};

export const list = async (
  tx: Db,
  ctx: { companyId: string },
  query: ListEstimatesQuery,
): Promise<ListEstimatesResponse> => {
  const { items, total } = await repo.listByCompany(tx, {
    companyId: ctx.companyId,
    projectId: query.projectId,
    status: query.status,
    limit: query.limit,
    offset: query.offset,
  });
  const enriched = await Promise.all(items.map((e) => buildListItem(tx, ctx, e)));
  return { items: enriched, total, limit: query.limit, offset: query.offset };
};

// ── Create (без дерева) ────────────────────────────────────────

export const create = async (
  tx: Db,
  ctx: { companyId: string; membershipId: string },
  body: CreateEstimateBody,
): Promise<EstimateTreeResponse> => {
  await ensureProjectExists(tx, { companyId: ctx.companyId, projectId: body.projectId });

  const est = await repo.insertEstimate(tx, {
    companyId: ctx.companyId,
    projectId: body.projectId,
    number: body.number == null || body.number === '' ? null : body.number,
    title: body.title.trim(),
    currency: body.currency,
    vatMode: body.vatMode,
    vatRate: body.vatRate == null ? null : body.vatRate,
    discountPercent: body.discountPercent == null ? null : body.discountPercent,
    discountAmount: body.discountAmount == null ? null : body.discountAmount,
    notes: body.notes == null || body.notes === '' ? null : body.notes,
    meta: body.meta ?? {},
    createdBy: ctx.membershipId,
  });

  return assembleTree(tx, ctx, est, [], []);
};

// ── Get tree ───────────────────────────────────────────────────

export const getTree = async (
  tx: Db,
  ctx: { companyId: string },
  id: string,
): Promise<EstimateTreeResponse> => {
  const est = await repo.findEstimateById(tx, { id, companyId: ctx.companyId });
  if (!est) throw new NotFoundError('Смета не найдена');

  const [sections, items] = await Promise.all([
    repo.listSectionsByEstimate(tx, { estimateId: est.id, companyId: ctx.companyId }),
    repo.listLineItemsByEstimate(tx, { estimateId: est.id, companyId: ctx.companyId }),
  ]);
  return assembleTree(tx, ctx, est, sections, items);
};

// ── Upsert tree ────────────────────────────────────────────────

// Логика:
// 1) Читаем текущие sections+items сметы.
// 2) diff по id: to_delete (в БД нет в body), to_upsert (есть в body).
// 3) Удаляем items → удаляем sections (порядок: сначала children, чтобы FK не бился).
// 4) UPSERT sections по id, UPSERT items по id.
// 5) UPDATE шапки если body.estimate задан.
// 6) Собираем и возвращаем актуальное дерево.
//
// Атомарность обеспечивается request.tx — если любой шаг упал, весь запрос откатывается.

export const upsertTree = async (
  tx: Db,
  ctx: { companyId: string },
  id: string,
  body: UpsertTreeBody,
): Promise<EstimateTreeResponse> => {
  const est = await repo.findEstimateById(tx, { id, companyId: ctx.companyId });
  if (!est) throw new NotFoundError('Смета не найдена');

  const currentSections = await repo.listSectionsByEstimate(tx, {
    estimateId: est.id,
    companyId: ctx.companyId,
  });
  const currentItems = await repo.listLineItemsByEstimate(tx, {
    estimateId: est.id,
    companyId: ctx.companyId,
  });

  const bodySectionIds = new Set(body.sections.map((s) => s.id));
  const bodyItemIds = new Set(body.lineItems.map((li) => li.id));

  const sectionsToDelete = currentSections
    .filter((s) => !bodySectionIds.has(s.id))
    .map((s) => s.id);
  const itemsToDelete = currentItems.filter((li) => !bodyItemIds.has(li.id)).map((li) => li.id);

  // Сначала items (children), потом sections (parents).
  await repo.deleteLineItems(tx, {
    estimateId: est.id,
    companyId: ctx.companyId,
    ids: itemsToDelete,
  });
  await repo.deleteSections(tx, {
    estimateId: est.id,
    companyId: ctx.companyId,
    ids: sectionsToDelete,
  });

  // UPSERT sections. sortOrder / parentId / title / meta — из body.
  await repo.upsertSections(
    tx,
    body.sections.map((s) => ({
      id: s.id,
      companyId: ctx.companyId,
      estimateId: est.id,
      parentId: s.parentId ?? null,
      title: s.title.trim(),
      sortOrder: s.sortOrder,
      meta: s.meta ?? {},
    })),
  );

  // UPSERT line items.
  await repo.upsertLineItems(
    tx,
    body.lineItems.map((li) => ({
      id: li.id,
      companyId: ctx.companyId,
      estimateId: est.id,
      sectionId: li.sectionId ?? null,
      productId: li.productId ?? null,
      catalogSnapshot: li.catalogSnapshot ?? null,
      kind: (li.kind ?? 'work') as LineItemKind,
      name: li.name.trim(),
      unit: li.unit.trim(),
      quantity: li.quantity,
      price: li.price,
      discountPercent: li.discountPercent ?? '0',
      vatRateOverride: li.vatRateOverride ?? null,
      sortOrder: li.sortOrder,
      meta: li.meta ?? {},
    })),
  );

  // UPDATE шапки, если задана.
  let updatedEstimate: Estimate = est;
  if (body.estimate !== undefined) {
    const patch: repo.UpdateEstimateHeader = {};
    const h = body.estimate;
    if (h.number !== undefined)
      patch.number = h.number == null || h.number === '' ? null : h.number;
    if (h.title !== undefined) patch.title = h.title.trim();
    if (h.currency !== undefined) patch.currency = h.currency;
    if (h.vatMode !== undefined) patch.vatMode = h.vatMode as VatMode;
    if (h.vatRate !== undefined) patch.vatRate = h.vatRate ?? null;
    if (h.discountPercent !== undefined) patch.discountPercent = h.discountPercent ?? null;
    if (h.discountAmount !== undefined) patch.discountAmount = h.discountAmount ?? null;
    if (h.notes !== undefined) patch.notes = h.notes == null || h.notes === '' ? null : h.notes;
    if (h.meta !== undefined) patch.meta = h.meta;

    // Валидация НДС: если в патче vatMode стал не-none — vatRate обязателен
    // (либо в патче, либо уже в БД).
    const resolvedVatMode = patch.vatMode ?? est.vatMode;
    const resolvedVatRate = patch.vatRate !== undefined ? patch.vatRate : est.vatRate;
    if (resolvedVatMode !== 'none' && resolvedVatRate == null) {
      throw new ValidationError('При vatMode != none нужно задать vatRate');
    }

    const updated = await repo.updateEstimateHeader(tx, {
      id: est.id,
      companyId: ctx.companyId,
      patch,
    });
    if (!updated) throw new NotFoundError('Смета не найдена');
    updatedEstimate = updated;
  }

  // Возвращаем актуальное дерево из БД (не из памяти) — чтобы фронт получил
  // финальные createdAt/updatedAt/companyId + рассчитанные суммы.
  const [freshSections, freshItems] = await Promise.all([
    repo.listSectionsByEstimate(tx, { estimateId: est.id, companyId: ctx.companyId }),
    repo.listLineItemsByEstimate(tx, { estimateId: est.id, companyId: ctx.companyId }),
  ]);
  return assembleTree(tx, ctx, updatedEstimate, freshSections, freshItems);
};

// ── Update header (PATCH /:id) ─────────────────────────────────
// Частичное обновление шапки без пересборки дерева. Основной кейс — синхронизация
// title сметы с name проекта при переименовании. Логика проверок та же что в
// upsertTree.estimate-ветке; общий хелпер выделять сейчас нет смысла — две
// точки использования.

export const updateHeader = async (
  tx: Db,
  ctx: { companyId: string },
  id: string,
  body: UpdateEstimateBody,
): Promise<EstimateTreeResponse> => {
  const est = await repo.findEstimateById(tx, { id, companyId: ctx.companyId });
  if (!est) throw new NotFoundError('Смета не найдена');

  const patch: repo.UpdateEstimateHeader = {};
  if (body.number !== undefined)
    patch.number = body.number == null || body.number === '' ? null : body.number;
  if (body.title !== undefined) patch.title = body.title.trim();
  if (body.currency !== undefined) patch.currency = body.currency;
  if (body.vatMode !== undefined) patch.vatMode = body.vatMode as VatMode;
  if (body.vatRate !== undefined) patch.vatRate = body.vatRate ?? null;
  if (body.discountPercent !== undefined) patch.discountPercent = body.discountPercent ?? null;
  if (body.discountAmount !== undefined) patch.discountAmount = body.discountAmount ?? null;
  if (body.notes !== undefined)
    patch.notes = body.notes == null || body.notes === '' ? null : body.notes;
  if (body.meta !== undefined) patch.meta = body.meta;

  const resolvedVatMode = patch.vatMode ?? est.vatMode;
  const resolvedVatRate = patch.vatRate !== undefined ? patch.vatRate : est.vatRate;
  if (resolvedVatMode !== 'none' && resolvedVatRate == null) {
    throw new ValidationError('При vatMode != none нужно задать vatRate');
  }

  const updated = await repo.updateEstimateHeader(tx, {
    id: est.id,
    companyId: ctx.companyId,
    patch,
  });
  if (!updated) throw new NotFoundError('Смета не найдена');

  const [sections, items] = await Promise.all([
    repo.listSectionsByEstimate(tx, { estimateId: updated.id, companyId: ctx.companyId }),
    repo.listLineItemsByEstimate(tx, { estimateId: updated.id, companyId: ctx.companyId }),
  ]);
  return assembleTree(tx, ctx, updated, sections, items);
};

// ── Soft delete ────────────────────────────────────────────────

export const softDelete = async (
  tx: Db,
  ctx: { companyId: string; userId: string; sessionId: string },
  id: string,
): Promise<void> => {
  const ok = await repo.softDeleteEstimate(tx, { id, companyId: ctx.companyId });
  if (!ok) throw new NotFoundError('Смета не найдена');
  await writeAudit(tx, {
    companyId: ctx.companyId,
    userId: ctx.userId,
    sessionId: ctx.sessionId,
    action: 'estimate.delete',
    entityType: 'estimate',
    entityId: id,
  });
};

// ── Archive / unarchive ────────────────────────────────────────
// archive: любой статус кроме archived → archived. Повторный запрос → 409.
// unarchive: только из archived → draft.
// Логика "вернуть в предыдущий статус" требовала бы отдельного поля previous_status —
// избыточно для MVP; archive-жизненный цикл линейный: работа → архив → (если нужно) снова draft.

const setStatus = async (
  tx: Db,
  ctx: { companyId: string },
  id: string,
  guard: (est: Estimate) => void,
  toStatus: EstimateStatus,
): Promise<EstimateTreeResponse> => {
  const est = await repo.findEstimateById(tx, { id, companyId: ctx.companyId });
  if (!est) throw new NotFoundError('Смета не найдена');
  guard(est);

  const row = await repo.setEstimateStatus(tx, {
    id,
    companyId: ctx.companyId,
    status: toStatus,
  });
  if (!row) throw new NotFoundError('Смета не найдена');

  const [freshSections, freshItems] = await Promise.all([
    repo.listSectionsByEstimate(tx, { estimateId: row.id, companyId: ctx.companyId }),
    repo.listLineItemsByEstimate(tx, { estimateId: row.id, companyId: ctx.companyId }),
  ]);
  return assembleTree(tx, ctx, row, freshSections, freshItems);
};

export const archive = (
  tx: Db,
  ctx: { companyId: string },
  id: string,
): Promise<EstimateTreeResponse> =>
  setStatus(
    tx,
    ctx,
    id,
    (est) => {
      if (est.status === 'archived') {
        throw new ConflictError('Смета уже в архиве');
      }
    },
    'archived',
  );

export const unarchive = (
  tx: Db,
  ctx: { companyId: string },
  id: string,
): Promise<EstimateTreeResponse> =>
  setStatus(
    tx,
    ctx,
    id,
    (est) => {
      if (est.status !== 'archived') {
        throw new ConflictError('Смета не в архиве');
      }
    },
    'draft',
  );

// ── Assemble tree с расчётами ──────────────────────────────────

const assembleTree = async (
  _tx: Db,
  _ctx: { companyId: string },
  est: Estimate,
  sections: EstimateSection[],
  items: EstimateLineItem[],
): Promise<EstimateTreeResponse> => {
  // Рассчитываем по каждой позиции.
  const itemTotals = new Map<string, CalcLineItemOutput>();
  for (const li of items) {
    itemTotals.set(
      li.id,
      calcLineItem({
        id: li.id,
        sectionId: li.sectionId,
        quantity: li.quantity,
        price: li.price,
        discountPercent: li.discountPercent,
      }),
    );
  }

  // Группируем net позиций по sectionId, чтобы посчитать section.totals.
  const itemsBySection = new Map<string, EstimateLineItem[]>();
  for (const li of items) {
    const key = li.sectionId ?? '__root__';
    const arr = itemsBySection.get(key) ?? [];
    arr.push(li);
    itemsBySection.set(key, arr);
  }

  const sectionOut = sections
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((s) => {
      const sItems = itemsBySection.get(s.id) ?? [];
      const nets = sItems.map((li) => itemTotals.get(li.id)?.net ?? '0');
      return {
        id: s.id,
        estimateId: s.estimateId,
        parentId: s.parentId,
        title: s.title,
        sortOrder: s.sortOrder,
        meta: asMeta(s.meta),
        createdAt: s.createdAt.toISOString(),
        updatedAt: s.updatedAt.toISOString(),
        totals: {
          itemsCount: sItems.length,
          net: calcSectionNet(nets),
        },
      };
    });

  const itemOut = items
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((li) => {
      const t = itemTotals.get(li.id) ?? { gross: '0', discount: '0', net: '0' };
      return {
        id: li.id,
        estimateId: li.estimateId,
        sectionId: li.sectionId,
        productId: li.productId,
        catalogSnapshot: li.catalogSnapshot as Record<string, unknown> | null,
        kind: li.kind,
        name: li.name,
        unit: li.unit,
        quantity: li.quantity,
        price: li.price,
        discountPercent: li.discountPercent,
        vatRateOverride: li.vatRateOverride,
        sortOrder: li.sortOrder,
        meta: asMeta(li.meta),
        createdAt: li.createdAt.toISOString(),
        updatedAt: li.updatedAt.toISOString(),
        totals: t,
      };
    });

  const totals = calcEstimate(
    {
      vatMode: est.vatMode,
      vatRate: est.vatRate,
      discountPercent: est.discountPercent,
      discountAmount: est.discountAmount,
    },
    Array.from(itemTotals.values()),
  );

  return {
    estimate: estimateToHeader(est),
    totals,
    sections: sectionOut,
    lineItems: itemOut,
  };
};

// exports для тестов и потенциальных внутренних сервисов
export { assembleTree };

// Не даёт TS/ESLint жаловаться на неиспользованные типы в некоторых версиях.
export type { EstimateStatus };
