import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';

import { feedbackBodySchema, feedbackResponseSchema } from './schema.js';
import { sendFeedbackToTelegram } from './service.js';

// Публичный эндпоинт: форма фидбэка доступна и незалогиненным.
// Жёсткий per-IP rate-limit (5/мин) — иначе бот открыт для флуда.
// Токен и chat_id Telegram — только в бэковом env, на клиент не уходят.
export const feedbackRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/',
    {
      config: {
        rateLimit: {
          max: 5,
          timeWindow: '1 minute',
        },
      },
      schema: {
        body: feedbackBodySchema,
        response: {
          200: feedbackResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const tg =
        app.config.TG_BOT_TOKEN && app.config.TG_CHAT_ID
          ? { botToken: app.config.TG_BOT_TOKEN, chatId: app.config.TG_CHAT_ID }
          : null;
      await sendFeedbackToTelegram(request.body, tg, request.log);
      return reply.status(200).send({ ok: true as const });
    },
  );
};
