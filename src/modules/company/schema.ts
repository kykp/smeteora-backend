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
});
export type CompanyResponse = z.infer<typeof companyResponseSchema>;

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
    directorName: nonEmptyTrimmed(DIRECTOR_NAME_MAX).nullish(),
    directorPosition: nonEmptyTrimmed(DIRECTOR_POSITION_MAX).nullish(),
    phone: nonEmptyTrimmed(PHONE_MAX).nullish(),
    email: emailSchema.nullish(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: 'Нужно передать хотя бы одно поле для обновления',
  });
export type PatchCompanyBody = z.infer<typeof patchCompanyBodySchema>;
