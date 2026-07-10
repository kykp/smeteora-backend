import { z } from 'zod';

// Контракт /api/v1/projects — единый источник правды для бэка и фронта.
// Бэк реализует эти пути через FastifyPluginAsyncZod, фронт импортит эти же схемы
// для генерации типов SDK. Обёртка через @ts-rest — следующий шаг, когда фронт
// начнёт активно потреблять контракт; сейчас достаточно zod-схем + констант путей.

// Жизненный цикл проекта/сметы, юзер меняет вручную. Порядок значений — как
// естественный флоу движения: черновик → работа → согласование → отправлено →
// финал (выиграли/проиграли).
export const PROJECT_STATUSES = ['draft', 'in-progress', 'review', 'sent', 'won', 'lost'] as const;
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
// ИНН российской организации: 10 цифр (юрлицо) или 12 (ИП/самозанятый).
// Держим текстом с regex-валидацией, а не integer'ом — ведущие нули важны,
// плюс избегаем bigint-overflow.
export const PROJECT_CLIENT_INN_MAX = 12;
export const PROJECT_CLIENT_INN_PATTERN = /^\d{10}$|^\d{12}$/;
export const PROJECT_CLIENT_ADDRESS_MAX = 500;
export const PROJECT_SITE_OBJECT_MAX = 200;
export const PROJECT_EQUIPMENT_BRAND_MAX = 200;
// Максимумы — integer постгреса ≈ 2.1 млрд. Ограничиваем меньше, чтобы
// нечаянный ввод «999999999999» не проходил в БД, а падал на валидации.
export const PROJECT_AREA_M2_MAX = 10_000_000;
export const PROJECT_CAMERAS_MAX = 100_000;
export const PROJECT_BUDGET_RUB_MAX = 2_000_000_000;

export const PROJECT_LIST_DEFAULT_LIMIT = 20;
export const PROJECT_LIST_MAX_LIMIT = 100;

// Формат даты для start_date/end_date — YYYY-MM-DD.
// Postgres date без TZ, отдаём/принимаем как строку.
const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Ожидается дата в формате YYYY-MM-DD')
  .nullable();

// ── Доменная сущность ────────────────────────────────────────────
// companyId наружу НЕ отдаём: клиент всегда работает в контексте своей
// активной компании (см. /me → company.id), поэтому дублировать её на
// каждом проекте бессмысленно. RLS + auth-гейт гарантируют что клиент
// физически не увидит проекты чужой компании.

const nonNegativeInt = (max: number) => z.number().int().min(0).max(max).nullable();

// ИНН заказчика — либо null, либо строка ровно из 10 или 12 цифр.
const clientInnSchema = z
  .string()
  .max(PROJECT_CLIENT_INN_MAX)
  .regex(PROJECT_CLIENT_INN_PATTERN, 'ИНН должен содержать 10 или 12 цифр')
  .nullable();

export const projectSchema = z.object({
  id: uuidSchema,
  name: z.string().min(PROJECT_NAME_MIN).max(PROJECT_NAME_MAX),
  description: nullableString(PROJECT_DESCRIPTION_MAX),
  address: nullableString(PROJECT_ADDRESS_MAX),
  clientName: nullableString(PROJECT_CLIENT_NAME_MAX),
  clientPhone: nullableString(PROJECT_CLIENT_PHONE_MAX),
  clientInn: clientInnSchema,
  clientAddress: nullableString(PROJECT_CLIENT_ADDRESS_MAX),
  status: z.enum(PROJECT_STATUSES),
  startDate: isoDateSchema,
  endDate: isoDateSchema,
  siteObject: nullableString(PROJECT_SITE_OBJECT_MAX),
  areaM2: nonNegativeInt(PROJECT_AREA_M2_MAX),
  camerasCount: nonNegativeInt(PROJECT_CAMERAS_MAX),
  equipmentBrand: nullableString(PROJECT_EQUIPMENT_BRAND_MAX),
  budgetRub: nonNegativeInt(PROJECT_BUDGET_RUB_MAX),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ProjectDto = z.infer<typeof projectSchema>;

// ── Request/Response схемы ───────────────────────────────────────

const nonNegativeIntInput = (max: number) => z.number().int().min(0).max(max).nullish();

// ИНН на входе — пустая строка → null; иначе строгий regex.
const clientInnInputSchema = z
  .union([
    z.string().length(0),
    z
      .string()
      .max(PROJECT_CLIENT_INN_MAX)
      .regex(PROJECT_CLIENT_INN_PATTERN, 'ИНН должен содержать 10 или 12 цифр'),
  ])
  .nullish();

export const createProjectBodySchema = z.object({
  name: z.string().trim().min(PROJECT_NAME_MIN).max(PROJECT_NAME_MAX),
  description: z.string().trim().max(PROJECT_DESCRIPTION_MAX).nullish(),
  address: z.string().trim().max(PROJECT_ADDRESS_MAX).nullish(),
  clientName: z.string().trim().max(PROJECT_CLIENT_NAME_MAX).nullish(),
  clientPhone: z.string().trim().max(PROJECT_CLIENT_PHONE_MAX).nullish(),
  clientInn: clientInnInputSchema,
  clientAddress: z.string().trim().max(PROJECT_CLIENT_ADDRESS_MAX).nullish(),
  status: z.enum(PROJECT_STATUSES).optional(),
  startDate: isoDateSchema.optional(),
  endDate: isoDateSchema.optional(),
  siteObject: z.string().trim().max(PROJECT_SITE_OBJECT_MAX).nullish(),
  areaM2: nonNegativeIntInput(PROJECT_AREA_M2_MAX),
  camerasCount: nonNegativeIntInput(PROJECT_CAMERAS_MAX),
  equipmentBrand: z.string().trim().max(PROJECT_EQUIPMENT_BRAND_MAX).nullish(),
  budgetRub: nonNegativeIntInput(PROJECT_BUDGET_RUB_MAX),
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
    clientInn: clientInnInputSchema,
    clientAddress: z.string().trim().max(PROJECT_CLIENT_ADDRESS_MAX).nullish(),
    status: z.enum(PROJECT_STATUSES).optional(),
    startDate: isoDateSchema.optional(),
    endDate: isoDateSchema.optional(),
    siteObject: z.string().trim().max(PROJECT_SITE_OBJECT_MAX).nullish(),
    areaM2: nonNegativeIntInput(PROJECT_AREA_M2_MAX),
    camerasCount: nonNegativeIntInput(PROJECT_CAMERAS_MAX),
    equipmentBrand: z.string().trim().max(PROJECT_EQUIPMENT_BRAND_MAX).nullish(),
    budgetRub: nonNegativeIntInput(PROJECT_BUDGET_RUB_MAX),
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
