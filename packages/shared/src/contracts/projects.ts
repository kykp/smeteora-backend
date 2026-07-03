import { z } from 'zod';

// Контракт /api/v1/projects — единый источник правды для бэка и фронта.
// Бэк реализует эти пути через FastifyPluginAsyncZod, фронт импортит эти же схемы
// для генерации типов SDK. Обёртка через @ts-rest — следующий шаг, когда фронт
// начнёт активно потреблять контракт; сейчас достаточно zod-схем + констант путей.

export const PROJECT_STATUSES = ['draft', 'active', 'archived'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

const uuidSchema = z.string().uuid();
const nullableString = (max: number): z.ZodNullable<z.ZodString> => z.string().max(max).nullable();

// Внешние ограничения полей — согласованы с фронтом чтобы zod-ошибка ловилась там же.
export const PROJECT_NAME_MIN = 1;
export const PROJECT_NAME_MAX = 200;
export const PROJECT_DESCRIPTION_MAX = 4000;
export const PROJECT_ADDRESS_MAX = 500;
export const PROJECT_CLIENT_NAME_MAX = 200;
export const PROJECT_CLIENT_PHONE_MAX = 40;

export const PROJECT_LIST_DEFAULT_LIMIT = 20;
export const PROJECT_LIST_MAX_LIMIT = 100;

// Формат даты для start_date/end_date — YYYY-MM-DD.
// Postgres date без TZ, отдаём/принимаем как строку.
const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Ожидается дата в формате YYYY-MM-DD')
  .nullable();

// ── Доменная сущность ────────────────────────────────────────────
// Ответы API отдают companyId — фронт использует его для сверки с активной
// компанией из /me. Но НЕ показывают ссылки на чужие компании (RLS гарантирует
// что клиент никогда не увидит проекты не своей компании).

export const projectSchema = z.object({
  id: uuidSchema,
  companyId: uuidSchema,
  name: z.string().min(PROJECT_NAME_MIN).max(PROJECT_NAME_MAX),
  description: nullableString(PROJECT_DESCRIPTION_MAX),
  address: nullableString(PROJECT_ADDRESS_MAX),
  clientName: nullableString(PROJECT_CLIENT_NAME_MAX),
  clientPhone: nullableString(PROJECT_CLIENT_PHONE_MAX),
  status: z.enum(PROJECT_STATUSES),
  startDate: isoDateSchema,
  endDate: isoDateSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ProjectDto = z.infer<typeof projectSchema>;

// ── Request/Response схемы ───────────────────────────────────────

export const createProjectBodySchema = z.object({
  name: z.string().trim().min(PROJECT_NAME_MIN).max(PROJECT_NAME_MAX),
  description: z.string().trim().max(PROJECT_DESCRIPTION_MAX).nullish(),
  address: z.string().trim().max(PROJECT_ADDRESS_MAX).nullish(),
  clientName: z.string().trim().max(PROJECT_CLIENT_NAME_MAX).nullish(),
  clientPhone: z.string().trim().max(PROJECT_CLIENT_PHONE_MAX).nullish(),
  status: z.enum(PROJECT_STATUSES).optional(),
  startDate: isoDateSchema.optional(),
  endDate: isoDateSchema.optional(),
});
export type CreateProjectBody = z.infer<typeof createProjectBodySchema>;

// Update — все поля опциональны. undefined = не трогаем; null = очистить (для nullable полей).
export const updateProjectBodySchema = z
  .object({
    name: z.string().trim().min(PROJECT_NAME_MIN).max(PROJECT_NAME_MAX).optional(),
    description: z.string().trim().max(PROJECT_DESCRIPTION_MAX).nullish(),
    address: z.string().trim().max(PROJECT_ADDRESS_MAX).nullish(),
    clientName: z.string().trim().max(PROJECT_CLIENT_NAME_MAX).nullish(),
    clientPhone: z.string().trim().max(PROJECT_CLIENT_PHONE_MAX).nullish(),
    status: z.enum(PROJECT_STATUSES).optional(),
    startDate: isoDateSchema.optional(),
    endDate: isoDateSchema.optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: 'Нужно передать хотя бы одно поле для обновления',
  });
export type UpdateProjectBody = z.infer<typeof updateProjectBodySchema>;

export const projectIdParamSchema = z.object({
  id: uuidSchema,
});

export const listProjectsQuerySchema = z.object({
  status: z.enum(PROJECT_STATUSES).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(PROJECT_LIST_MAX_LIMIT)
    .default(PROJECT_LIST_DEFAULT_LIMIT),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListProjectsQuery = z.infer<typeof listProjectsQuerySchema>;

export const listProjectsResponseSchema = z.object({
  items: z.array(projectSchema),
  total: z.number().int().min(0),
  limit: z.number().int().min(1),
  offset: z.number().int().min(0),
});
export type ListProjectsResponse = z.infer<typeof listProjectsResponseSchema>;

export const projectResponseSchema = projectSchema;
export type ProjectResponse = z.infer<typeof projectResponseSchema>;

// ── Пути ────────────────────────────────────────────────────────
// Держим строкой в одном месте — чтобы фронт не хардкодил URL по частям.

export const PROJECTS_BASE_PATH = '/projects';

export const projectsPaths = Object.freeze({
  list: PROJECTS_BASE_PATH,
  create: PROJECTS_BASE_PATH,
  getOne: (id: string): string => `${PROJECTS_BASE_PATH}/${id}`,
  update: (id: string): string => `${PROJECTS_BASE_PATH}/${id}`,
  delete: (id: string): string => `${PROJECTS_BASE_PATH}/${id}`,
});
