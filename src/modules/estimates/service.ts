import { and, eq, inArray, isNull } from 'drizzle-orm';
import { type Db } from '../../db/client.js';
import {
  type Estimate,
  type EstimateSection,
  type EstimateLineItem,
  estimateLineItems,
  projects,
} from '../../db/schema/index.js';
import { ConflictError, NotFoundError, ValidationError } from '../../lib/errors.js';
import {
  type EstimateMode,
  type EstimateStatus,
  type PriceBasis,
  type VatMode,
  type LineItemKind,
  type TaxRegime,
  type TaxBaseKind,
} from '../../db/constants.js';
import { writeAudit } from '../../lib/audit.js';
import { throwVersionConflict } from '../../lib/optimistic-concurrency.js';
import * as repo from './repo.js';
import * as worksRepo from '../works/repo.js';
import * as catalogRepo from '../catalog/repo.js';
import {
  calcEstimate,
  calcLineItem,
  calcSectionNet,
  type CalcLineItemOutput,
} from './calculator.js';
import {
  type CreateEstimateBody,
  type CreateLineItemBody,
  type CreateSectionBody,
  type EstimateHeader,
  type EstimateLineItemDto,
  type EstimateListItem,
  type EstimateTreeResponse,
  type ListEstimatesQuery,
  type ListEstimatesResponse,
  type UpdateEstimateBody,
  type UpdateLineItemBody,
  type UpdateSectionBody,
  type UpsertTreeBody,
} from './schema.js';
import { companies } from '../../db/schema/index.js';

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
  mode: row.mode,
  taxRegime: row.taxRegime,
  taxRate: row.taxRate,
  taxBaseKind: row.taxBaseKind,
  notes: row.notes,
  meta: asMeta(row.meta),
  version: row.version,
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
  projectStatus: EstimateListItem['projectStatus'],
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
  return { ...estimateToHeader(est), totals, projectStatus };
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
    projectStatus: query.projectStatus,
    q: query.q,
    sort: query.sort,
    limit: query.limit,
    offset: query.offset,
  });

  // Тянем статусы проектов одним запросом — иначе фронт делает /projects
  // отдельно и получает N+1 (или лимит по limit=200 может отсечь нужный
  // проект, как это уже случилось у одной сметы).
  const projectIds = Array.from(new Set(items.map((e) => e.projectId)));
  const projectStatusRows =
    projectIds.length > 0
      ? await tx
          .select({ id: projects.id, status: projects.status })
          .from(projects)
          .where(inArray(projects.id, projectIds))
      : [];
  const projectStatusById = new Map<string, EstimateListItem['projectStatus']>();
  for (const p of projectStatusRows) projectStatusById.set(p.id, p.status);

  const enriched = await Promise.all(
    items.map((e) => buildListItem(tx, ctx, e, projectStatusById.get(e.projectId) ?? 'draft')),
  );
  return { items: enriched, total, limit: query.limit, offset: query.offset };
};

// ── Create (без дерева) ────────────────────────────────────────

// Читает дефолтные наценки компании чтобы засеять новую смету двумя
// стандартными разделами. В отдельной функции — чтобы create мог продолжать
// работать даже если у компании ещё нет этих полей (nullable дефолт).
const readCompanyMarginDefaults = async (
  tx: Db,
  companyId: string,
): Promise<{ equipment: string | null; installation: string | null; other: string | null }> => {
  const rows = await tx
    .select({
      equipment: companies.defaultEquipmentMarginPercent,
      installation: companies.defaultInstallationMarginPercent,
      other: companies.defaultOtherMarginPercent,
    })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);
  const row = rows[0];
  return {
    equipment: row?.equipment ?? null,
    installation: row?.installation ?? null,
    other: row?.other ?? null,
  };
};

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
    mode: body.mode,
    notes: body.notes == null || body.notes === '' ? null : body.notes,
    meta: body.meta ?? {},
    createdBy: ctx.membershipId,
  });

  // Автосоздаём три фиксированных раздела «Оборудование», «Монтаж», «Другое»
  // с дефолтными наценками из настроек компании. Разделы всегда одинаковые
  // и создаются для ЛЮБОГО режима сметы — mode влияет только на UI
  // (в simple наценка на разделе игнорируется, юзер вводит цены руками).
  const margins = await readCompanyMarginDefaults(tx, ctx.companyId);
  await repo.upsertSections(tx, buildDefaultSections(ctx.companyId, est.id, margins));

  const sections = await repo.listSectionsByEstimate(tx, {
    estimateId: est.id,
    companyId: ctx.companyId,
  });
  return assembleTree(tx, ctx, est, sections, []);
};

// Строки из каталога (product_id≠null) с kind∈{material,work} обязаны лежать
// в каноническом разделе, соответствующем kind — иначе UI покажет их в чужом
// табе и юзер будет думать что позиции пропали. Хелпер возвращает раздел
// куда строка должна попасть; для kind='other'/'service' — «Другое».
const canonicalTitleForKind = (kind: LineItemKind): 'Оборудование' | 'Монтаж' | 'Другое' => {
  if (kind === 'work') return 'Монтаж';
  if (kind === 'material') return 'Оборудование';
  return 'Другое';
};

// Валидация при добавлении/обновлении строки: строка из каталога с явным
// kind='material'|'work' обязана лежать в соответствующем каноническом
// разделе. Ручные строки (без product_id) и kind='other'/'service' — не
// проверяем, юзер сам решил куда класть.
const assertLineFitsCanonicalSection = (params: {
  sections: Array<{ id: string; title: string }>;
  sectionId: string;
  kind: LineItemKind;
  hasProductId: boolean;
}): void => {
  if (!params.hasProductId) return;
  if (params.kind !== 'material' && params.kind !== 'work') return;
  const expectedTitle = canonicalTitleForKind(params.kind);
  const currentSection = params.sections.find((s) => s.id === params.sectionId);
  if (!currentSection) return;
  if (currentSection.title !== expectedTitle) {
    throw new ValidationError(
      `Позиция kind='${params.kind}' с product_id должна лежать в разделе «${expectedTitle}» (получен «${currentSection.title}»)`,
    );
  }
};

