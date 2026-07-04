import { type Db } from '../../db/client.js';
import { type Project } from '../../db/schema/index.js';
import { NotFoundError } from '../../lib/errors.js';
import { type ProjectStatus } from '../../db/constants.js';
import { writeAudit } from '../../lib/audit.js';
import * as repo from './repo.js';
import {
  type CreateProjectBody,
  type ListProjectsQuery,
  type ListProjectsResponse,
  type ProjectResponse,
  type UpdateProjectBody,
} from './schema.js';

// Маппер Drizzle-строки → DTO. Timestamp → ISO string;
// поле date уже возвращается Drizzle как строка YYYY-MM-DD.
const toDto = (row: Project): ProjectResponse => ({
  id: row.id,
  companyId: row.companyId,
  name: row.name,
  description: row.description,
  address: row.address,
  clientName: row.clientName,
  clientPhone: row.clientPhone,
  status: row.status,
  startDate: row.startDate,
  endDate: row.endDate,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

// Нормализация опциональных строк в create/update: пустая строка/undefined
// в null для nullable-полей. Так база не хранит "" — только null или значимое.
const emptyToNull = (v: string | null | undefined): string | null => {
  if (v === undefined) return null;
  if (v === null) return null;
  const trimmed = v.trim();
  return trimmed.length === 0 ? null : trimmed;
};

export const list = async (
  tx: Db,
  ctx: { companyId: string },
  query: ListProjectsQuery,
): Promise<ListProjectsResponse> => {
  const { items, total } = await repo.listByCompany(tx, {
    companyId: ctx.companyId,
    status: query.status,
    limit: query.limit,
    offset: query.offset,
  });
  return {
    items: items.map(toDto),
    total,
    limit: query.limit,
    offset: query.offset,
  };
};

export const getById = async (
  tx: Db,
  ctx: { companyId: string },
  id: string,
): Promise<ProjectResponse> => {
  const row = await repo.findById(tx, { id, companyId: ctx.companyId });
  if (!row) throw new NotFoundError('Проект не найден');
  return toDto(row);
};

const DEFAULT_STATUS: ProjectStatus = 'draft';

export const create = async (
  tx: Db,
  ctx: { companyId: string },
  body: CreateProjectBody,
): Promise<ProjectResponse> => {
  const row = await repo.insert(tx, {
    companyId: ctx.companyId,
    name: body.name.trim(),
    description: emptyToNull(body.description),
    address: emptyToNull(body.address),
    clientName: emptyToNull(body.clientName),
    clientPhone: emptyToNull(body.clientPhone),
    status: body.status ?? DEFAULT_STATUS,
    startDate: body.startDate ?? null,
    endDate: body.endDate ?? null,
  });
  return toDto(row);
};

export const update = async (
  tx: Db,
  ctx: { companyId: string },
  id: string,
  body: UpdateProjectBody,
): Promise<ProjectResponse> => {
  // Приводим nullish (undefined/null/пустая строка) в null для nullable-полей.
  // undefined в поле status/name — не трогаем.
  const patch: {
    name?: string;
    description?: string | null;
    address?: string | null;
    clientName?: string | null;
    clientPhone?: string | null;
    status?: ProjectStatus;
    startDate?: string | null;
    endDate?: string | null;
  } = {};

  if (body.name !== undefined) patch.name = body.name.trim();
  if (body.description !== undefined) patch.description = emptyToNull(body.description);
  if (body.address !== undefined) patch.address = emptyToNull(body.address);
  if (body.clientName !== undefined) patch.clientName = emptyToNull(body.clientName);
  if (body.clientPhone !== undefined) patch.clientPhone = emptyToNull(body.clientPhone);
  if (body.status !== undefined) patch.status = body.status;
  if (body.startDate !== undefined) patch.startDate = body.startDate;
  if (body.endDate !== undefined) patch.endDate = body.endDate;

  const row = await repo.update(tx, { id, companyId: ctx.companyId, patch });
  if (!row) throw new NotFoundError('Проект не найден');
  return toDto(row);
};

// Пишет audit-запись в той же транзакции — если softDelete упадёт, audit тоже откатится.
export const softDelete = async (
  tx: Db,
  ctx: { companyId: string; userId: string; sessionId: string },
  id: string,
): Promise<void> => {
  const ok = await repo.softDelete(tx, { id, companyId: ctx.companyId });
  if (!ok) throw new NotFoundError('Проект не найден');
  await writeAudit(tx, {
    companyId: ctx.companyId,
    userId: ctx.userId,
    sessionId: ctx.sessionId,
    action: 'project.delete',
    entityType: 'project',
    entityId: id,
  });
};
