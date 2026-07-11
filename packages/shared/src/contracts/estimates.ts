import { z } from 'zod';

// Контракт /api/v1/estimates — доменная сущность "смета".
// Смета = шапка (estimate) + разделы (sections) + позиции (line_items) + история версий.
// В API работаем деревом целиком через tree-upsert: PUT /:id/tree принимает
// весь набор разделов/позиций, сервер diff'ит с текущим состоянием.
//
// Причина такого дизайна: редактор смет ведёт себя как форма-документ.
// Пользователь двигает позиции, переименовывает разделы, удаляет — и жмёт "сохранить".
// Пробрасывать это как N отдельных POST/PATCH/DELETE это лишняя перекладка стейта
// и риск частично сохранённого состояния.

export const ESTIMATE_STATUSES = ['draft', 'sent', 'approved', 'rejected', 'archived'] as const;
export type EstimateStatus = (typeof ESTIMATE_STATUSES)[number];

export const ESTIMATE_MODES = ['simple', 'pro'] as const;
export type EstimateMode = (typeof ESTIMATE_MODES)[number];

export const VAT_MODES = ['none', 'included', 'added'] as const;
export type VatMode = (typeof VAT_MODES)[number];

// Налоговый режим сметы. Считается на клиенте:
//   none         — без налога
//   npd          — НПД 6% с продажи
//   usn_income   — УСН «Доходы» 6% с продажи
//   usn_profit   — УСН «Доходы − расходы» 15% с (валовая − opex), если >0
//   osno         — ОСНО 20% с (валовая − opex), если >0
//   custom       — своя ставка + база
export const TAX_REGIMES = ['none', 'npd', 'usn_income', 'usn_profit', 'osno', 'custom'] as const;
export type TaxRegime = (typeof TAX_REGIMES)[number];
export const TAX_BASE_KINDS = ['income', 'income_minus_expenses'] as const;
export type TaxBaseKind = (typeof TAX_BASE_KINDS)[number];

export const LINE_ITEM_KINDS = ['work', 'material', 'service', 'other'] as const;
export type LineItemKind = (typeof LINE_ITEM_KINDS)[number];

// База расчёта цены на строке — см. src/db/constants.ts на бэке.
export const PRICE_BASES = ['rrp', 'cost', 'manual'] as const;
export type PriceBasis = (typeof PRICE_BASES)[number];

// Категории расходов для позиций kind='other' в разделе «Другое».
// Юзер выбирает из списка при добавлении «Транспортные расходы», «Проектирование»
// и т.п. — это даёт аналитике сгруппировать «сколько ушло на транспорт за квартал».
// Свободный текст в БД (line_item.expense_category) — если завтра захотим
// расширить список без миграции, просто добавим значение в этот массив.
export const EXPENSE_CATEGORIES = [
  'transport',
  'commissioning',
  'design',
  'permits',
  'rental',
  'consumables',
  'contractors',
  'travel',
  'other',
] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

// Человекочитаемые названия — для селекта в UI. Хранится на клиенте,
// не в БД (в БД лежит только id-ключ выше).
export const EXPENSE_CATEGORY_LABELS: Readonly<Record<ExpenseCategory, string>> = {
  transport: 'Транспортные расходы',
  commissioning: 'Пусконаладочные работы',
  design: 'Проектирование и документация',
  permits: 'Согласование и разрешения',
  rental: 'Аренда оборудования / техники',
  consumables: 'Расходные материалы',
  contractors: 'Услуги подрядчиков',
  travel: 'Командировочные / проживание',
  other: 'Прочее',
};

const uuidSchema = z.string().uuid();

