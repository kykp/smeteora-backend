// Общие доменные константы для схемы БД и рантайма.

export const ROLES = ['viewer', 'member', 'admin', 'owner'] as const;
export type Role = (typeof ROLES)[number];

export const MEMBERSHIP_STATUSES = ['active', 'disabled'] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

export const INVITATION_STATUSES = ['pending', 'accepted', 'revoked', 'expired'] as const;
export type InvitationStatus = (typeof INVITATION_STATUSES)[number];

export const PROJECT_STATUSES = ['draft', 'active', 'archived'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const ESTIMATE_STATUSES = ['draft', 'sent', 'approved', 'rejected', 'archived'] as const;
export type EstimateStatus = (typeof ESTIMATE_STATUSES)[number];

// Как трактовать цены позиций относительно НДС:
//   none     — без НДС (subtotal = qty*price)
//   included — цена уже с НДС внутри (нужно выделить обратной формулой)
//   added    — НДС начисляется сверху
export const VAT_MODES = ['none', 'included', 'added'] as const;
export type VatMode = (typeof VAT_MODES)[number];

// Тип позиции сметы. Разбивка "работы / материалы" — стандарт отчётности по сметам.
export const LINE_ITEM_KINDS = ['work', 'material', 'service', 'other'] as const;
export type LineItemKind = (typeof LINE_ITEM_KINDS)[number];

// OAuth-провайдеры, привязка к учётке. Наращивается по мере поддержки.
export const IDENTITY_PROVIDERS = ['yandex'] as const;
export type IdentityProvider = (typeof IDENTITY_PROVIDERS)[number];

// Организационно-правовые формы компаний. БД принимает свободный text,
// enum используется только на слое приложения (Zod).
export const LEGAL_FORMS = ['ooo', 'ip', 'self-employed', 'ao'] as const;
export type LegalForm = (typeof LEGAL_FORMS)[number];

// Каталог: источник записи (платформенная = наша, company = юзерская).
// Влияет на видимость через RLS-политику и на права редактирования.
export const CATALOG_SOURCES = ['platform', 'company'] as const;
export type CatalogSource = (typeof CATALOG_SOURCES)[number];

// Источник записи офера / прайс-листа. Пригодится когда подключим импорт из CSV/XLSX/PDF/API.
export const CATALOG_OFFER_SOURCES = ['manual', 'csv', 'xlsx', 'pdf', 'api'] as const;
export type CatalogOfferSource = (typeof CATALOG_OFFER_SOURCES)[number];

// Статус жизненного цикла загрузки прайса.
//   parsed    — файл разобран, юзер видит превью и настраивает маппинг
//   committed — маппинг применён, товары upsert'нуты в products
//   discarded — юзер отменил, файл не пошёл в каталог (мы храним запись как аудит)
export const PRICE_LIST_UPLOAD_STATUSES = ['parsed', 'committed', 'discarded'] as const;
export type PriceListUploadStatus = (typeof PRICE_LIST_UPLOAD_STATUSES)[number];

// Иерархия ролей: чем выше индекс — тем больше прав.
// Используется для проверки "role >= required" в requireRole preHandler.
export const ROLE_RANK: Readonly<Record<Role, number>> = Object.freeze({
  viewer: 0,
  member: 1,
  admin: 2,
  owner: 3,
});

export const hasRoleAtLeast = (actual: Role, required: Role): boolean =>
  ROLE_RANK[actual] >= ROLE_RANK[required];
