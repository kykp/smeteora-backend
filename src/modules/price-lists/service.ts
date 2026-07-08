import { randomUUID } from 'node:crypto';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import type {
  AutoMapping,
  CommitMapping,
  CommitPriceListBody,
  CommitPriceListResponse,
  CommitRowError,
  ListPriceListsResponse,
  ParsePriceListResponse,
  PriceListUploadDto,
} from '@smeteora/shared';
import {
  PARSE_PREVIEW_ROWS,
  PRICE_LIST_FIELD_MAX,
  PRICE_LIST_MAX_BYTES,
  PRICE_LIST_MAX_ROWS,
} from '@smeteora/shared';
import { type Db } from '../../db/client.js';
import {
  productCategories,
  products,
  units,
  type PriceListUpload,
  type ProductCategory,
  type Unit,
} from '../../db/schema/index.js';
import { NotFoundError, ValidationError } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import { type FileStorage } from '../../storage/file-storage.js';
import * as repo from './repo.js';
import {
  autoDetectMapping,
  detectSource,
  parsePriceCell,
  parseSheet,
  type ParsedSheet,
} from './parser.js';

// ── Общий контекст ───────────────────────────────────────────────

type Ctx = {
  companyId: string;
  membershipId: string;
  userId: string;
  sessionId: string;
};

// ── Storage key ──────────────────────────────────────────────────
// bucket price-lists/<company_id>/<upload_id>.<ext>
// company_id в пути чтобы легче ориентироваться при разборе диска.
const buildStorageKey = (params: {
  companyId: string;
  uploadId: string;
  source: 'csv' | 'xlsx';
}): string => `price-lists/${params.companyId}/${params.uploadId}.${params.source}`;

// ── DTO ──────────────────────────────────────────────────────────

const toUploadDto = (row: PriceListUpload): PriceListUploadDto => ({
  id: row.id,
  // В БД source может быть любым CATALOG_OFFER_SOURCES; на выход только csv/xlsx.
  source: row.source === 'xlsx' ? 'xlsx' : 'csv',
  status: row.status,
  originalFilename: row.originalFilename,
  sizeBytes: row.sizeBytes,
  rowsTotal: row.rowsTotal,
  rowsCreated: row.rowsCreated,
  rowsUpdated: row.rowsUpdated,
  rowsSkipped: row.rowsSkipped,
  createdAt: row.createdAt.toISOString(),
  committedAt: row.committedAt ? row.committedAt.toISOString() : null,
});

// ── Parse ────────────────────────────────────────────────────────

export type ParseInput = {
  buffer: Buffer;
  filename: string;
  mimeType: string | null;
  truncated: boolean;
};

export const parsePriceList = async (
  tx: Db,
  storage: FileStorage,
  ctx: Ctx,
  input: ParseInput,
): Promise<ParsePriceListResponse> => {
  if (input.truncated) {
    throw new ValidationError(
      `Файл превышает лимит ${Math.round(PRICE_LIST_MAX_BYTES / 1024 / 1024)} МБ`,
    );
  }
  if (input.buffer.length === 0) {
    throw new ValidationError('Файл пустой');
  }

  const source = detectSource({ mimeType: input.mimeType, filename: input.filename });
  const sheet = parseSheet(input.buffer, source);
  if (sheet.headers.length === 0) {
    throw new ValidationError('В файле нет заголовков колонок');
  }
  if (sheet.rows.length === 0) {
    throw new ValidationError('В файле нет строк данных');
  }
  if (sheet.rows.length > PRICE_LIST_MAX_ROWS) {
    throw new ValidationError(
      `Слишком много строк: ${sheet.rows.length}. Максимум — ${PRICE_LIST_MAX_ROWS}`,
    );
  }

  const uploadId = randomUUID();
  const storageKey = buildStorageKey({ companyId: ctx.companyId, uploadId, source });
  const contentType =
    source === 'xlsx'
      ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      : 'text/csv';
  await storage.save(storageKey, input.buffer, { contentType });

  await repo.insertUpload(tx, {
    id: uploadId,
    companyId: ctx.companyId,
    membershipId: ctx.membershipId,
    source,
    sourceMetadata: {
      headers: sheet.headers,
      rowsInFile: sheet.rows.length,
    },
    status: 'parsed',
    originalFilename: input.filename,
    storageKey,
    mimeType: input.mimeType,
    sizeBytes: input.buffer.length,
    rowsTotal: sheet.rows.length,
  });

  const autoMapping = autoDetectMapping(sheet.headers);

  return {
    uploadId,
    originalFilename: input.filename,
    source,
    headers: sheet.headers,
    previewRows: sheet.rows.slice(0, PARSE_PREVIEW_ROWS),
    rowsTotal: sheet.rows.length,
    autoMapping,
  };
};

