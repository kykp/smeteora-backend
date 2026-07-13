import type { FastifyBaseLogger } from 'fastify';

import { ValidationError } from '../../lib/errors.js';

import type { FeedbackBody } from './schema.js';

// Экранирование под Telegram parse_mode=HTML — только те три символа,
// что имеют смысл в HTML-подмножестве Telegram (см. docs.telegram-bot).
const escapeHtml = (raw: string): string =>
  raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const TELEGRAM_TIMEOUT_MS = 8_000;

type TelegramConfig = {
  botToken: string;
  chatId: string;
};

const buildText = (payload: FeedbackBody): string => {
  const lines = [
    '🔔 <b>Обратная связь · Smeteora</b>',
    '',
    escapeHtml(payload.message),
    '',
    `<b>Контакт:</b> ${payload.contact ? escapeHtml(payload.contact) : 'не указан'}`,
    `<b>Страница:</b> ${payload.page ? escapeHtml(payload.page) : 'не указана'}`,
  ];
  return lines.join('\n');
};

// Отправляет обращение в Telegram. Токен и chat-id читаются из env бэка —
// на клиент они не уходят. Метод AbortController + таймаут — обязательно
// по CLAUDE.md для любого внешнего HTTP.
export const sendFeedbackToTelegram = async (
  payload: FeedbackBody,
  tg: TelegramConfig | null,
  log: FastifyBaseLogger,
): Promise<void> => {
  if (!tg) {
    // Канал не настроен — 400, а не 500: это конфиг продукта, а не сбой.
    throw new ValidationError('Канал обратной связи не настроен');
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TELEGRAM_TIMEOUT_MS);
  try {
    const res = await fetch(`https://api.telegram.org/bot${tg.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: tg.chatId,
        text: buildText(payload),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      // Тело Telegram-ошибки читаем для логов, наружу не отдаём (уйдёт в 500).
      const body = await res.text().catch(() => '');
      log.error({ status: res.status, body }, 'telegram sendMessage не удалось');
      throw new Error(`telegram sendMessage вернул ${res.status}`);
    }
  } catch (err) {
    if (err instanceof ValidationError) throw err;
    // Сетевые ошибки/таймауты — логируем и пробрасываем как generic 500.
    log.error({ err }, 'ошибка сети при отправке в telegram');
    throw new Error('telegram sendMessage: сетевая ошибка');
  } finally {
    clearTimeout(timer);
  }
};
