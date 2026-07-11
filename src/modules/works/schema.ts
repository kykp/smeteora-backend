// Реэкспорт zod-схем и путей из @smeteora/shared.

export {
  workCategorySchema,
  workItemSchema,
  createWorkCategoryBodySchema,
  updateWorkCategoryBodySchema,
  listWorkCategoriesResponseSchema,
  createWorkItemBodySchema,
  updateWorkItemBodySchema,
  listWorkItemsQuerySchema,
  listWorkItemsResponseSchema,
  workIdParamSchema,
  workOkResponseSchema,
  applyDefaultsResponseSchema,
} from '@smeteora/shared';

export type {
  WorkCategoryDto,
  WorkItemDto,
  CreateWorkCategoryBody,
  UpdateWorkCategoryBody,
  ListWorkCategoriesResponse,
  CreateWorkItemBody,
  UpdateWorkItemBody,
  ListWorkItemsQuery,
  ListWorkItemsResponse,
  ApplyDefaultsResponse,
} from '@smeteora/shared';
