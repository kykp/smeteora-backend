import { type Db } from '../../db/client.js';
import { setCompanyContext } from '../../db/rls.js';
import { type WorkCategory, type WorkItem } from '../../db/schema/index.js';
import { NotFoundError, ValidationError } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import * as catalogRepo from '../catalog/repo.js';
import * as repo from './repo.js';
import {
  type CreateWorkCategoryBody,
  type CreateWorkItemBody,
  type ListWorkCategoriesResponse,
  type ListWorkItemsQuery,
  type ListWorkItemsResponse,
  type UpdateWorkCategoryBody,
  type UpdateWorkItemBody,
  type WorkCategoryDto,
  type WorkItemDto,
} from './schema.js';

// ── Мапперы Drizzle → DTO ────────────────────────────────────────

const toCategoryDto = (row: WorkCategory): WorkCategoryDto => ({
  id: row.id,
  companyId: row.companyId,
  source: row.source,
  code: row.code,
  name: row.name,
  sortOrder: row.sortOrder,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

const toItemDto = (row: WorkItem, usageCount = 0): WorkItemDto => ({
  id: row.id,
  companyId: row.companyId,
  source: row.source,
  categoryId: row.categoryId,
  unitId: row.unitId,
  name: row.name,
  description: row.description,
  price: row.price,
  cost: row.cost,
  triggerCategoryIds: row.triggerCategoryIds,
  meta: row.meta as Record<string, unknown>,
  isActive: row.isActive,
  usageCount,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

const emptyToNull = (v: string | null | undefined): string | null => {
  if (v === undefined || v === null) return null;
  const trimmed = v.trim();
  return trimmed.length === 0 ? null : trimmed;
};

// ── Categories ────────────────────────────────────────────────────

export const listCategories = async (
  tx: Db,
  ctx: { companyId: string },
): Promise<ListWorkCategoriesResponse> => {
  const rows = await repo.listCategories(tx, ctx.companyId);
  return { items: rows.map(toCategoryDto) };
};

export const createCategory = async (
  tx: Db,
  ctx: { companyId: string },
  body: CreateWorkCategoryBody,
): Promise<WorkCategoryDto> => {
  const row = await repo.insertCategory(tx, {
    companyId: ctx.companyId,
    code: body.code,
    name: body.name,
    sortOrder: body.sortOrder ?? 0,
  });
  return toCategoryDto(row);
};

export const updateCategory = async (
  tx: Db,
  ctx: { companyId: string },
  id: string,
  body: UpdateWorkCategoryBody,
): Promise<WorkCategoryDto> => {
  const patch: {
    code?: string;
    name?: string;
    sortOrder?: number;
  } = {};
  if (body.code !== undefined) patch.code = body.code;
  if (body.name !== undefined) patch.name = body.name;
  if (body.sortOrder !== undefined) patch.sortOrder = body.sortOrder;

  const row = await repo.updateCategory(tx, { id, companyId: ctx.companyId, patch });
  if (!row) throw new NotFoundError('Категория работ не найдена');
  return toCategoryDto(row);
};

export const softDeleteCategory = async (
  tx: Db,
  ctx: { companyId: string; userId: string; sessionId: string },
  id: string,
): Promise<void> => {
  const ok = await repo.softDeleteCategory(tx, { id, companyId: ctx.companyId });
  if (!ok) throw new NotFoundError('Категория работ не найдена');
  await writeAudit(tx, {
    companyId: ctx.companyId,
    userId: ctx.userId,
    sessionId: ctx.sessionId,
    action: 'work_category.delete',
    entityType: 'work_category',
    entityId: id,
  });
};

// ── Items ─────────────────────────────────────────────────────────

export const listItems = async (
  tx: Db,
  ctx: { companyId: string },
  query: ListWorkItemsQuery,
): Promise<ListWorkItemsResponse> => {
  const { items, total } = await repo.listItems(tx, {
    companyId: ctx.companyId,
    categoryIds: query.categoryId,
    q: query.q,
    scope: query.scope,
    isActive: query.isActive,
    limit: query.limit,
    offset: query.offset,
    sortBy: query.sortBy,
  });
  return {
    items: items.map((item) => toItemDto(item, item.usageCount)),
    total,
    limit: query.limit,
    offset: query.offset,
  };
};

export const getItem = async (
  tx: Db,
  ctx: { companyId: string },
  id: string,
): Promise<WorkItemDto> => {
  const row = await repo.findItemById(tx, { id, companyId: ctx.companyId });
  if (!row) throw new NotFoundError('Работа не найдена');
  return toItemDto(row);
};

// Проверяет, что категория работ и единица измерения доступны компании.
// Категория — через work-scope. Единица — через общий каталог (справочник
// платформенный, доступен всем на чтение).
const validateCategoryAndUnit = async (
  tx: Db,
  companyId: string,
  categoryId: string,
  unitId: string,
): Promise<void> => {
  const [category, unit] = await Promise.all([
    repo.findCategoryById(tx, { id: categoryId, companyId }),
    catalogRepo.findUnitById(tx, unitId),
  ]);
  if (!category) throw new ValidationError('Категория работ не найдена');
  if (!unit) throw new ValidationError('Единица измерения не найдена');
};

export const createItem = async (
  tx: Db,
  ctx: { companyId: string },
  body: CreateWorkItemBody,
): Promise<WorkItemDto> => {
  await validateCategoryAndUnit(tx, ctx.companyId, body.categoryId, body.unitId);
  const row = await repo.insertItem(tx, {
    companyId: ctx.companyId,
    categoryId: body.categoryId,
    unitId: body.unitId,
    name: body.name.trim(),
    description: emptyToNull(body.description),
    price: body.price ?? null,
    // Себестоимость по дефолту 0 — «работа с известной ценой, но без учёта
    // себестоимости» валиднее чем «неопределённо». Аналитика/рентабельность
    // сразу работают на новых работах без ручных пробегов по всем строкам.
    cost: body.cost ?? '0',
    triggerCategoryIds: body.triggerCategoryIds ?? [],
    meta: body.meta ?? {},
    isActive: body.isActive ?? true,
  });
  return toItemDto(row);
};

export const updateItem = async (
  tx: Db,
  ctx: { companyId: string },
  id: string,
  body: UpdateWorkItemBody,
): Promise<WorkItemDto> => {
  if (body.categoryId !== undefined || body.unitId !== undefined) {
    const current = await repo.findItemById(tx, { id, companyId: ctx.companyId });
    if (!current) throw new NotFoundError('Работа не найдена');
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
    description?: string | null;
    price?: string | null;
    cost?: string | null;
    triggerCategoryIds?: string[];
    meta?: Record<string, unknown>;
    isActive?: boolean;
  } = {};
  if (body.categoryId !== undefined) patch.categoryId = body.categoryId;
  if (body.unitId !== undefined) patch.unitId = body.unitId;
  if (body.name !== undefined) patch.name = body.name.trim();
  if (body.description !== undefined) patch.description = emptyToNull(body.description);
  if (body.price !== undefined) patch.price = body.price;
  if (body.cost !== undefined) patch.cost = body.cost;
  if (body.triggerCategoryIds !== undefined) patch.triggerCategoryIds = body.triggerCategoryIds;
  if (body.meta !== undefined) patch.meta = body.meta;
  if (body.isActive !== undefined) patch.isActive = body.isActive;

  const row = await repo.updateItem(tx, { id, companyId: ctx.companyId, patch });
  if (!row) throw new NotFoundError('Работа не найдена');
  return toItemDto(row);
};

// Онбординговый пресет: 13 типовых работ низковольтника с плейсхолдер-ценами
// (null). Юзер после регистрации получает готовый черновик прайса — стирает
// лишнее, заполняет цифры. Резко снижает барьер входа: не нужно вводить
// с нуля.
//
// Тянет id платформенных категорий по code (cabling/install/commissioning/
// other из миграции 0024) и id базовых единиц (pcs/m — миграция 0009).
// Если чего-то из них не найдено (кто-то поломал справочники) — просто
// пропускаем эту строку, не роняем регистрацию юзера.

type PresetItem = {
  categoryCode: string;
  unitCode: string;
  name: string;
  // Стартовая цена — ориентир по рынку РФ. Себестоимость (cost) для новых
  // юзеров всегда 0: юзер сам знает свои трудозатраты. Показываем 0 в UI
  // чтобы аналитика/рентабельность сразу работали без «не задана».
  price: string;
  cost: string;
};

const DEFAULT_WORK_PRESET: PresetItem[] = [
  {
    categoryCode: 'install',
    unitCode: 'pcs',
    name: 'Монтаж IP-камеры внутренней',
    price: '2000',
    cost: '0',
  },
  {
    categoryCode: 'install',
    unitCode: 'pcs',
    name: 'Монтаж IP-камеры уличной',
    price: '3000',
    cost: '0',
  },
  {
    categoryCode: 'install',
    unitCode: 'pcs',
    name: 'Монтаж датчика движения',
    price: '1500',
    cost: '0',
  },
  {
    categoryCode: 'install',
    unitCode: 'pcs',
    name: 'Монтаж считывателя СКУД',
    price: '2500',
    cost: '0',
  },
  {
    categoryCode: 'install',
    unitCode: 'pcs',
    name: 'Монтаж коммутатора / регистратора',
    price: '3000',
    cost: '0',
  },
  {
    categoryCode: 'cabling',
    unitCode: 'm',
    name: 'Прокладка кабеля UTP открытым способом',
    price: '120',
    cost: '0',
  },
  {
    categoryCode: 'cabling',
    unitCode: 'm',
    name: 'Прокладка кабеля в кабель-канал',
    price: '180',
    cost: '0',
  },
  {
    categoryCode: 'cabling',
    unitCode: 'm',
    name: 'Штробление в кирпиче / гипсокартоне',
    price: '300',
    cost: '0',
  },
  { categoryCode: 'cabling', unitCode: 'm', name: 'Штробление в бетоне', price: '500', cost: '0' },
  {
    categoryCode: 'commissioning',
    unitCode: 'pcs',
    name: 'Пусконаладка системы видеонаблюдения',
    price: '5000',
    cost: '0',
  },
  {
    categoryCode: 'commissioning',
    unitCode: 'pcs',
    name: 'Настройка удалённого доступа',
    price: '2000',
    cost: '0',
  },
  { categoryCode: 'other', unitCode: 'pcs', name: 'Выезд специалиста', price: '1500', cost: '0' },
  {
    categoryCode: 'other',
    unitCode: 'pcs',
    name: 'Демонтаж существующего оборудования',
    price: '1000',
    cost: '0',
  },
];

export const seedDefaultWorkItems = async (tx: Db, companyId: string): Promise<void> => {
  // Онбординг зовётся из auth-flow через runWithoutCompanyContext, поэтому
  // SET LOCAL app.current_company_id тут ещё не установлен. Ставим сами —
  // RLS-политика work_items_modify требует совпадения с текущим контекстом.
  // Действует до конца этой транзакции; в auth-flow дальше идут только
  // без-RLS таблицы (users/memberships/sessions), так что не мешает.
  await setCompanyContext(tx, companyId);
  await applyPresetInternal(tx, companyId, { skipExistingNames: false });
};

// Идемпотентное применение пресета: не создаёт дубликаты работ с уже
// существующими именами у компании. Используется из ручки
// POST /work-items/apply-defaults — юзер жмёт «Применить пресет» и получает
// недостающие типовые работы, ничего не затирая.
export const applyDefaultsForCompany = async (
  tx: Db,
  companyId: string,
): Promise<{ addedCount: number }> => {
  return applyPresetInternal(tx, companyId, { skipExistingNames: true });
};

const applyPresetInternal = async (
  tx: Db,
  companyId: string,
  opts: { skipExistingNames: boolean },
): Promise<{ addedCount: number }> => {
  const platformCategories = await repo.listCategories(tx, companyId);
  const categoryByCode = new Map(
    platformCategories.filter((c) => c.companyId === null).map((c) => [c.code, c.id]),
  );

  const units = await catalogRepo.listUnits(tx);
  const unitByCode = new Map(units.map((u) => [u.code, u.id]));

  const existingNames = opts.skipExistingNames
    ? new Set(
        (
          await repo.listItems(tx, {
            companyId,
            scope: 'own',
            limit: 1000,
            offset: 0,
          })
        ).items.map((i) => i.name.trim().toLowerCase()),
      )
    : new Set<string>();

  let addedCount = 0;
  for (const preset of DEFAULT_WORK_PRESET) {
    if (existingNames.has(preset.name.trim().toLowerCase())) continue;
    const categoryId = categoryByCode.get(preset.categoryCode);
    const unitId = unitByCode.get(preset.unitCode);
    if (!categoryId || !unitId) continue;
    await repo.insertItem(tx, {
      companyId,
      categoryId,
      unitId,
      name: preset.name,
      description: null,
      price: preset.price,
      cost: preset.cost,
      triggerCategoryIds: [],
      meta: {},
      isActive: true,
    });
    addedCount += 1;
  }
  return { addedCount };
};

export const softDeleteItem = async (
  tx: Db,
  ctx: { companyId: string; userId: string; sessionId: string },
  id: string,
): Promise<void> => {
  const ok = await repo.softDeleteItem(tx, { id, companyId: ctx.companyId });
  if (!ok) throw new NotFoundError('Работа не найдена');
  await writeAudit(tx, {
    companyId: ctx.companyId,
    userId: ctx.userId,
    sessionId: ctx.sessionId,
    action: 'work_item.delete',
    entityType: 'work_item',
    entityId: id,
  });
};
