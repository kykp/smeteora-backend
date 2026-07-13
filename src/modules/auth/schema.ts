import { z } from 'zod';
import { ROLES } from '../../db/constants.js';

const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 200;
const EMAIL_MAX_LENGTH = 254;
const COMPANY_NAME_MIN = 2;
const COMPANY_NAME_MAX = 200;
const USER_NAME_MAX = 200;

const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(EMAIL_MAX_LENGTH)
  .email('Некорректный email');

const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Пароль должен быть ≥ ${PASSWORD_MIN_LENGTH} символов`)
  .max(PASSWORD_MAX_LENGTH);

// ── Register ──

export const registerBodySchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  companyName: z.string().trim().min(COMPANY_NAME_MIN).max(COMPANY_NAME_MAX),
  userName: z.string().trim().min(1).max(USER_NAME_MAX).optional(),
});
export type RegisterBody = z.infer<typeof registerBodySchema>;

// ── Login ──

export const loginBodySchema = z.object({
  email: emailSchema,
  password: passwordSchema,
});
export type LoginBody = z.infer<typeof loginBodySchema>;

// ── Switch company ──

export const switchCompanyBodySchema = z.object({
  membershipId: z.string().uuid(),
});
export type SwitchCompanyBody = z.infer<typeof switchCompanyBodySchema>;

// ── Update self (PATCH /me) ──
// Пока только name. Email и смена компании — отдельные флоу.
export const updateMeBodySchema = z
  .object({
    // undefined → не трогаем; null → сбрасываем; string → записываем (после trim).
    name: z.string().trim().min(1).max(USER_NAME_MAX).nullish(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: 'Нужно передать хотя бы одно поле для обновления',
  });
export type UpdateMeBody = z.infer<typeof updateMeBodySchema>;

// ── Change password ──
// currentPassword обязателен: подтверждаем что запрос от реального владельца
// (а не от подхваченной чужой session). newPassword — те же правила минимальной
// длины что и при регистрации.
export const changePasswordBodySchema = z.object({
  currentPassword: passwordSchema,
  newPassword: passwordSchema,
});
export type ChangePasswordBody = z.infer<typeof changePasswordBodySchema>;

// ── Responses ──

// Общий ответ на успешный auth-flow — что бы клиент не путался в форматах.
// company_id наружу НЕ отдаём (нельзя догадываться о существовании чужих
// компаний). Активная membership идентифицируется через её id — фронт
// использует его для switch-company API и для матча при апдейтах.
export const authUserResponseSchema = z.object({
  user: z.object({
    id: z.string().uuid(),
    email: z.string(),
    name: z.string().nullable(),
  }),
  company: z.object({
    name: z.string(),
  }),
  role: z.enum(ROLES),
  activeMembershipId: z.string().uuid(),
  memberships: z.array(
    z.object({
      id: z.string().uuid(),
      companyName: z.string(),
      role: z.enum(ROLES),
      isActive: z.boolean(),
    }),
  ),
});
export type AuthUserResponse = z.infer<typeof authUserResponseSchema>;

export const okResponseSchema = z.object({ ok: z.literal(true) });
