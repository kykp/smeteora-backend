import { randomUUID } from 'node:crypto';
import { type FastifyInstance } from 'fastify';

export const createProjectViaApi = async (
  app: FastifyInstance,
  params: { cookie: string; name?: string },
): Promise<{ id: string }> => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/projects',
    headers: { cookie: params.cookie },
    payload: { name: params.name ?? 'Проект' },
  });
  if (res.statusCode !== 201) {
    throw new Error(`create project вернул ${res.statusCode}: ${res.body}`);
  }
  return { id: res.json().id };
};

export const createEmptyEstimate = async (
  app: FastifyInstance,
  params: {
    cookie: string;
    projectId: string;
    title?: string;
    vatMode?: 'none' | 'included' | 'added';
    vatRate?: string;
  },
): Promise<{ id: string }> => {
  const payload: Record<string, unknown> = {
    projectId: params.projectId,
    title: params.title ?? 'Смета',
  };
  if (params.vatMode) payload['vatMode'] = params.vatMode;
  if (params.vatRate) payload['vatRate'] = params.vatRate;

  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/estimates',
    headers: { cookie: params.cookie },
    payload,
  });
  if (res.statusCode !== 201) {
    throw new Error(`create estimate вернул ${res.statusCode}: ${res.body}`);
  }
  return { id: res.json().estimate.id };
};

// Клиент сам генерит uuid — таким же будет id в БД.
export const makeSectionId = (): string => randomUUID();
export const makeLineItemId = (): string => randomUUID();