export const ESTIMATE_TITLE_MIN = 1;
export const ESTIMATE_TITLE_MAX = 300;
export const ESTIMATE_NUMBER_MAX = 40;
export const ESTIMATE_NOTES_MAX = 4000;
export const SECTION_TITLE_MIN = 1;
export const SECTION_TITLE_MAX = 300;
export const LINE_ITEM_NAME_MIN = 1;
export const LINE_ITEM_NAME_MAX = 500;
export const LINE_ITEM_UNIT_MAX = 40;
export const ESTIMATE_LIST_DEFAULT_LIMIT = 20;
export const ESTIMATE_LIST_MAX_LIMIT = 100;
export const CURRENCY_LENGTH = 3;

// Денежные и количественные поля передаём строкой.
// Причина: JSON number = double, что приводит к артефактам (0.1 + 0.2 = 0.30000000000000004).
// Postgres numeric(14,4) хранит точно, но JS number это ломает при сериализации.
// Строка "1234.5678" гарантирует точность round-trip клиент ↔ сервер ↔ БД.
const decimalStringSchema = (label: string) =>
  z
    .string()
    .regex(/^-?\d+(\.\d+)?$/, `Ожидается число как строка (${label})`)
    .refine((v) => Number.isFinite(Number(v)), `Некорректное число (${label})`);

const nonNegativeDecimal = (label: string) =>
  decimalStringSchema(label).refine((v) => Number(v) >= 0, `${label} не может быть отрицательным`);

const percentDecimal = (label: string) =>
  decimalStringSchema(label).refine(
    (v) => Number(v) >= 0 && Number(v) <= 100,
    `${label} должно быть от 0 до 100`,
  );

// ── Шапка ────────────────────────────────────────────────────────