// Гарантирует что в смете ровно три раздела «Оборудование/Монтаж/Другое».
//   1) Дубликаты по title сливаются в первый (по sortOrder+createdAt): строки
//      переносятся, дубликаты удаляются.
//   2) Недостающие разделы создаются с дефолтными наценками из company.
//   3) Строки с невалидным section_id (null, orphaned на удалённый раздел, или
//      material/work из каталога попавшие в чужой раздел) перекладываются в
//      канонический раздел по kind. Ручные строки в «Другом» (product_id=null)
//      не трогаем.
// Идемпотентно: повторный вызов на чистой смете ничего не делает.
const ensureCanonicalSections = async (
  tx: Db,
  ctx: { companyId: string },
  estimateId: string,
  currentSections: EstimateSection[],
): Promise<EstimateSection[]> => {
  const CANONICAL_TITLES = ['Оборудование', 'Монтаж', 'Другое'] as const;

  // 1) Дедупликация по title: первый по sortOrder — «канонический», остальные
  // сливаем в него. Строки дубликата → на канонический sectionId, потом сам
  // дубликат удаляется.
  const byTitle = new Map<string, EstimateSection[]>();
  for (const s of currentSections) {
    const arr = byTitle.get(s.title) ?? [];
    arr.push(s);
    byTitle.set(s.title, arr);
  }
  const duplicatesToDelete: string[] = [];
  for (const [, group] of byTitle) {
    if (group.length <= 1) continue;
    group.sort(
      (a, b) => a.sortOrder - b.sortOrder || a.createdAt.getTime() - b.createdAt.getTime(),
    );
    const canonical = group[0];
    if (!canonical) continue;
    const dupIds = group.slice(1).map((s) => s.id);
    if (dupIds.length === 0) continue;
    // Строки дубликатов переносим на канонический раздел.
    await tx
      .update(estimateLineItems)
      .set({ sectionId: canonical.id })
      .where(
        and(
          eq(estimateLineItems.estimateId, estimateId),
          eq(estimateLineItems.companyId, ctx.companyId),
          inArray(estimateLineItems.sectionId, dupIds),
        ),
      );
    duplicatesToDelete.push(...dupIds);
  }
  if (duplicatesToDelete.length > 0) {
    await repo.deleteSections(tx, {
      estimateId,
      companyId: ctx.companyId,
      ids: duplicatesToDelete,
    });
  }

  let sections =
    duplicatesToDelete.length > 0
      ? await repo.listSectionsByEstimate(tx, { estimateId, companyId: ctx.companyId })
      : currentSections;

  // 2) Создаём недостающие канонические разделы.
  const existingTitles = new Set(sections.map((s) => s.title));
  const anyMissing = CANONICAL_TITLES.some((t) => !existingTitles.has(t));
  if (anyMissing) {
    const margins = await readCompanyMarginDefaults(tx, ctx.companyId);
    const missing = buildDefaultSections(ctx.companyId, estimateId, margins).filter(
      (s) => !existingTitles.has(s.title),
    );
    if (missing.length > 0) {
      await repo.upsertSections(tx, missing);
      sections = await repo.listSectionsByEstimate(tx, { estimateId, companyId: ctx.companyId });
    }
  }

  // 3) Автолечение строк с невалидным section_id. Три случая покрываем:
  //   a) section_id IS NULL — legacy / баг вставки.
  //   b) section_id ссылается на удалённый раздел (orphaned).
  //   c) product_id≠NULL + kind∈{material,work} в чужом каноническом разделе
  //      (например, material с product_id в «Другом» — так у нас юзеры и
  //      «теряли» позиции). Только с product_id — ручные записи не трогаем.
  const titleByCanonicalId = new Map<string, string>();
  for (const s of sections) {
    if (s.title === 'Оборудование' || s.title === 'Монтаж' || s.title === 'Другое') {
      titleByCanonicalId.set(s.id, s.title);
    }
  }
  const canonicalIdByTitle = new Map<string, string>();
  for (const [id, title] of titleByCanonicalId) canonicalIdByTitle.set(title, id);

  const allLines = await repo.listLineItemsByEstimate(tx, {
    estimateId,
    companyId: ctx.companyId,
  });
  const fixes: Array<{ id: string; sectionId: string }> = [];
  for (const line of allLines) {
    const targetTitle = canonicalTitleForKind(line.kind as LineItemKind);
    const targetId = canonicalIdByTitle.get(targetTitle);
    if (!targetId) continue;

    // a + b: невалидный / null section_id → по kind.
    const currentTitle = line.sectionId ? titleByCanonicalId.get(line.sectionId) : null;
    if (!currentTitle) {
      if (line.sectionId !== targetId) fixes.push({ id: line.id, sectionId: targetId });
      continue;
    }

    // c: строка из каталога в чужом каноническом разделе → по kind.
    const isCatalogLine = line.productId !== null;
    const isTypedKind = line.kind === 'material' || line.kind === 'work';
    if (isCatalogLine && isTypedKind && currentTitle !== targetTitle) {
      fixes.push({ id: line.id, sectionId: targetId });
    }
  }
  if (fixes.length > 0) {
    // Батчим по target sectionId — по одному UPDATE на группу, чтобы не
    // спамить БД сотнями точечных апдейтов на больших сметах.
    const bySection = new Map<string, string[]>();
    for (const f of fixes) {
      const arr = bySection.get(f.sectionId) ?? [];
      arr.push(f.id);
      bySection.set(f.sectionId, arr);
    }
    for (const [sectionId, ids] of bySection) {
      await tx
        .update(estimateLineItems)
        .set({ sectionId })
        .where(
          and(
            eq(estimateLineItems.estimateId, estimateId),
            eq(estimateLineItems.companyId, ctx.companyId),
            inArray(estimateLineItems.id, ids),
          ),
        );
    }
  }

  return sections;
};

// Три жёстких раздела, которые создаются при каждой новой смете. Идентичный
// набор для simple и pro режимов — mode только меняет UI, не структуру.
const buildDefaultSections = (
  companyId: string,
  estimateId: string,
  margins: { equipment: string | null; installation: string | null; other: string | null },
): repo.UpsertSectionInput[] => [
  {
    id: crypto.randomUUID(),
    companyId,
    estimateId,
    parentId: null,
    title: 'Оборудование',
    sortOrder: 0,
    defaultMarginPercent: margins.equipment,
    defaultDiscountPercent: null,
    meta: {},
  },
  {
    id: crypto.randomUUID(),
    companyId,
    estimateId,
    parentId: null,
    title: 'Монтаж',
    sortOrder: 1,
    defaultMarginPercent: margins.installation,
    defaultDiscountPercent: null,
    meta: {},
  },
  {
    id: crypto.randomUUID(),
    companyId,
    estimateId,
    parentId: null,
    title: 'Другое',
    sortOrder: 2,
    defaultMarginPercent: margins.other,
    defaultDiscountPercent: null,
    meta: {},
  },
];

