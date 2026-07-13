import { z } from 'zod';

// Приглашения — контракт /api/v1/invitations.
// Двухканальный доступ: авторизованные admin+ управляют своими приглашениями,
// анонимный получатель ходит через preview/accept с плоским токеном.

// Роли, которые можно назначить приглашённому. Owner исключён — это отдельный
// флоу передачи владения, не через invitations.
export const INVITABLE_ROLES = ['viewer', 'member', 'admin'] as const;
export type InvitableRole = (typeof INVITABLE_ROLES)[number];

export const INVITATION_STATUSES = ['pending', 'accepted', 'revoked', 'expired'] as const;
export type InvitationStatus = (typeof INVITATION_STATUSES)[number];

export const INVITATION_TTL_DAYS = 7;

const EMAIL_MAX = 254;
const USER_NAME_MAX = 200;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 200;

const emailSchema = z.string().trim().toLowerCase().max(EMAIL_MAX).email('Некорректный email');
const passwordSchema = z
  .string()
  .min(PASSWORD_MIN, `Пароль должен быть ≥ ${PASSWORD_MIN} символов`)
  .max(PASSWORD_MAX);

// ── DTO ─────────────────────────────────────────────────────────
// В админском ответе показываем всю запись (кроме token_hash). В preview
// отдельный минимальный DTO — только то что нужно для рендера accept-страницы.

// companyId наружу НЕ отдаём — админ и так знает свою компанию через
// /auth/me (см. authUserResponseSchema.company), а для инвайти endpoint'ы
// preview/accept/reject берут companyId сами из token'а.
export const invitationSchema = z.object({
  id: z.string().uuid(),
  email: z.string(),
  role: z.enum(INVITABLE_ROLES),
  status: z.enum(INVITATION_STATUSES),
  invitedByUserId: z.string().uuid().nullable(),
  expiresAt: z.string().datetime(),
  acceptedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export type InvitationDto = z.infer<typeof invitationSchema>;

// ── Create ──────────────────────────────────────────────────────

export const createInvitationBodySchema = z.object({
  email: emailSchema,
  role: z.enum(INVITABLE_ROLES),
});
export type CreateInvitationBody = z.infer<typeof createInvitationBodySchema>;

export const createInvitationResponseSchema = z.object({
  invitation: invitationSchema,
  // Плоский токен показываем ровно один раз. Фронт передаст приглашённому:
  // через email, копипаст, QR — как удобно.
  token: z.string(),
  // Готовая URL если фронт хочет просто дать её пользователю.
  acceptUrl: z.string().url(),
});
export type CreateInvitationResponse = z.infer<typeof createInvitationResponseSchema>;

// ── List ────────────────────────────────────────────────────────

export const INVITATION_LIST_DEFAULT_LIMIT = 20;
export const INVITATION_LIST_MAX_LIMIT = 100;

export const listInvitationsQuerySchema = z.object({
  status: z.enum(INVITATION_STATUSES).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(INVITATION_LIST_MAX_LIMIT)
    .default(INVITATION_LIST_DEFAULT_LIMIT),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListInvitationsQuery = z.infer<typeof listInvitationsQuerySchema>;

export const listInvitationsResponseSchema = z.object({
  items: z.array(invitationSchema),
  total: z.number().int().min(0),
  limit: z.number().int().min(1),
  offset: z.number().int().min(0),
});
export type ListInvitationsResponse = z.infer<typeof listInvitationsResponseSchema>;

// ── Revoke ──────────────────────────────────────────────────────

export const invitationIdParamSchema = z.object({
  id: z.string().uuid(),
});

export const revokeInvitationResponseSchema = z.object({ ok: z.literal(true) });

// ── Preview (анонимный) ─────────────────────────────────────────

export const previewInvitationBodySchema = z.object({
  token: z.string().min(20).max(200),
});
export type PreviewInvitationBody = z.infer<typeof previewInvitationBodySchema>;

export const previewInvitationResponseSchema = z.object({
  companyName: z.string(),
  role: z.enum(INVITABLE_ROLES),
  email: z.string(),
  // Есть ли уже учётка с этим email — для UI, чтобы решить показывать поле пароля.
  userExists: z.boolean(),
});
export type PreviewInvitationResponse = z.infer<typeof previewInvitationResponseSchema>;

// ── Accept (анонимный) ──────────────────────────────────────────

export const acceptInvitationBodySchema = z.object({
  token: z.string().min(20).max(200),
  // Обязательны только для нового юзера. Валидируем поверх в service (если userExists и
  // password передан — просто игнорим; если !userExists и не передан — 400).
  password: passwordSchema.optional(),
  userName: z.string().trim().min(1).max(USER_NAME_MAX).optional(),
});
export type AcceptInvitationBody = z.infer<typeof acceptInvitationBodySchema>;

// Ответ — тот же shape что /me и login: юзер + активная компания + все memberships.
// Схему шарим из auth-контракта в будущем; пока дублируем локально.
// TODO: вынести authUserResponseSchema в shared когда будем делать frontend SDK.

// ── Пути ────────────────────────────────────────────────────────

export const INVITATIONS_BASE_PATH = '/invitations';

export const invitationsPaths = Object.freeze({
  create: INVITATIONS_BASE_PATH,
  list: INVITATIONS_BASE_PATH,
  revoke: (id: string): string => `${INVITATIONS_BASE_PATH}/${id}/revoke`,
  preview: `${INVITATIONS_BASE_PATH}/preview`,
  accept: `${INVITATIONS_BASE_PATH}/accept`,
});
