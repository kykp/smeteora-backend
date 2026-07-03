// Реэкспорт zod-схем из @smeteora/shared.
// Модуль projects — первый инкремент с shared-контрактом.
// Валидация входов и сериализация ответов идут через эти же схемы.

export {
  projectSchema,
  createProjectBodySchema,
  updateProjectBodySchema,
  projectIdParamSchema,
  listProjectsQuerySchema,
  listProjectsResponseSchema,
  projectResponseSchema,
  PROJECTS_BASE_PATH,
  PROJECT_STATUSES,
} from '@smeteora/shared';

export type {
  ProjectDto,
  ProjectResponse,
  CreateProjectBody,
  UpdateProjectBody,
  ListProjectsQuery,
  ListProjectsResponse,
  ProjectStatus,
} from '@smeteora/shared';

import { z } from 'zod';

// Единый ok-ответ для DELETE — совпадает по форме с auth/okResponseSchema.
export const projectDeleteResponseSchema = z.object({ ok: z.literal(true) });