// ── Commit ───────────────────────────────────────────────────────

type UnitIndex = {
  byId: Map<string, Unit>;
  byNormalizedName: Map<string, Unit>;
};

type CategoryIndex = {
  byId: Map<string, ProductCategory>;
  byNormalizedName: Map<string, ProductCategory>;
};

const normalizeText = (s: string): string => s.trim().toLowerCase();

const loadUnitsIndex = async (tx: Db): Promise<UnitIndex> => {
  const rows = await tx.select().from(units);
  const byId = new Map<string, Unit>();
  const byNormalizedName = new Map<string, Unit>();
  for (const u of rows) {
    byId.set(u.id, u);
    // Кладём все варианты имени (code, shortName, fullName) — все ключи lower.
    // Первый победил — не перезатираем.
    for (const key of [u.code, u.shortName, u.fullName]) {
      const k = normalizeText(key);
      if (k.length > 0 && !byNormalizedName.has(k)) byNormalizedName.set(k, u);
    }
  }
  return { byId, byNormalizedName };
};

const loadCategoriesIndex = async (tx: Db, companyId: string): Promise<CategoryIndex> => {
  // RLS отсекает по контексту, но добавляем явное условие как и в catalog.repo.
  const rows = await tx
    .select()
    .from(productCategories)
    .where(
      and(
        or(eq(productCategories.companyId, companyId), isNull(productCategories.companyId)) ??
          sql`false`,
        isNull(productCategories.deletedAt),
      ),
    );
  const byId = new Map<string, ProductCategory>();
  const byNormalizedName = new Map<string, ProductCategory>();
  for (const c of rows) {
    byId.set(c.id, c);
    // Ключей два: name и code. Приоритет — свой над платформенным.
    const isOwn = c.companyId === companyId;
    for (const key of [c.name, c.code]) {
      const k = normalizeText(key);
      if (k.length === 0) continue;
      const existing = byNormalizedName.get(k);
      if (!existing || (isOwn && existing.companyId === null)) {
        byNormalizedName.set(k, c);
      }
    }
  }
  return { byId, byNormalizedName };
};

// Достаём ячейку строки по индексу колонки из mapping'а. Возвращает trimmed или ''.
const cellAt = (row: string[], idx: number | null): string => {
  if (idx === null || idx < 0 || idx >= row.length) return '';
  return (row[idx] ?? '').trim();
};

// Обрезаем длинное значение до max — иначе zod-схема продукта отвергнет строку
// целиком, а юзеру полезнее «привезли, но обрезали до 500 символов».
const truncate = (s: string, max: number): string => (s.length > max ? s.slice(0, max) : s);

// Валидация индексов маппинга: должны быть в диапазоне заголовков.
const validateMapping = (mapping: CommitMapping, headersLength: number): void => {
  const check = (label: string, idx: number | null): void => {
    if (idx === null) return;
    if (idx < 0 || idx >= headersLength) {
      throw new ValidationError(
        `Некорректный маппинг «${label}»: колонка ${idx} вне диапазона (0..${headersLength - 1})`,
      );
    }
  };
  check('name', mapping.name);
  check('sku', mapping.sku);
  check('brand', mapping.brand);
  check('unit', mapping.unit);
  check('sellPrice', mapping.sellPrice);
  check('buyPrice', mapping.buyPrice);
  check('category', mapping.category);
  check('description', mapping.description);
};

// Фолбэк-справочники: категория 'other' + единица 'pcs' из платформы.
// Используются когда юзер не назначил колонку category/unit или значение в файле
// пустое / не сматчилось. Без них создать строку в products нельзя — оба поля NOT NULL.
type Fallbacks = {
  categoryId: string;
  unitId: string;
};

