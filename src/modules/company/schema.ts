import { z } from 'zod';
import { LEGAL_FORMS } from '../../db/constants.js';

// Пределы длины полей. Согласованы с фронтом чтобы zod-ошибка ловилась там же.
const NAME_MAX = 200;
const ADDRESS_MAX = 500;
const BANK_NAME_MAX = 200;
const DIRECTOR_NAME_MAX = 200;
const DIRECTOR_POSITION_MAX = 200;
const PHONE_MAX = 40;
const EMAIL_MAX = 254;

// Формат-паттерны для реквизитов РФ.
const innSchema = z.string().regex(/^\d{10}$|^\d{12}$/, 'ИНН должен содержать 10 или 12 цифр');
const kppSchema = z.string().regex(/^\d{9}$/, 'КПП должен содержать 9 цифр');
const ogrnSchema = z.string().regex(/^\d{13}$|^\d{15}$/, 'ОГРН должен содержать 13 или 15 цифр');
const bikSchema = z.string().regex(/^\d{9}$/, 'БИК должен содержать 9 цифр');
const accountSchema = z.string().regex(/^\d{20}$/, 'Номер счёта должен содержать 20 цифр');

const emailSchema = z.string().max(EMAIL_MAX).email('Некорректный email');

// Обёртки для «trimmed string ≥ 1 символ, до max»: пустая строка после trim → ошибка валидации.
const nonEmptyTrimmed = (max: number) => z.string().trim().min(1).max(max);

// ── Ответ ────────────────────────────────────────────────────────
// Все реквизиты nullable — компания заводится с одним name, юзер заполняет постепенно.
// hasLogo — булев флаг «загружен ли логотип»; сам файл фронт получает
// отдельным GET /company/logo (returns бинарник + Content-Type).
export const companyResponseSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  legalForm: z.enum(LEGAL_FORMS).nullable(),
  inn: z.string().nullable(),
  kpp: z.string().nullable(),
  ogrn: z.string().nullable(),
  legalAddress: z.string().nullable(),
  actualAddress: z.string().nullable(),
  bankName: z.string().nullable(),
  bik: z.string().nullable(),
  checkingAccount: z.string().nullable(),
  correspondentAccount: z.string().nullable(),
  directorName: z.string().nullable(),
  directorPosition: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  hasLogo: z.boolean(),
  // Что показывать в PDF смет. Дефолт всё true — можно отключить блоки чтобы
  // не светить банковские реквизиты или контакты клиенту.
  pdfShowLogo: z.boolean(),
  pdfShowAddresses: z.boolean(),
  pdfShowBank: z.boolean(),
  pdfShowDirector: z.boolean(),
  // Срок действия КП в календарных днях. null = не показывать блок «Цены
  // действительны до …» в PDF. Ограничение 1..365 отсекает случайные значения.
  pdfOfferValidityDays: z.number().int().min(1).max(365).nullable(),
});
export type CompanyResponse = z.infer<typeof companyResponseSchema>;

// Ответ upload'а логотипа — сокращённый: клиент обычно всё равно обновит /company целиком.
export const uploadLogoResponseSchema = z.object({
  ok: z.literal(true),
  hasLogo: z.literal(true),
});

// Ответ delete'а — hasLogo=false для симметрии с upload'ом.
export const deleteLogoResponseSchema = z.object({
  ok: z.literal(true),
  hasLogo: z.literal(false),
});

// Допустимые MIME-типы логотипа. Проверяем на приёме, чтобы кто-то не залил
// exe под видом image/png. Фронт должен ресайзить/оптимизировать в один из этих
// форматов перед отправкой.
export const LOGO_ALLOWED_MIME = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type LogoMimeType = (typeof LOGO_ALLOWED_MIME)[number];

export const LOGO_MAX_BYTES = 2 * 1024 * 1024; // 2 МБ

// ── PATCH-body ───────────────────────────────────────────────────
// Семантика partial update:
//   undefined — поле не трогаем;
//   null      — сбрасываем в NULL;
//   string    — записываем (после trim/validate).
// nullish() = optional().nullable(), ровно эти три состояния.
export const patchCompanyBodySchema = z
  .object({
    name: nonEmptyTrimmed(NAME_MAX).optional(),
    legalForm: z.enum(LEGAL_FORMS).nullish(),
    inn: innSchema.nullish(),
    kpp: kppSchema.nullish(),
    ogrn: ogrnSchema.nullish(),
    legalAddress: nonEmptyTrimmed(ADDRESS_MAX).nullish(),
    actualAddress: nonEmptyTrimmed(ADDRESS_MAX).nullish(),
    bankName: nonEmptyTrimmed(BANK_NAME_MAX).nullish(),
    bik: bikSchema.nullish(),
    checkingAccount: accountSchema.nullish(),
    correspondentAccount: accountSchema.nullish(),
    // PDF-флаги: чистый boolean, null не разрешён (сброс в дефолт не нужен —
    // это булев тумблер, а не строковое поле).
    pdfShowLogo: z.boolean().optional(),
    pdfShowAddresses: z.boolean().optional(),
    pdfShowBank: z.boolean().optional(),
    pdfShowDirector: z.boolean().optional(),
    pdfOfferValidityDays: z.number().int().min(1).max(365).nullish(),
    directorName: nonEmptyTrimmed(DIRECTOR_NAME_MAX).nullish(),
    directorPosition: nonEmptyTrimmed(DIRECTOR_POSITION_MAX).nullish(),
    phone: nonEmptyTrimmed(PHONE_MAX).nullish(),
    email: emailSchema.nullish(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: 'Нужно передать хотя бы одно поле для обновления',
  });
export type PatchCompanyBody = z.infer<typeof patchCompanyBodySchema>;
