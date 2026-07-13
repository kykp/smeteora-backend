import { z } from 'zod';

// Единственный вход: тело обращения + опциональный контакт и страница, с
// которой пришли. Никаких user-id/company-id — форма доступна и незалогиненным.
// Ограничения жёсткие: 1..2000 для сообщения, 0..200 для контакта,
// 0..2000 для page (URL целиком). Всё, что длиннее, — обрежется на клиенте,
// но бэк на всякий случай подстраховывается.
export const feedbackBodySchema = z.object({
  message: z.string().trim().min(1, 'Сообщение не может быть пустым').max(2000),
  contact: z.string().trim().max(200).optional(),
  page: z.string().trim().max(2000).optional(),
});

export type FeedbackBody = z.infer<typeof feedbackBodySchema>;

export const feedbackResponseSchema = z.object({
  ok: z.literal(true),
});