// companyId наружу НЕ отдаём (см. проект.ProjectSchema — та же логика).
export const estimateHeaderSchema = z.object({
  id: uuidSchema,
  projectId: uuidSchema,
  number: z.string().nullable(),
  title: z.string(),
  currency: z.string().length(CURRENCY_LENGTH),
  vatMode: z.enum(VAT_MODES),
  vatRate: decimalStringSchema('vatRate').nullable(),
  discountPercent: percentDecimal('discountPercent').nullable(),
  discountAmount: nonNegativeDecimal('discountAmount').nullable(),
  status: z.enum(ESTIMATE_STATUSES),
  // Режим редактирования: simple — плоский список, pro — разделы с наценкой.
  // Модель данных одна, различается только UI.
  mode: z.enum(ESTIMATE_MODES),
  // Налоговый режим. Считается на клиенте (см. TAX_REGIMES). taxRate и
  // taxBaseKind нужны только для 'custom' — иначе игнорируются.
  taxRegime: z.enum(TAX_REGIMES),
  taxRate: percentDecimal('taxRate').nullable(),
  taxBaseKind: z.enum(TAX_BASE_KINDS).nullable(),
  notes: z.string().nullable(),
  meta: z.record(z.unknown()),
  // Optimistic concurrency version. Клиент шлёт в If-Match при мутациях,
  // сервер проверяет — если не совпало, возвращает 409 Conflict.
  version: z.number().int().min(1),
  createdBy: uuidSchema.nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type EstimateHeader = z.infer<typeof estimateHeaderSchema>;

export const estimateSectionSchema = z.object({
  id: uuidSchema,
  estimateId: uuidSchema,
  parentId: uuidSchema.nullable(),
  title: z.string(),
  sortOrder: z.number().int(),
  // Наценка раздела в процентах. При добавлении позиции в раздел
  // sellPrice = buyPrice × (1 + defaultMarginPercent/100). null = не
  // применяется автоматом, юзер вводит цену вручную.
  defaultMarginPercent: decimalStringSchema('defaultMarginPercent').nullable(),
  // Скидка раздела в процентах (simple-режим). Применяется ко всем строкам
  // раздела без override — при изменении бэк пересчитывает их цены.
  defaultDiscountPercent: decimalStringSchema('defaultDiscountPercent').nullable(),
  meta: z.record(z.unknown()),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type EstimateSectionDto = z.infer<typeof estimateSectionSchema>;

export const estimateLineItemSchema = z.object({
  id: uuidSchema,
  estimateId: uuidSchema,
  sectionId: uuidSchema.nullable(),
  productId: uuidSchema.nullable(),
  catalogSnapshot: z.record(z.unknown()).nullable(),
  kind: z.enum(LINE_ITEM_KINDS),
  name: z.string(),
  unit: z.string(),
  quantity: nonNegativeDecimal('quantity'),
  price: nonNegativeDecimal('price'),
  // Себестоимость единицы. Для manual («Другое») юзер задаёт руками; для
  // товаров/работ дублирует snapshot и юзер её обычно не трогает. Дефолт 0.
  cost: nonNegativeDecimal('cost'),
  discountPercent: percentDecimal('discountPercent'),
  vatRateOverride: decimalStringSchema('vatRateOverride').nullable(),
  // Override наценки на строке (basis='cost'). null → наследует наценку раздела.
  customMarginPercent: decimalStringSchema('customMarginPercent').nullable(),
  // Override скидки на строке (basis='rrp'). null → наследует скидку раздела.
  customDiscountPercent: decimalStringSchema('customDiscountPercent').nullable(),
  // База расчёта цены — определяет что означает процент строки.
  priceBasis: z.enum(PRICE_BASES),
  // Категория расхода (для kind='other'). null для других kind.
  expenseCategory: z.enum(EXPENSE_CATEGORIES).nullable(),
  sortOrder: z.number().int(),
  meta: z.record(z.unknown()),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type EstimateLineItemDto = z.infer<typeof estimateLineItemSchema>;

// ── Рассчитанные суммы ───────────────────────────────────────────

export const lineItemTotalsSchema = z.object({
  gross: nonNegativeDecimal('gross'), // qty * price
  discount: nonNegativeDecimal('discount'), // скидка на позицию (сумма)
  net: nonNegativeDecimal('net'), // после позиционной скидки, до сметной скидки и НДС
});
export type LineItemTotals = z.infer<typeof lineItemTotalsSchema>;

export const sectionTotalsSchema = z.object({
  itemsCount: z.number().int().min(0),
  net: nonNegativeDecimal('net'), // сумма net всех позиций раздела (включая под-разделы для tree)
});
export type SectionTotals = z.infer<typeof sectionTotalsSchema>;

export const estimateTotalsSchema = z.object({
  itemsGross: nonNegativeDecimal('itemsGross'),
  itemsDiscount: nonNegativeDecimal('itemsDiscount'),
  itemsNet: nonNegativeDecimal('itemsNet'), // сумма net всех позиций сметы
  estimateDiscount: nonNegativeDecimal('estimateDiscount'), // сметная скидка в деньгах
  taxableBase: nonNegativeDecimal('taxableBase'), // itemsNet - estimateDiscount
  vatAmount: nonNegativeDecimal('vatAmount'),
  total: nonNegativeDecimal('total'), // итого к оплате
});
export type EstimateTotals = z.infer<typeof estimateTotalsSchema>;

// ── Полное дерево (GET response) ─────────────────────────────────

export const estimateSectionWithTotalsSchema = estimateSectionSchema.extend({
  totals: sectionTotalsSchema,
});

export const estimateLineItemWithTotalsSchema = estimateLineItemSchema.extend({
  totals: lineItemTotalsSchema,
});

export const estimateTreeResponseSchema = z.object({
  estimate: estimateHeaderSchema,
  totals: estimateTotalsSchema,
  sections: z.array(estimateSectionWithTotalsSchema),
  lineItems: z.array(estimateLineItemWithTotalsSchema),
});
export type EstimateTreeResponse = z.infer<typeof estimateTreeResponseSchema>;

// ── List ─────────────────────────────────────────────────────────
// Список смет — только шапка + итог, без дерева. Дерево — по GET /:id.

// Статус проекта, к которому смета привязана, — это то что юзер видит и
// меняет в шапке проекта. В списке смет показываем именно его, чтобы не
// таскать отдельным запросом /projects список по всем project_id.
const projectStatusInList = z.enum(['draft', 'in-progress', 'review', 'sent', 'won', 'lost']);

export const estimateListItemSchema = estimateHeaderSchema.extend({
  totals: estimateTotalsSchema,
  projectStatus: projectStatusInList,
});
export type EstimateListItem = z.infer<typeof estimateListItemSchema>;

// Сортировка — «поле.направление». По умолчанию updatedAt.desc (недавно
// правленные сверху). Ограниченный enum, чтобы юзерский ?sort=… не мог
// запросить сортировку по любой колонке — только по тем что имеют смысл.
export const ESTIMATE_SORT_OPTIONS = [
  'updatedAt.desc',
  'updatedAt.asc',
  'createdAt.desc',
  'createdAt.asc',
  'title.asc',
  'title.desc',
] as const;
export type EstimateSortOption = (typeof ESTIMATE_SORT_OPTIONS)[number];

export const listEstimatesQuerySchema = z.object({
  projectId: uuidSchema.optional(),
  status: z.enum(ESTIMATE_STATUSES).optional(),
  // Статус связанного проекта — то, что юзер реально видит и фильтрует
  // в UI. Смёты никак не менее связаны со своими проектами, поэтому
  // фильтровать «показать все смёты по выигранным проектам» — валидный
  // юзкейс.
  projectStatus: z.enum(['draft', 'in-progress', 'review', 'sent', 'won', 'lost']).optional(),
  q: z.string().trim().min(1).max(200).optional(),
  sort: z.enum(ESTIMATE_SORT_OPTIONS).default('updatedAt.desc'),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(ESTIMATE_LIST_MAX_LIMIT)
    .default(ESTIMATE_LIST_DEFAULT_LIMIT),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListEstimatesQuery = z.infer<typeof listEstimatesQuerySchema>;

export const listEstimatesResponseSchema = z.object({
  items: z.array(estimateListItemSchema),
  total: z.number().int().min(0),
  limit: z.number().int().min(1),
  offset: z.number().int().min(0),
});
export type ListEstimatesResponse = z.infer<typeof listEstimatesResponseSchema>;

// ── Create (POST /) — только шапка, без дерева ───────────────────

export const createEstimateBodySchema = z
  .object({
    projectId: uuidSchema,
    number: z.string().trim().max(ESTIMATE_NUMBER_MAX).nullish(),
    title: z.string().trim().min(ESTIMATE_TITLE_MIN).max(ESTIMATE_TITLE_MAX),
    currency: z.string().length(CURRENCY_LENGTH).default('RUB'),
    vatMode: z.enum(VAT_MODES).default('none'),
    vatRate: decimalStringSchema('vatRate').nullish(),
    discountPercent: percentDecimal('discountPercent').nullish(),
    discountAmount: nonNegativeDecimal('discountAmount').nullish(),
    // Режим редактирования; дефолт 'simple' — чтобы новичок не пугался разделов.
    mode: z.enum(ESTIMATE_MODES).default('simple'),
    notes: z.string().trim().max(ESTIMATE_NOTES_MAX).nullish(),
    meta: z.record(z.unknown()).optional(),
  })
  .refine(
    (v) =>
      !(v.discountPercent !== undefined && v.discountPercent !== null) ||
      !(v.discountAmount !== undefined && v.discountAmount !== null),
    { message: 'discountPercent и discountAmount взаимоисключимы' },
  )
  .refine((v) => v.vatMode === 'none' || (v.vatRate !== undefined && v.vatRate !== null), {
    message: 'При vatMode != none нужно задать vatRate',
  });
export type CreateEstimateBody = z.infer<typeof createEstimateBodySchema>;

// ── Tree upsert (PUT /:id/tree) ──────────────────────────────────
// Клиент шлёт полное дерево. Клиент сам генерирует uuid для новых секций/позиций
// (crypto.randomUUID в браузере). Сервер сравнивает с текущим состоянием:
//   id есть в БД → UPDATE
//   id есть в body но нет в БД → INSERT с этим id
//   id есть в БД но нет в body → DELETE
// Транзакция гарантирует атомарность — либо всё, либо ничего.

const treeSectionInputSchema = z.object({
  id: uuidSchema,
  parentId: uuidSchema.nullable().optional(),
  title: z.string().trim().min(SECTION_TITLE_MIN).max(SECTION_TITLE_MAX),
  sortOrder: z.number().int(),
  defaultMarginPercent: decimalStringSchema('defaultMarginPercent').nullable().optional(),
  defaultDiscountPercent: decimalStringSchema('defaultDiscountPercent').nullable().optional(),
  meta: z.record(z.unknown()).optional(),
});
export type TreeSectionInput = z.infer<typeof treeSectionInputSchema>;

const treeLineItemInputSchema = z.object({
  id: uuidSchema,
  sectionId: uuidSchema.nullable().optional(),
  productId: uuidSchema.nullable().optional(),
  catalogSnapshot: z.record(z.unknown()).nullable().optional(),
  kind: z.enum(LINE_ITEM_KINDS).default('work'),
  name: z.string().trim().min(LINE_ITEM_NAME_MIN).max(LINE_ITEM_NAME_MAX),
  unit: z.string().trim().min(1).max(LINE_ITEM_UNIT_MAX),
  quantity: nonNegativeDecimal('quantity'),
  price: nonNegativeDecimal('price'),
  cost: nonNegativeDecimal('cost').optional(),
  discountPercent: percentDecimal('discountPercent').optional(),
  vatRateOverride: decimalStringSchema('vatRateOverride').nullable().optional(),
  customMarginPercent: decimalStringSchema('customMarginPercent').nullable().optional(),
  customDiscountPercent: decimalStringSchema('customDiscountPercent').nullable().optional(),
  priceBasis: z.enum(PRICE_BASES).optional(),
  expenseCategory: z.enum(EXPENSE_CATEGORIES).nullable().optional(),
  sortOrder: z.number().int(),
  meta: z.record(z.unknown()).optional(),
});
export type TreeLineItemInput = z.infer<typeof treeLineItemInputSchema>;

// Шапка в tree-upsert. Отдельно от createEstimateBodySchema потому что
// projectId менять нельзя (это привязка сметы к проекту, для этого есть move-эндпоинт),
// и всё опционально, что не задано — не трогаем.
export const treeHeaderPatchSchema = z
  .object({
    number: z.string().trim().max(ESTIMATE_NUMBER_MAX).nullish(),
    title: z.string().trim().min(ESTIMATE_TITLE_MIN).max(ESTIMATE_TITLE_MAX).optional(),
    currency: z.string().length(CURRENCY_LENGTH).optional(),
    vatMode: z.enum(VAT_MODES).optional(),
    vatRate: decimalStringSchema('vatRate').nullish(),
    discountPercent: percentDecimal('discountPercent').nullish(),
    discountAmount: nonNegativeDecimal('discountAmount').nullish(),
    mode: z.enum(ESTIMATE_MODES).optional(),
    taxRegime: z.enum(TAX_REGIMES).optional(),
    taxRate: percentDecimal('taxRate').nullish(),
    taxBaseKind: z.enum(TAX_BASE_KINDS).nullish(),
    notes: z.string().trim().max(ESTIMATE_NOTES_MAX).nullish(),
    meta: z.record(z.unknown()).optional(),
  })
  .refine(
    (v) =>
      !(v.discountPercent !== undefined && v.discountPercent !== null) ||
      !(v.discountAmount !== undefined && v.discountAmount !== null),
    { message: 'discountPercent и discountAmount взаимоисключимы' },
  );
export type TreeHeaderPatch = z.infer<typeof treeHeaderPatchSchema>;

export const upsertTreeBodySchema = z
  .object({
    estimate: treeHeaderPatchSchema.optional(),
    sections: z.array(treeSectionInputSchema),
    lineItems: z.array(treeLineItemInputSchema),
  })
  .superRefine((body, ctx) => {
    // Дубли id по секциям.
    const sectionIds = new Set<string>();
    for (const s of body.sections) {
      if (sectionIds.has(s.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['sections'],
          message: `Дублированный id секции: ${s.id}`,
        });
      }
      sectionIds.add(s.id);
    }
    // Дубли id по позициям.
    const itemIds = new Set<string>();
    for (const li of body.lineItems) {
      if (itemIds.has(li.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['lineItems'],
          message: `Дублированный id позиции: ${li.id}`,
        });
      }
      itemIds.add(li.id);
    }
    // Позиция ссылается на секцию, которая должна быть в body (после upsert она будет в БД).
    for (const li of body.lineItems) {
      if (li.sectionId != null && !sectionIds.has(li.sectionId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['lineItems'],
          message: `Позиция ${li.id} ссылается на несуществующую в body секцию ${li.sectionId}`,
        });
      }
    }
    // Раздел ссылается на родителя в body.
    for (const s of body.sections) {
      if (s.parentId != null && !sectionIds.has(s.parentId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['sections'],
          message: `Раздел ${s.id} ссылается на несуществующий parentId ${s.parentId}`,
        });
      }
      if (s.parentId === s.id) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['sections'],
          message: `Раздел ${s.id} не может быть родителем самому себе`,
        });
      }
    }
  });
export type UpsertTreeBody = z.infer<typeof upsertTreeBodySchema>;

// ── Патч шапки (PATCH /:id) ─────────────────────────────────────
// Отдельный эндпоинт для частичных изменений шапки — без пересборки дерева.
// Основной кейс: синхронизация title сметы при переименовании проекта.
// projectId менять нельзя — для этого будет отдельный move-эндпоинт.
export const updateEstimateBodySchema = treeHeaderPatchSchema;
export type UpdateEstimateBody = z.infer<typeof updateEstimateBodySchema>;

// ── Отдельные CRUD для строк сметы (без tree-upsert) ─────────────
// Атомарные операции. Используются с заголовком If-Match: <version>,
// сервер проверяет optimistic concurrency; заголовок Idempotency-Key: <uuid>
// защищает от повторной отправки.

export const createLineItemBodySchema = z.object({
  sectionId: uuidSchema.nullable().optional(),
  productId: uuidSchema.nullable().optional(),
  catalogSnapshot: z.record(z.unknown()).nullable().optional(),
  kind: z.enum(LINE_ITEM_KINDS).optional(),
  name: z.string().trim().min(LINE_ITEM_NAME_MIN).max(LINE_ITEM_NAME_MAX),
  unit: z.string().trim().min(1).max(LINE_ITEM_UNIT_MAX),
  quantity: nonNegativeDecimal('quantity'),
  price: nonNegativeDecimal('price'),
  cost: nonNegativeDecimal('cost').optional(),
  discountPercent: percentDecimal('discountPercent').optional(),
  vatRateOverride: decimalStringSchema('vatRateOverride').nullable().optional(),
  customMarginPercent: decimalStringSchema('customMarginPercent').nullable().optional(),
  customDiscountPercent: decimalStringSchema('customDiscountPercent').nullable().optional(),
  priceBasis: z.enum(PRICE_BASES).optional(),
  expenseCategory: z.enum(EXPENSE_CATEGORIES).nullable().optional(),
  sortOrder: z.number().int().optional(),
  meta: z.record(z.unknown()).optional(),
});
export type CreateLineItemBody = z.infer<typeof createLineItemBodySchema>;

// PATCH — все поля опциональны; undefined = не трогаем.
export const updateLineItemBodySchema = z
  .object({
    sectionId: uuidSchema.nullable().optional(),
    productId: uuidSchema.nullable().optional(),
    catalogSnapshot: z.record(z.unknown()).nullable().optional(),
    kind: z.enum(LINE_ITEM_KINDS).optional(),
    name: z.string().trim().min(LINE_ITEM_NAME_MIN).max(LINE_ITEM_NAME_MAX).optional(),
    unit: z.string().trim().min(1).max(LINE_ITEM_UNIT_MAX).optional(),
    quantity: nonNegativeDecimal('quantity').optional(),
    price: nonNegativeDecimal('price').optional(),
    cost: nonNegativeDecimal('cost').optional(),
    discountPercent: percentDecimal('discountPercent').optional(),
    vatRateOverride: decimalStringSchema('vatRateOverride').nullable().optional(),
    customMarginPercent: decimalStringSchema('customMarginPercent').nullable().optional(),
    customDiscountPercent: decimalStringSchema('customDiscountPercent').nullable().optional(),
    priceBasis: z.enum(PRICE_BASES).optional(),
    expenseCategory: z.enum(EXPENSE_CATEGORIES).nullable().optional(),
    sortOrder: z.number().int().optional(),
    meta: z.record(z.unknown()).optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: 'Нужно передать хотя бы одно поле для обновления',
  });
export type UpdateLineItemBody = z.infer<typeof updateLineItemBodySchema>;

export const lineItemIdParamSchema = z.object({
  id: uuidSchema, // estimateId
  lineId: uuidSchema,
});

// Ответ CRUD-мутации — свежее дерево целиком. Возвращаем весь агрегат,
// чтобы клиент сразу обновил кэш и увидел актуальные totals без второго
// запроса.
export const lineItemMutationResponseSchema = estimateTreeResponseSchema;

// ── CRUD разделов ────────────────────────────────────────────────

export const createSectionBodySchema = z.object({
  parentId: uuidSchema.nullable().optional(),
  title: z.string().trim().min(SECTION_TITLE_MIN).max(SECTION_TITLE_MAX),
  sortOrder: z.number().int().optional(),
  defaultMarginPercent: decimalStringSchema('defaultMarginPercent').nullable().optional(),
  defaultDiscountPercent: decimalStringSchema('defaultDiscountPercent').nullable().optional(),
  meta: z.record(z.unknown()).optional(),
});
export type CreateSectionBody = z.infer<typeof createSectionBodySchema>;

export const updateSectionBodySchema = z
  .object({
    parentId: uuidSchema.nullable().optional(),
    title: z.string().trim().min(SECTION_TITLE_MIN).max(SECTION_TITLE_MAX).optional(),
    sortOrder: z.number().int().optional(),
    defaultMarginPercent: decimalStringSchema('defaultMarginPercent').nullable().optional(),
    defaultDiscountPercent: decimalStringSchema('defaultDiscountPercent').nullable().optional(),
    meta: z.record(z.unknown()).optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: 'Нужно передать хотя бы одно поле для обновления',
  });
export type UpdateSectionBody = z.infer<typeof updateSectionBodySchema>;

export const sectionIdParamSchema = z.object({
  id: uuidSchema, // estimateId
  sectionId: uuidSchema,
});

export const sectionMutationResponseSchema = estimateTreeResponseSchema;

// ── Прочие мелкие схемы ──────────────────────────────────────────

export const estimateIdParamSchema = z.object({ id: uuidSchema });

export const estimateDeleteResponseSchema = z.object({ ok: z.literal(true) });

// ── Пути ─────────────────────────────────────────────────────────

export const ESTIMATES_BASE_PATH = '/estimates';

export const estimatesPaths = Object.freeze({
  list: ESTIMATES_BASE_PATH,
  create: ESTIMATES_BASE_PATH,
  getOne: (id: string): string => `${ESTIMATES_BASE_PATH}/${id}`,
  update: (id: string): string => `${ESTIMATES_BASE_PATH}/${id}`,
  upsertTree: (id: string): string => `${ESTIMATES_BASE_PATH}/${id}/tree`,
  delete: (id: string): string => `${ESTIMATES_BASE_PATH}/${id}`,
});
