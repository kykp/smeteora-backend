import { type FastifyInstance } from 'fastify';
import { registerOwner } from '../projects/helpers.js';

// Реэкспорт — используем те же общие хелперы что у projects.
export { registerOwner, addMembership, switchTo } from '../projects/helpers.js';

// Создать приглашение через API. Возвращает { invitationId, token, acceptUrl }.
export const createInvitationViaApi = async (
  app: FastifyInstance,
  params: { cookie: string; email: string; role: 'viewer' | 'member' | 'admin' },
): Promise<{ invitationId: string; token: string; acceptUrl: string }> => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/invitations',
    headers: { cookie: params.cookie },
    payload: { email: params.email, role: params.role },
  });
  if (res.statusCode !== 201) {
    throw new Error(`create invitation вернул ${res.statusCode}: ${res.body}`);
  }
  const body = res.json();
  return {
    invitationId: body.invitation.id,
    token: body.token,
    acceptUrl: body.acceptUrl,
  };
};

// Создать owner-компанию + сразу сгенерировать приглашение.
// Часто нужен паттерн: есть компания-приглашающий, есть pending-приглашение,
// проверяем что происходит когда получатель ходит по флоу.
export const setupCompanyWithInvitation = async (
  app: FastifyInstance,
  params: {
    ownerEmail: string;
    companyName: string;
    inviteeEmail: string;
    role: 'viewer' | 'member' | 'admin';
  },
): Promise<{
  ownerCookie: string;
  ownerCompanyId: string;
  invitationId: string;
  token: string;
}> => {
  const owner = await registerOwner(app, {
    email: params.ownerEmail,
    companyName: params.companyName,
  });
  const inv = await createInvitationViaApi(app, {
    cookie: owner.cookie,
    email: params.inviteeEmail,
    role: params.role,
  });
  return {
    ownerCookie: owner.cookie,
    ownerCompanyId: owner.companyId,
    invitationId: inv.invitationId,
    token: inv.token,
  };
};