// ── Get tree ───────────────────────────────────────────────────

export const getTree = async (
  tx: Db,
  ctx: { companyId: string },
  id: string,
): Promise<EstimateTreeResponse> => {
  const est = await repo.findEstimateById(tx, { id, companyId: ctx.companyId });
  if (!est) throw new NotFoundError('Смета не найдена');

  let sections = await repo.listSectionsByEstimate(tx, {
    estimateId: est.id,
    companyId: ctx.companyId,
  });

  // Self-healing для смет, созданных до появления автосоздания разделов
  // или пострадавших от ранних версий этого healing'а (создавших дубликаты).
  sections = await ensureCanonicalSections(tx, ctx, est.id, sections);

  const items = await repo.listLineItemsByEstimate(tx, {
    estimateId: est.id,
    companyId: ctx.companyId,
  });
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
      defaultMarginPercent: s.defaultMarginPercent ?? null,
      defaultDiscountPercent: s.defaultDiscountPercent ?? null,
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
      cost: li.cost ?? '0',
      discountPercent: li.discountPercent ?? '0',
      vatRateOverride: li.vatRateOverride ?? null,
      customMarginPercent: li.customMarginPercent ?? null,
      customDiscountPercent: li.customDiscountPercent ?? null,
      priceBasis: (li.priceBasis ?? 'rrp') as PriceBasis,
      expenseCategory: li.expenseCategory ?? null,
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
    if (h.taxRegime !== undefined) patch.taxRegime = h.taxRegime as TaxRegime;
    if (h.taxRate !== undefined) patch.taxRate = h.taxRate ?? null;
    if (h.taxBaseKind !== undefined)
      patch.taxBaseKind = (h.taxBaseKind ?? null) as TaxBaseKind | null;
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

  // Инкрементируем version — любая мутация дерева бампает шапку.
  await bumpOrThrow(tx, ctx, est.id, null);

  // Возвращаем актуальное дерево из БД (не из памяти) — чтобы фронт получил
  // финальные createdAt/updatedAt/companyId + рассчитанные суммы + свежий version.
  const refreshed = await repo.findEstimateById(tx, { id: est.id, companyId: ctx.companyId });
  if (!refreshed) throw new NotFoundError('Смета не найдена');
  const [freshSections, freshItems] = await Promise.all([
    repo.listSectionsByEstimate(tx, { estimateId: est.id, companyId: ctx.companyId }),
    repo.listLineItemsByEstimate(tx, { estimateId: est.id, companyId: ctx.companyId }),
  ]);
  // updatedEstimate использовали чтобы понять что менялось; но актуальные
  // updated_at/version в refreshed после bumpVersion.
  void updatedEstimate;
  return assembleTree(tx, ctx, refreshed, freshSections, freshItems);
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
  if (body.mode !== undefined) patch.mode = body.mode as EstimateMode;
  if (body.taxRegime !== undefined) patch.taxRegime = body.taxRegime as TaxRegime;
  if (body.taxRate !== undefined) patch.taxRate = body.taxRate ?? null;
  if (body.taxBaseKind !== undefined)
    patch.taxBaseKind = (body.taxBaseKind ?? null) as TaxBaseKind | null;
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

  // При переключении режима массово пересчитываем цены строк, чтобы юзер
  // видел смету в системе координат нового режима. Обрабатываем только
  // строки из каталога (rrp / cost); manual-строки живут своей ценой.
  if (patch.mode !== undefined && patch.mode !== est.mode) {
    await applyModeRepricing(tx, ctx, est.id, patch.mode);
  }

  await bumpOrThrow(tx, ctx, est.id, null);

  const refreshed = await repo.findEstimateById(tx, { id: est.id, companyId: ctx.companyId });
  if (!refreshed) throw new NotFoundError('Смета не найдена');
  const [sections, items] = await Promise.all([
    repo.listSectionsByEstimate(tx, { estimateId: refreshed.id, companyId: ctx.companyId }),
    repo.listLineItemsByEstimate(tx, { estimateId: refreshed.id, companyId: ctx.companyId }),
  ]);
  void updated;
  return assembleTree(tx, ctx, refreshed, sections, items);
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

// ── Duplicate ──────────────────────────────────────────────────
// Полная копия сметы: наследует состав (разделы + строки со snapshot'ами)
// и настройки шапки (валюта, НДС, скидки, режим, налог, notes, meta).
// Сбрасывает: number (пусть юзер задаст сам), status → 'draft', version → 1,
// createdAt/updatedAt → now, createdBy → текущий membership.
// Атомарно в одной транзакции — либо целиком, либо ничего.

export const duplicate = async (
  tx: Db,
  ctx: { companyId: string; membershipId: string; userId: string; sessionId: string },
  sourceId: string,
): Promise<EstimateTreeResponse> => {
  const src = await repo.findEstimateById(tx, { id: sourceId, companyId: ctx.companyId });
  if (!src) throw new NotFoundError('Смета не найдена');

  const newTitle = `${src.title} (копия)`;
  const newEst = await repo.insertEstimate(tx, {
    companyId: ctx.companyId,
    projectId: src.projectId,
    number: null,
    title: newTitle,
    currency: src.currency,
    vatMode: src.vatMode,
    vatRate: src.vatRate,
    discountPercent: src.discountPercent,
    discountAmount: src.discountAmount,
    mode: src.mode,
    notes: src.notes,
    meta: asMeta(src.meta),
    createdBy: ctx.membershipId,
  });

  // Смета только что создана — insertEstimate уже засеял три канонических
  // раздела (Оборудование/Монтаж/Другое). Смапим их id со срочными по title,
  // строки перепривяжем на новые id разделов, чтобы дерево осталось цельным.
  const [srcSections, srcItems, newSections] = await Promise.all([
    repo.listSectionsByEstimate(tx, { estimateId: src.id, companyId: ctx.companyId }),
    repo.listLineItemsByEstimate(tx, { estimateId: src.id, companyId: ctx.companyId }),
    repo.listSectionsByEstimate(tx, { estimateId: newEst.id, companyId: ctx.companyId }),
  ]);

  // Сохраняем настройки разделов (default_margin_percent, default_discount_percent,
  // sortOrder, meta) — копируем в новые по мэтчу title.
  const newByTitle = new Map(newSections.map((s) => [s.title, s]));
  const sectionIdMap = new Map<string, string>();
  for (const s of srcSections) {
    const matched = newByTitle.get(s.title);
    if (!matched) continue;
    sectionIdMap.set(s.id, matched.id);
    await repo.updateSection(tx, {
      id: matched.id,
      estimateId: newEst.id,
      companyId: ctx.companyId,
      patch: {
        defaultMarginPercent: s.defaultMarginPercent ?? null,
        defaultDiscountPercent: s.defaultDiscountPercent ?? null,
        sortOrder: s.sortOrder,
        meta: asMeta(s.meta),
      },
    });
  }

  // Строки: новый id (генерирует БД), sectionId → новый через sectionIdMap,
  // остальное — как в оригинале. productId сохраняем — это позволит
  // find-existing-line работать на копии так же, как на оригинале.
  if (srcItems.length > 0) {
    await repo.upsertLineItems(
      tx,
      srcItems.map((li) => ({
        id: crypto.randomUUID(),
        companyId: ctx.companyId,
        estimateId: newEst.id,
        sectionId: li.sectionId ? (sectionIdMap.get(li.sectionId) ?? null) : null,
        productId: li.productId,
        catalogSnapshot: li.catalogSnapshot as Record<string, unknown> | null,
        kind: li.kind,
        name: li.name,
        unit: li.unit,
        quantity: li.quantity,
        price: li.price,
        cost: li.cost,
        discountPercent: li.discountPercent,
        vatRateOverride: li.vatRateOverride,
        customMarginPercent: li.customMarginPercent,
        customDiscountPercent: li.customDiscountPercent,
        priceBasis: li.priceBasis,
        expenseCategory: li.expenseCategory,
        sortOrder: li.sortOrder,
        meta: asMeta(li.meta),
      })),
    );
  }

  await writeAudit(tx, {
    companyId: ctx.companyId,
    userId: ctx.userId,
    sessionId: ctx.sessionId,
    action: 'estimate.duplicate',
    entityType: 'estimate',
    entityId: newEst.id,
    meta: { sourceId },
  });

  return getTree(tx, ctx, newEst.id);
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

  await bumpOrThrow(tx, ctx, id, null);
  const refreshed = await repo.findEstimateById(tx, { id, companyId: ctx.companyId });
  if (!refreshed) throw new NotFoundError('Смета не найдена');

  const [freshSections, freshItems] = await Promise.all([
    repo.listSectionsByEstimate(tx, { estimateId: refreshed.id, companyId: ctx.companyId }),
    repo.listLineItemsByEstimate(tx, { estimateId: refreshed.id, companyId: ctx.companyId }),
  ]);
  void row;
  return assembleTree(tx, ctx, refreshed, freshSections, freshItems);
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
        defaultMarginPercent: s.defaultMarginPercent,
        defaultDiscountPercent: s.defaultDiscountPercent,
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
        cost: li.cost,
        discountPercent: li.discountPercent,
        vatRateOverride: li.vatRateOverride,
        customMarginPercent: li.customMarginPercent,
        customDiscountPercent: li.customDiscountPercent,
        priceBasis: li.priceBasis,
        expenseCategory: (li.expenseCategory ?? null) as EstimateLineItemDto['expenseCategory'],
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

// ── Single-item CRUD line_items ────────────────────────────────
// Атомарные операции над одной строкой сметы. Используются вместо PUT /tree
// для точечных изменений. Все три вызывают bumpVersion — если клиент прислал
// If-Match и версия не совпала, вернётся 409 ConflictError.
//
// Дефолт kind — из shared/contract.tree.default('work'); в create-эндпоинте
// клиент может передать другое (например 'material' для оборудования).

const bumpOrThrow = async (
  tx: Db,
  ctx: { companyId: string },
  estimateId: string,
  expectedVersion: number | null,
): Promise<void> => {
  const bumped = await repo.bumpEstimateVersion(tx, {
    id: estimateId,
    companyId: ctx.companyId,
    expectedVersion,
  });
  if (!bumped.ok) {
    if (bumped.current === null) {
      throw new NotFoundError('Смета не найдена');
    }
    throwVersionConflict(bumped.current);
  }
};

export const createLineItem = async (
  tx: Db,
  ctx: { companyId: string },
  estimateId: string,
  expectedVersion: number | null,
  body: CreateLineItemBody,
): Promise<EstimateTreeResponse> => {
  await bumpOrThrow(tx, ctx, estimateId, expectedVersion);

  // sortOrder не задан → идём в конец списка.
  const sortOrder =
    body.sortOrder !== undefined
      ? body.sortOrder
      : (await repo.maxLineItemSortOrder(tx, {
          estimateId,
          companyId: ctx.companyId,
        })) + 1;

  // Валидируем sectionId (если задан) — должен существовать в этой смете,
  // а строка из каталога — лежать в каноническом разделе по kind. Иначе UI
  // покажет её в чужом табе и юзер решит, что позиции пропали.
  if (body.sectionId != null) {
    const sections = await repo.listSectionsByEstimate(tx, {
      estimateId,
      companyId: ctx.companyId,
    });
    if (!sections.some((s) => s.id === body.sectionId)) {
      throw new ValidationError('sectionId не найден в этой смете');
    }
    assertLineFitsCanonicalSection({
      sections,
      sectionId: body.sectionId,
      kind: (body.kind ?? 'material') as LineItemKind,
      hasProductId: body.productId != null,
    });
  }

  await repo.insertLineItem(tx, {
    companyId: ctx.companyId,
    estimateId,
    sectionId: body.sectionId ?? null,
    productId: body.productId ?? null,
    catalogSnapshot: body.catalogSnapshot ?? null,
    kind: (body.kind ?? 'material') as LineItemKind,
    name: body.name.trim(),
    unit: body.unit.trim(),
    quantity: body.quantity,
    price: body.price,
    cost: body.cost ?? '0',
    discountPercent: body.discountPercent ?? '0',
    vatRateOverride: body.vatRateOverride ?? null,
    customMarginPercent: body.customMarginPercent ?? null,
    customDiscountPercent: body.customDiscountPercent ?? null,
    priceBasis: (body.priceBasis ?? 'rrp') as PriceBasis,
    expenseCategory: body.expenseCategory ?? null,
    sortOrder,
    meta: body.meta ?? {},
  });

  // Автопривязка: если это товар (material) и у него есть categoryId в
  // snapshot — ищем work_items с triggerCategoryIds @> [categoryId] и
  // автодобавляем (или инкрементируем qty на существующей auto-строке).
  const productCategoryId = readSnapshotProductCategoryId(body.catalogSnapshot);
  if ((body.kind ?? 'material') === 'material' && productCategoryId) {
    await autoLinkWorkItems(tx, ctx, estimateId, productCategoryId, body.quantity);
  }

  return getTree(tx, ctx, estimateId);
};

export const updateLineItem = async (
  tx: Db,
  ctx: { companyId: string },
  estimateId: string,
  lineId: string,
  expectedVersion: number | null,
  body: UpdateLineItemBody,
): Promise<EstimateTreeResponse> => {
  const existing = await repo.findLineItemById(tx, {
    id: lineId,
    estimateId,
    companyId: ctx.companyId,
  });
  if (!existing) throw new NotFoundError('Позиция сметы не найдена');

  await bumpOrThrow(tx, ctx, estimateId, expectedVersion);

  const patch: repo.UpdateLineItemPatch = {};
  if (body.sectionId !== undefined) patch.sectionId = body.sectionId ?? null;
  if (body.productId !== undefined) patch.productId = body.productId ?? null;
  if (body.catalogSnapshot !== undefined) patch.catalogSnapshot = body.catalogSnapshot ?? null;
  if (body.kind !== undefined) patch.kind = body.kind as LineItemKind;
  if (body.name !== undefined) patch.name = body.name.trim();
  if (body.unit !== undefined) patch.unit = body.unit.trim();
  if (body.quantity !== undefined) patch.quantity = body.quantity;
  if (body.price !== undefined) patch.price = body.price;
  if (body.cost !== undefined) patch.cost = body.cost;
  if (body.discountPercent !== undefined) patch.discountPercent = body.discountPercent;
  if (body.vatRateOverride !== undefined) patch.vatRateOverride = body.vatRateOverride ?? null;
  if (body.customMarginPercent !== undefined)
    patch.customMarginPercent = body.customMarginPercent ?? null;
  if (body.customDiscountPercent !== undefined)
    patch.customDiscountPercent = body.customDiscountPercent ?? null;
  if (body.priceBasis !== undefined) patch.priceBasis = body.priceBasis as PriceBasis;
  if (body.expenseCategory !== undefined) patch.expenseCategory = body.expenseCategory ?? null;
  if (body.sortOrder !== undefined) patch.sortOrder = body.sortOrder;
  if (body.meta !== undefined) patch.meta = body.meta;

  // Проверка sectionId на существование + канонический раздел по kind
  // (тот же инвариант, что в addLineItem).
  if (patch.sectionId != null) {
    const sections = await repo.listSectionsByEstimate(tx, {
      estimateId,
      companyId: ctx.companyId,
    });
    if (!sections.some((s) => s.id === patch.sectionId)) {
      throw new ValidationError('sectionId не найден в этой смете');
    }
    const effectiveKind = (patch.kind ?? existing.kind) as LineItemKind;
    const effectiveProductId = patch.productId !== undefined ? patch.productId : existing.productId;
    assertLineFitsCanonicalSection({
      sections,
      sectionId: patch.sectionId,
      kind: effectiveKind,
      hasProductId: effectiveProductId != null,
    });
  }

  const updated = await repo.updateLineItem(tx, {
    id: lineId,
    estimateId,
    companyId: ctx.companyId,
    patch,
  });
  if (!updated) throw new NotFoundError('Позиция сметы не найдена');

  // Синхронизация авто-работ при изменении quantity товара. Работает только
  // если строка — товар из каталога (material + productId + productCategoryId
  // в snapshot). Дельта > 0 → autoLink (умеет инкрементировать существующие
  // авто-работы), дельта < 0 → unlink.
  const productCategoryId = readSnapshotProductCategoryId(
    existing.catalogSnapshot as Record<string, unknown> | null,
  );
  const isCatalogMaterial = existing.kind === 'material' && existing.productId != null;
  if (isCatalogMaterial && productCategoryId && patch.quantity !== undefined) {
    const oldQty = Number(existing.quantity) || 0;
    const newQty = Number(patch.quantity) || 0;
    const delta = newQty - oldQty;
    if (delta > 0) {
      await autoLinkWorkItems(tx, ctx, estimateId, productCategoryId, delta.toString());
    } else if (delta < 0) {
      await unlinkAutoWorkItems(tx, ctx, estimateId, productCategoryId, (-delta).toString());
    }
  }

  return getTree(tx, ctx, estimateId);
};

export const deleteLineItem = async (
  tx: Db,
  ctx: { companyId: string },
  estimateId: string,
  lineId: string,
  expectedVersion: number | null,
): Promise<EstimateTreeResponse> => {
  // Читаем строку заранее — нужны kind/product/qty/snapshot чтобы после
  // удаления откатить авто-привязанные работы (симметрия autoLinkWorkItems).
  const existing = await repo.findLineItemById(tx, {
    id: lineId,
    estimateId,
    companyId: ctx.companyId,
  });
  if (!existing) throw new NotFoundError('Позиция сметы не найдена');

  await bumpOrThrow(tx, ctx, estimateId, expectedVersion);

  const ok = await repo.deleteLineItem(tx, {
    id: lineId,
    estimateId,
    companyId: ctx.companyId,
  });
  if (!ok) throw new NotFoundError('Позиция сметы не найдена');

  const productCategoryId = readSnapshotProductCategoryId(
    existing.catalogSnapshot as Record<string, unknown> | null,
  );
  if (existing.kind === 'material' && existing.productId != null && productCategoryId) {
    await unlinkAutoWorkItems(tx, ctx, estimateId, productCategoryId, existing.quantity);
  }

  return getTree(tx, ctx, estimateId);
};

// ── Single-section CRUD ────────────────────────────────────────

export const createSection = async (
  tx: Db,
  ctx: { companyId: string },
  estimateId: string,
  expectedVersion: number | null,
  body: CreateSectionBody,
): Promise<EstimateTreeResponse> => {
  await bumpOrThrow(tx, ctx, estimateId, expectedVersion);

  const sortOrder =
    body.sortOrder !== undefined
      ? body.sortOrder
      : (await repo.maxSectionSortOrder(tx, {
          estimateId,
          companyId: ctx.companyId,
        })) + 1;

  // Валидируем parentId (если задан) — родительский раздел должен быть в
  // этой же смете и не создавать цикл (проверка «не сам себе родитель»
  // не нужна при create — id нового ещё нет).
  if (body.parentId != null) {
    const sections = await repo.listSectionsByEstimate(tx, {
      estimateId,
      companyId: ctx.companyId,
    });
    if (!sections.some((s) => s.id === body.parentId)) {
      throw new ValidationError('parentId не найден в этой смете');
    }
  }

  await repo.insertSection(tx, {
    companyId: ctx.companyId,
    estimateId,
    parentId: body.parentId ?? null,
    title: body.title.trim(),
    sortOrder,
    defaultMarginPercent: body.defaultMarginPercent ?? null,
    defaultDiscountPercent: body.defaultDiscountPercent ?? null,
    meta: body.meta ?? {},
  });

  return getTree(tx, ctx, estimateId);
};

export const updateSection = async (
  tx: Db,
  ctx: { companyId: string },
  estimateId: string,
  sectionId: string,
  expectedVersion: number | null,
  body: UpdateSectionBody,
): Promise<EstimateTreeResponse> => {
  const existing = await repo.findSectionById(tx, {
    id: sectionId,
    estimateId,
    companyId: ctx.companyId,
  });
  if (!existing) throw new NotFoundError('Раздел сметы не найден');

  await bumpOrThrow(tx, ctx, estimateId, expectedVersion);

  const patch: repo.UpdateSectionPatch = {};
  if (body.parentId !== undefined) patch.parentId = body.parentId ?? null;
  if (body.title !== undefined) patch.title = body.title.trim();
  if (body.sortOrder !== undefined) patch.sortOrder = body.sortOrder;
  if (body.defaultMarginPercent !== undefined)
    patch.defaultMarginPercent = body.defaultMarginPercent ?? null;
  if (body.defaultDiscountPercent !== undefined)
    patch.defaultDiscountPercent = body.defaultDiscountPercent ?? null;
  if (body.meta !== undefined) patch.meta = body.meta;

  // Валидация parentId, если меняется.
  if (patch.parentId != null) {
    if (patch.parentId === sectionId) {
      throw new ValidationError('Раздел не может быть родителем самому себе');
    }
    const sections = await repo.listSectionsByEstimate(tx, {
      estimateId,
      companyId: ctx.companyId,
    });
    if (!sections.some((s) => s.id === patch.parentId)) {
      throw new ValidationError('parentId не найден в этой смете');
    }
  }

  const updated = await repo.updateSection(tx, {
    id: sectionId,
    estimateId,
    companyId: ctx.companyId,
    patch,
  });
  if (!updated) throw new NotFoundError('Раздел сметы не найден');

  // Если наценка раздела реально изменилась — пересчитываем price всех строк
  // раздела, у которых нет собственного override (custom_margin_percent IS NULL).
  // Строки с override сохраняют свою цену. buy_price берём из catalog_snapshot.
  const marginChanged =
    patch.defaultMarginPercent !== undefined &&
    (patch.defaultMarginPercent ?? null) !== (existing.defaultMarginPercent ?? null);
  if (marginChanged) {
    await recomputeSectionLinePrices(tx, ctx, estimateId, sectionId, patch.defaultMarginPercent);
  }

  // Скидка раздела — «главный» рычаг simple-режима: любой commit её значения
  // (в т.ч. тем же числом) принудительно применяется ко ВСЕМ строкам раздела,
  // а строчный custom_discount_percent сбрасывается. Так юзер уверенно нажимает
  // Enter на инпуте раздела и знает: сейчас всё выравнивается.
  if (patch.defaultDiscountPercent !== undefined) {
    await recomputeSectionLineDiscountPrices(
      tx,
      ctx,
      estimateId,
      sectionId,
      patch.defaultDiscountPercent,
    );
  }

  return getTree(tx, ctx, estimateId);
};

// Пересчитывает price всех строк раздела, у которых нет своего margin override.
// price = buyPrice × (1 + margin/100), buyPrice берётся из catalog_snapshot.
// Если snapshot пуст или buyPrice не валиден — оставляем price как есть
// (не рушим сметы с manual-строками без каталога).
const recomputeSectionLinePrices = async (
  tx: Db,
  ctx: { companyId: string },
  estimateId: string,
  sectionId: string,
  newMargin: string | null | undefined,
): Promise<void> => {
  const marginNum = Number(newMargin);
  const multiplier = Number.isFinite(marginNum) && marginNum > 0 ? 1 + marginNum / 100 : 1;

  const lines = await tx
    .select()
    .from(estimateLineItems)
    .where(
      and(
        eq(estimateLineItems.estimateId, estimateId),
        eq(estimateLineItems.companyId, ctx.companyId),
        eq(estimateLineItems.sectionId, sectionId),
        isNull(estimateLineItems.customMarginPercent),
      ),
    );

  for (const li of lines) {
    const snapshot = li.catalogSnapshot as Record<string, unknown> | null;
    const buyRaw = snapshot?.['buyPrice'];
    if (typeof buyRaw !== 'string') continue;
    const buy = Number(buyRaw);
    if (!Number.isFinite(buy) || buy < 0) continue;
    const newPrice = (buy * multiplier).toFixed(4);
    await tx
      .update(estimateLineItems)
      .set({ price: newPrice })
      .where(and(eq(estimateLineItems.id, li.id), eq(estimateLineItems.companyId, ctx.companyId)));
  }
};

// Аналог recomputeSectionLinePrices для скидки раздела (simple-режим).
// «Форс-применение»: берём ВСЕ строки раздела с price_basis='rrp', обнуляем
// их custom_discount_percent (override) и ставим price = sellPrice × (1-d/100),
// не ниже buyPrice. По задумке кнопки «скидка раздела» юзер получает
// одинаковое поведение и при первом задании, и при повторном нажатии Enter.
const recomputeSectionLineDiscountPrices = async (
  tx: Db,
  ctx: { companyId: string },
  estimateId: string,
  sectionId: string,
  newDiscount: string | null | undefined,
): Promise<void> => {
  const discountNum = Number(newDiscount);
  const discountEff =
    Number.isFinite(discountNum) && discountNum > 0 ? Math.min(discountNum, 100) : 0;
  const multiplier = 1 - discountEff / 100;

  const lines = await tx
    .select()
    .from(estimateLineItems)
    .where(
      and(
        eq(estimateLineItems.estimateId, estimateId),
        eq(estimateLineItems.companyId, ctx.companyId),
        eq(estimateLineItems.sectionId, sectionId),
        eq(estimateLineItems.priceBasis, 'rrp'),
      ),
    );

  for (const li of lines) {
    const snapshot = li.catalogSnapshot as Record<string, unknown> | null;
    const sellRaw = snapshot?.['sellPrice'];
    if (typeof sellRaw !== 'string') continue;
    const sell = Number(sellRaw);
    if (!Number.isFinite(sell) || sell < 0) continue;
    let newPrice = sell * multiplier;
    const buyRaw = snapshot?.['buyPrice'];
    if (typeof buyRaw === 'string') {
      const buy = Number(buyRaw);
      if (Number.isFinite(buy) && buy >= 0 && newPrice < buy) newPrice = buy;
    }
    await tx
      .update(estimateLineItems)
      .set({
        price: newPrice.toFixed(4),
        discountPercent: discountEff.toFixed(2),
        customDiscountPercent: null,
      })
      .where(and(eq(estimateLineItems.id, li.id), eq(estimateLineItems.companyId, ctx.companyId)));
  }
};

// Пересчёт цен всей сметы при смене режима. simple → pro: price_basis
// становится 'cost', price = buyPrice × (1+effMargin/100). pro → simple:
// price_basis становится 'rrp', price = sellPrice × (1-effDiscount/100),
// но не ниже buyPrice. «Эффективное» значение — custom* строки если задано,
// иначе default* раздела, иначе 0. Строки basis='manual' и без catalog_snapshot
// не трогаем — их цена введена руками. Overrides не стираем: если юзер
// вернётся в прежний режим, свои проценты снова заработают.
const applyModeRepricing = async (
  tx: Db,
  ctx: { companyId: string },
  estimateId: string,
  nextMode: EstimateMode,
): Promise<void> => {
  const [sections, lines] = await Promise.all([
    repo.listSectionsByEstimate(tx, { estimateId, companyId: ctx.companyId }),
    repo.listLineItemsByEstimate(tx, { estimateId, companyId: ctx.companyId }),
  ]);
  const sectionById = new Map(sections.map((s) => [s.id, s]));

  const nextBasis: PriceBasis = nextMode === 'pro' ? 'cost' : 'rrp';

  for (const li of lines) {
    if (li.priceBasis === 'manual') continue;
    const snapshot = li.catalogSnapshot as Record<string, unknown> | null;
    const sellRaw = snapshot?.['sellPrice'];
    const buyRaw = snapshot?.['buyPrice'];
    const sell = typeof sellRaw === 'string' ? Number(sellRaw) : NaN;
    const buy = typeof buyRaw === 'string' ? Number(buyRaw) : NaN;
    const section = li.sectionId ? sectionById.get(li.sectionId) : null;

    let newPrice: number | null = null;
    let discountPercentPatch: string | undefined;

    if (nextMode === 'pro') {
      if (!Number.isFinite(buy) || buy < 0) continue;
      const marginRaw = li.customMarginPercent ?? section?.defaultMarginPercent ?? '0';
      const marginNum = Number(marginRaw);
      const margin = Number.isFinite(marginNum) && marginNum > 0 ? marginNum : 0;
      newPrice = buy * (1 + margin / 100);
    } else {
      if (!Number.isFinite(sell) || sell < 0) continue;
      const discountRaw = li.customDiscountPercent ?? section?.defaultDiscountPercent ?? '0';
      const discountNum = Number(discountRaw);
      const discount =
        Number.isFinite(discountNum) && discountNum > 0 ? Math.min(discountNum, 100) : 0;
      newPrice = sell * (1 - discount / 100);
      if (Number.isFinite(buy) && buy >= 0 && newPrice < buy) newPrice = buy;
      discountPercentPatch = discount.toFixed(2);
    }

    const set: {
      price: string;
      priceBasis: PriceBasis;
      discountPercent?: string;
    } = { price: newPrice.toFixed(4), priceBasis: nextBasis };
    if (discountPercentPatch !== undefined) set.discountPercent = discountPercentPatch;

    await tx
      .update(estimateLineItems)
      .set(set)
      .where(and(eq(estimateLineItems.id, li.id), eq(estimateLineItems.companyId, ctx.companyId)));
  }
};

// Читает productCategoryId из snapshot строки. Использует то же поле, что
// пишет ProductCard на фронте (snapshot.categoryId). Не путать с sectionId
// на строке сметы — это разные вещи.
const readSnapshotProductCategoryId = (
  snapshot: Record<string, unknown> | null | undefined,
): string | null => {
  if (!snapshot) return null;
  const raw = snapshot['categoryId'];
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
};

// Автопривязка работ к добавленному товару. Логика:
//   1. Найти все work_items с trigger_category_ids @> [productCategoryId].
//   2. Найти раздел «Монтаж» в смете (его гарантированно есть — создаётся
//      при создании сметы).
//   3. Для каждой work-триггера: если строка с таким workItemId уже есть
//      в смете (по snapshot.workItemId и sectionId='Монтаж') — увеличиваем
//      qty на productQty (одна камера = одна работа монтажа). Иначе —
//      создаём новую строку с qty=productQty.
//
// Помечаем автостроки meta.autoLinked=true — фронт сможет показать пометку
// «добавлено автоматически» и юзер поймёт связь.
const autoLinkWorkItems = async (
  tx: Db,
  ctx: { companyId: string },
  estimateId: string,
  productCategoryId: string,
  productQty: string,
): Promise<void> => {
  const workItems = await worksRepo.listItemsTriggeredByCategory(tx, {
    companyId: ctx.companyId,
    productCategoryId,
  });
  if (workItems.length === 0) return;

  const sections = await repo.listSectionsByEstimate(tx, {
    estimateId,
    companyId: ctx.companyId,
  });
  const installSection = sections.find((s) => s.title === 'Монтаж');
  if (!installSection) return;

  const existingItems = await repo.listLineItemsByEstimate(tx, {
    estimateId,
    companyId: ctx.companyId,
  });
  const byWorkId = new Map<string, EstimateLineItem>();
  for (const li of existingItems) {
    const snap = li.catalogSnapshot as Record<string, unknown> | null;
    const wid = snap?.['workItemId'];
    if (typeof wid === 'string') byWorkId.set(wid, li);
  }

  let nextSortOrder =
    (await repo.maxLineItemSortOrder(tx, {
      estimateId,
      companyId: ctx.companyId,
    })) + 1;

  const productQtyNum = Number(productQty);
  const addQty = Number.isFinite(productQtyNum) && productQtyNum > 0 ? productQtyNum : 1;

  // Единицы измерения — одним запросом на все work_items, потом резолвим.
  const units = await catalogRepo.listUnits(tx);
  const unitShortById = new Map(units.map((u) => [u.id, u.shortName]));

  for (const w of workItems) {
    const existing = byWorkId.get(w.id);
    if (existing) {
      const currentQty = Number(existing.quantity) || 0;
      const newQty = currentQty + addQty;
      await tx
        .update(estimateLineItems)
        .set({ quantity: newQty.toString() })
        .where(
          and(
            eq(estimateLineItems.id, existing.id),
            eq(estimateLineItems.companyId, ctx.companyId),
          ),
        );
      continue;
    }

    // Новая строка. Snapshot симметричен тому, что делает WorkItemCard, +
    // meta.autoLinked, meta.triggeredByCategoryId — чтобы фронт мог
    // показать «связано с товаром категории Х».
    const unitShort = unitShortById.get(w.unitId) ?? 'шт.';
    await repo.insertLineItem(tx, {
      companyId: ctx.companyId,
      estimateId,
      sectionId: installSection.id,
      productId: null,
      catalogSnapshot: {
        workItemId: w.id,
        unitShortName: unitShort,
        categoryId: w.categoryId,
        price: w.price,
        cost: w.cost,
        addedAt: new Date().toISOString(),
      },
      kind: 'work' as LineItemKind,
      name: w.name,
      unit: unitShort,
      quantity: addQty.toString(),
      price: w.price ?? '0',
      cost: w.cost ?? '0',
      discountPercent: '0',
      vatRateOverride: null,
      customMarginPercent: null,
      customDiscountPercent: null,
      priceBasis: 'manual' as PriceBasis,
      expenseCategory: null,
      sortOrder: nextSortOrder,
      meta: { autoLinked: true, triggeredByCategoryId: productCategoryId },
    });
    nextSortOrder += 1;
  }
};

// Симметрия autoLinkWorkItems: юзер уменьшил qty товара / удалил его совсем
// → авто-работа этой категории тоже должна ужаться / удалиться.
// Трогаем только строки-работы с meta.autoLinked=true и совпадающим
// triggeredByCategoryId — руками вбитая работа с тем же именем остаётся.
const unlinkAutoWorkItems = async (
  tx: Db,
  ctx: { companyId: string },
  estimateId: string,
  productCategoryId: string,
  delta: string,
): Promise<void> => {
  const deltaNum = Number(delta);
  if (!Number.isFinite(deltaNum) || deltaNum <= 0) return;

  const workItems = await worksRepo.listItemsTriggeredByCategory(tx, {
    companyId: ctx.companyId,
    productCategoryId,
  });
  if (workItems.length === 0) return;
  const workIds = new Set(workItems.map((w) => w.id));

  const existingItems = await repo.listLineItemsByEstimate(tx, {
    estimateId,
    companyId: ctx.companyId,
  });
  const toDelete: string[] = [];
  for (const li of existingItems) {
    if (li.kind !== 'work') continue;
    const meta = li.meta as Record<string, unknown> | null;
    if (!meta || meta['autoLinked'] !== true) continue;
    // Раньше здесь была проверка meta.triggeredByCategoryId === productCategoryId,
    // но у work_item может быть массив триггеров (trigger_category_ids), а в
    // meta сохраняется только первая категория из которой работа впервые
    // прилетела. Итог: работа с триггерами [video, audio], инкрементированная
    // сначала video, потом audio — при удалении audio не находилась и qty
    // висел мёртвым грузом. workIds (listItemsTriggeredByCategory) уже фильтрует
    // work_items по актуальным триггерам категории, доп. проверка меты избыточна.
    const snap = li.catalogSnapshot as Record<string, unknown> | null;
    const wid = snap?.['workItemId'];
    if (typeof wid !== 'string' || !workIds.has(wid)) continue;

    const currentQty = Number(li.quantity) || 0;
    const newQty = currentQty - deltaNum;
    if (newQty <= 0) {
      toDelete.push(li.id);
      continue;
    }
    await tx
      .update(estimateLineItems)
      .set({ quantity: newQty.toString() })
      .where(and(eq(estimateLineItems.id, li.id), eq(estimateLineItems.companyId, ctx.companyId)));
  }
  if (toDelete.length > 0) {
    await repo.deleteLineItems(tx, {
      estimateId,
      companyId: ctx.companyId,
      ids: toDelete,
    });
  }
};

export const deleteSection = async (
  tx: Db,
  ctx: { companyId: string },
  estimateId: string,
  sectionId: string,
  expectedVersion: number | null,
): Promise<EstimateTreeResponse> => {
  // Строки, ссылающиеся на удаляемый раздел, автоматом получат sectionId=null
  // через FK ON DELETE SET NULL (см. schema/estimates.ts).
  const ok = await repo.deleteSection(tx, {
    id: sectionId,
    estimateId,
    companyId: ctx.companyId,
  });
  if (!ok) throw new NotFoundError('Раздел сметы не найден');

  await bumpOrThrow(tx, ctx, estimateId, expectedVersion);
  return getTree(tx, ctx, estimateId);
};

// exports для тестов и потенциальных внутренних сервисов
export { assembleTree };

// Не даёт TS/ESLint жаловаться на неиспользованные типы в некоторых версиях.
export type { EstimateStatus };
