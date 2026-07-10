import { and, count, desc, eq, isNull, sql } from 'drizzle-orm';
import { type Db } from '../../db/client.js';
import { projects, type Project } from '../../db/schema/index.js';
import { type ProjectStatus } from '../../db/constants.js';

// Слой БД для projects. Каждый метод принимает tx (доменная транзакция с RLS-контекстом)
// первым аргументом. RLS уже отсекает чужие строки — но всё равно инжектим
// WHERE company_id как belt-and-suspenders: если tx вдруг откроется без контекста,
// запрос упадёт "явно" (пустой результат от WHERE), а не тихо через RLS.

type ListParams = {
  companyId: string;
  status?: ProjectStatus | undefined;
  limit: number;
  offset: number;
};

export const listByCompany = async (
  tx: Db,
  params: ListParams,
): Promise<{ items: Project[]; total: number }> => {
  const conditions = [
    eq(projects.companyId, params.companyId),
    isNull(projects.deletedAt),
    ...(params.status !== undefined ? [eq(projects.status, params.status)] : []),
  ];

  const items = await tx
    .select()
    .from(projects)
    .where(and(...conditions))
    .orderBy(desc(projects.createdAt))
    .limit(params.limit)
    .offset(params.offset);

  const [countRow] = await tx
    .select({ value: count() })
    .from(projects)
    .where(and(...conditions));

  return { items, total: countRow?.value ?? 0 };
};

export const findById = async (
  tx: Db,
  params: { id: string; companyId: string },
): Promise<Project | undefined> => {
  const rows = await tx
    .select()
    .from(projects)
    .where(
      and(
        eq(projects.id, params.id),
        eq(projects.companyId, params.companyId),
        isNull(projects.deletedAt),
      ),
    )
    .limit(1);
  return rows[0];
};

type InsertInput = {
  companyId: string;
  name: string;
  description: string | null;
  address: string | null;
  clientName: string | null;
  clientPhone: string | null;
  clientInn: string | null;
  clientAddress: string | null;
  status: ProjectStatus;
  startDate: string | null;
  endDate: string | null;
  siteObject: string | null;
  areaM2: number | null;
  camerasCount: number | null;
  equipmentBrand: string | null;
  budgetRub: number | null;
};

export const insert = async (tx: Db, params: InsertInput): Promise<Project> => {
  const [row] = await tx.insert(projects).values(params).returning();
  if (!row) throw new Error('projects insert вернул пусто');
  return row;
};

// undefined = не трогаем; null = очистить nullable-поле. Так же будет и в UpdateProjectBody.
type PatchInput = {
  name?: string;
  description?: string | null;
  address?: string | null;
  clientName?: string | null;
  clientPhone?: string | null;
  clientInn?: string | null;
  clientAddress?: string | null;
  status?: ProjectStatus;
  startDate?: string | null;
  endDate?: string | null;
  siteObject?: string | null;
  areaM2?: number | null;
  camerasCount?: number | null;
  equipmentBrand?: string | null;
  budgetRub?: number | null;
};

export const update = async (
  tx: Db,
  params: { id: string; companyId: string; patch: PatchInput },
): Promise<Project | undefined> => {
  // Пустой patch отсекается на уровне zod-refine в контракте, сюда не дойдёт.
  // Но на всякий случай — если patch пуст, вернём текущую строку без UPDATE.
  if (Object.keys(params.patch).length === 0) {
    return findById(tx, { id: params.id, companyId: params.companyId });
  }
  const [row] = await tx
    .update(projects)
    .set(params.patch)
    .where(
      and(
        eq(projects.id, params.id),
        eq(projects.companyId, params.companyId),
        isNull(projects.deletedAt),
      ),
    )
    .returning();
  return row;
};

// Soft-delete. Возвращает true если строка была помечена, false если её уже
// не было (не найдено или уже удалено) — это нужно чтобы route мог вернуть 404
// на второй delete подряд (см. CLAUDE.md: серьёзные действия не идемпотентны).
export const softDelete = async (
  tx: Db,
  params: { id: string; companyId: string },
): Promise<boolean> => {
  const [row] = await tx
    .update(projects)
    .set({ deletedAt: sql`now()` })
    .where(
      and(
        eq(projects.id, params.id),
        eq(projects.companyId, params.companyId),
        isNull(projects.deletedAt),
      ),
    )
    .returning({ id: projects.id });
  return row !== undefined;
};