const resolveFallbacks = async (
  tx: Db,
  unitsIdx: UnitIndex,
  categoriesIdx: CategoryIndex,
): Promise<Fallbacks> => {
  void tx;
  // 'pcs' — платформенный unit «штука» (см. миграцию 0009 seed).
  const pcsUnit = unitsIdx.byNormalizedName.get('pcs') ?? unitsIdx.byNormalizedName.get('шт');
  if (!pcsUnit) {
    throw new ValidationError('Не найден платформенный unit «шт» — обратитесь в поддержку');
  }
  const otherCategory =
    categoriesIdx.byNormalizedName.get('other') ?? categoriesIdx.byNormalizedName.get('прочее');
  if (!otherCategory) {
    throw new ValidationError(
      'Не найдена платформенная категория «Прочее» — обратитесь в поддержку',
    );
  }
  return { categoryId: otherCategory.id, unitId: pcsUnit.id };
};

export const commitPriceList = async (
  tx: Db,
  storage: FileStorage,
  ctx: Ctx,
  uploadId: string,
  body: CommitPriceListBody,
): Promise<CommitPriceListResponse> => {
  const upload = await repo.findUploadById(tx, { id: uploadId, companyId: ctx.companyId });
  if (!upload) throw new NotFoundError('Загрузка не найдена');
  if (upload.status !== 'parsed') {
    throw new ValidationError('Загрузка уже обработана или отменена');
  }

  // Перечитываем файл. Storage-key лежит в БД — то есть источник правды один.
  const { data } = await storage.get(upload.storageKey);
  const source: 'csv' | 'xlsx' = upload.source === 'xlsx' ? 'xlsx' : 'csv';
  const sheet: ParsedSheet = parseSheet(data, source);
  validateMapping(body.mapping, sheet.headers.length);

  const unitsIdx = await loadUnitsIndex(tx);
  const categoriesIdx = await loadCategoriesIndex(tx, ctx.companyId);
  // Фолбэки для категории/единицы — используются когда юзер не назначил колонку
  // или значение в файле не сматчилось. Без этого товар нельзя вставить (NOT NULL FK).
  const fallbacks = await resolveFallbacks(tx, unitsIdx, categoriesIdx);

  const errors: CommitRowError[] = [];
  let rowsCreated = 0;
  let rowsUpdated = 0;
  let rowsSkipped = 0;

  // Row-based обработка: select→insert/update. Дороже bulk-upsert'а, зато
  // прозрачные per-row ошибки. Для 10k позиций укладываемся в минуту.
  for (let i = 0; i < sheet.rows.length; i += 1) {
    const row = sheet.rows[i] ?? [];
    const displayRow = i + 2; // +1 за 0-based → 1-based, +1 за строку заголовка

    try {
      const name = truncate(cellAt(row, body.mapping.name), PRICE_LIST_FIELD_MAX.name);
      if (name.length === 0) {
        errors.push({ row: displayRow, message: 'Пустое наименование' });
        rowsSkipped += 1;
        continue;
      }

      const rawSku = cellAt(row, body.mapping.sku);
      const sku = rawSku.length > 0 ? truncate(rawSku, PRICE_LIST_FIELD_MAX.sku) : null;

      const rawBrand = cellAt(row, body.mapping.brand);
      const brand = rawBrand.length > 0 ? truncate(rawBrand, PRICE_LIST_FIELD_MAX.brand) : null;

      const rawDesc = cellAt(row, body.mapping.description);
      const description =
        rawDesc.length > 0 ? truncate(rawDesc, PRICE_LIST_FIELD_MAX.description) : null;

      // Unit: пробуем матчить, иначе фолбэк на 'pcs'.
      const rawUnit = cellAt(row, body.mapping.unit);
      const matchedUnit =
        rawUnit.length > 0 ? unitsIdx.byNormalizedName.get(normalizeText(rawUnit)) : undefined;
      const unitId = matchedUnit ? matchedUnit.id : fallbacks.unitId;

      // Category: аналогично, фолбэк на 'other'.
      const rawCategory = cellAt(row, body.mapping.category);
      const matchedCategory =
        rawCategory.length > 0
          ? categoriesIdx.byNormalizedName.get(normalizeText(rawCategory))
          : undefined;
      const categoryId = matchedCategory ? matchedCategory.id : fallbacks.categoryId;

      // Две цены независимо — юзер маппит либо одну, либо обе, либо ни одной.
      const parseOptionalPrice = (rawIdx: number | null): string | null => {
        const raw = cellAt(row, rawIdx);
        if (raw.length === 0) return null;
        return parsePriceCell(raw);
      };
      let sellPrice: string | null = null;
      let buyPrice: string | null = null;
      try {
        sellPrice = parseOptionalPrice(body.mapping.sellPrice);
      } catch (e) {
        errors.push({
          row: displayRow,
          message: `цена продажи: ${e instanceof Error ? e.message : 'ошибка'}`,
        });
        rowsSkipped += 1;
        continue;
      }
      try {
        buyPrice = parseOptionalPrice(body.mapping.buyPrice);
      } catch (e) {
        errors.push({
          row: displayRow,
          message: `цена закупки: ${e instanceof Error ? e.message : 'ошибка'}`,
        });
        rowsSkipped += 1;
        continue;
      }

      // Upsert. Ищем существующий по (companyId, sku) — если sku указан.
      let existingId: string | null = null;
      if (sku !== null) {
        const existing = await tx
          .select({ id: products.id })
          .from(products)
          .where(
            and(
              eq(products.companyId, ctx.companyId),
              eq(products.sku, sku),
              isNull(products.deletedAt),
            ),
          )
          .limit(1);
        existingId = existing[0]?.id ?? null;
      }

      if (existingId !== null) {
        // Обновляем только цены, которые юзер замаппил — иначе оставляем
        // существующее значение (mapping отсутствует ≠ «сбрось цену в null»).
        await tx
          .update(products)
          .set({
            name,
            brand,
            description,
            unitId,
            categoryId,
            ...(body.mapping.sellPrice !== null ? { sellPrice } : {}),
            ...(body.mapping.buyPrice !== null ? { buyPrice } : {}),
          })
          .where(and(eq(products.id, existingId), eq(products.companyId, ctx.companyId)));
        rowsUpdated += 1;
      } else {
        await tx.insert(products).values({
          companyId: ctx.companyId,
          source: 'company',
          categoryId,
          unitId,
          name,
          sku,
          brand,
          description,
          buyPrice,
          sellPrice,
          attributes: {},
          isActive: true,
        });
        rowsCreated += 1;
      }
    } catch (e) {
      errors.push({
        row: displayRow,
        message: e instanceof Error ? e.message : 'неизвестная ошибка',
      });
      rowsSkipped += 1;
    }
  }

  const summary = {
    rowsCreated,
    rowsUpdated,
    rowsSkipped,
    errors: errors.slice(0, 100),
    mappedFields: Object.entries(body.mapping)
      .filter(([, v]) => v !== null && v !== undefined)
      .map(([k]) => k),
  };
  await repo.updateUploadCommit(tx, {
    id: uploadId,
    companyId: ctx.companyId,
    patch: {
      status: 'committed',
      rowsTotal: sheet.rows.length,
      rowsCreated,
      rowsUpdated,
      rowsSkipped,
      summary,
      committedAt: new Date(),
    },
  });

  await writeAudit(tx, {
    companyId: ctx.companyId,
    userId: ctx.userId,
    sessionId: ctx.sessionId,
    action: 'price_list.commit',
    entityType: 'price_list_upload',
    entityId: uploadId,
    meta: { rowsCreated, rowsUpdated, rowsSkipped },
  });

  return {
    uploadId,
    rowsTotal: sheet.rows.length,
    rowsCreated,
    rowsUpdated,
    rowsSkipped,
    errors,
  };
};

// ── History ──────────────────────────────────────────────────────

export const listPriceLists = async (
  tx: Db,
  ctx: { companyId: string },
): Promise<ListPriceListsResponse> => {
  const rows = await repo.listUploads(tx, { companyId: ctx.companyId, limit: 50 });
  return { items: rows.map(toUploadDto) };
};

// Реэкспорт типа для роутов
export type { AutoMapping };
