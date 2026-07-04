// Реэкспорт zod-схем контракта invitations из @smeteora/shared.

export {
  invitationSchema,
  createInvitationBodySchema,
  createInvitationResponseSchema,
  listInvitationsQuerySchema,
  listInvitationsResponseSchema,
  invitationIdParamSchema,
  revokeInvitationResponseSchema,
  previewInvitationBodySchema,
  previewInvitationResponseSchema,
  acceptInvitationBodySchema,
  INVITABLE_ROLES,
  INVITATION_STATUSES,
  INVITATION_TTL_DAYS,
  INVITATIONS_BASE_PATH,
} from '@smeteora/shared';

export type {
  InvitationDto,
  CreateInvitationBody,
  CreateInvitationResponse,
  ListInvitationsQuery,
  ListInvitationsResponse,
  PreviewInvitationBody,
  PreviewInvitationResponse,
  AcceptInvitationBody,
  InvitableRole,
  InvitationStatus,
} from '@smeteora/shared';

// Ответ на accept тот же что у auth: user + company + role + memberships.
export { authUserResponseSchema } from '../auth/schema.js';
export type { AuthUserResponse } from '../auth/schema.js';
