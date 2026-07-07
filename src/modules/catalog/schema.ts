// Реэкспорт zod-схем и путей из @smeteora/shared.

export {
  productSchema,
  productCategorySchema,
  unitSchema,
  createProductBodySchema,
  updateProductBodySchema,
  listProductsQuerySchema,
  listProductsResponseSchema,
  createCategoryBodySchema,
  updateCategoryBodySchema,
  listCategoriesResponseSchema,
  listUnitsResponseSchema,
  idParamSchema,
  okResponseSchema,
  CATALOG_SOURCES,
} from '@smeteora/shared';

export type {
  ProductDto,
  ProductCategoryDto,
  UnitDto,
  CreateProductBody,
  UpdateProductBody,
  ListProductsQuery,
  ListProductsResponse,
  CreateCategoryBody,
  UpdateCategoryBody,
  ListCategoriesResponse,
  ListUnitsResponse,
  CatalogSource,
} from '@smeteora/shared';
