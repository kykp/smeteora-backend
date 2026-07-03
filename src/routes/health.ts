import { z } from 'zod';
import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';

const healthResponseSchema = z.object({
  status: z.literal('ok'),
  uptime: z.number().nonnegative(),
  version: z.string(),
});

export const healthRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/healthz',
    {
      schema: {
        response: { 200: healthResponseSchema },
        tags: ['system'],
        summary: 'Liveness probe',
      },
    },
    () => ({
      status: 'ok' as const,
      uptime: process.uptime(),
      version: app.config.version,
    }),
  );
};
