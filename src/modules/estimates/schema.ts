// Реэкспорт zod-схем контракта из @smeteora/shared.
// Все входы и выходы модуля estimates проходят через эти схемы.

export {
  ESTIMATE_STATUSES,
  VAT_MODES,
  LINE_ITEM_KINDS,
  estimateHeaderSchema,
  estimateSectionSchema,
  estimateLineItemSchema,
  estimateSectionWithTotalsSchema,
  estimateLineItemWithTotalsSchema,
  estimateTreeResponseSchema,
  estimateListItemSchema,
  estimateTotalsSchema,
  listEstimatesQuerySchema,
  listEstimatesResponseSchema,
  createEstimateBodySchema,
  upsertTreeBodySchema,
  estimateIdParamSchema,
  estimateDeleteResponseSchema,
  ESTIMATES_BASE_PATH,
} from '@smeteora/shared';

export type {
  EstimateStatus,
  VatMode,
  LineItemKind,
  EstimateHeader,
  EstimateSectionDto,
  EstimateLineItemDto,
  EstimateTreeResponse,
  EstimateListItem,
  EstimateTotals,
  SectionTotals,
  LineItemTotals,
  ListEstimatesQuery,
  ListEstimatesResponse,
  CreateEstimateBody,
  UpsertTreeBody,
  TreeSectionInput,
  TreeLineItemInput,
  TreeHeaderPatch,
} from '@smeteora/shared';
