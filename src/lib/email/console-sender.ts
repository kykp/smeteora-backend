import { type FastifyBaseLogger } from 'fastify';
import { type EmailSender, type MagicLinkEmail } from './sender.js';

// Dev/test-реализация. Пишет ссылку в лог, чтобы её можно было скопировать
// вручную. Никакого реального SMTP-подключения — работает без сети.
//
// Использование в проде — валидная ошибка конфига (config.ts падает, если
// MAIL_TRANSPORT=smtp без SMTP_*), поэтому проверок «а не прод ли?» здесь нет.
export class ConsoleEmailSender implements EmailSender {
  constructor(private readonly log: FastifyBaseLogger) {}

  async sendMagicLink(params: MagicLinkEmail): Promise<void> {
    this.log.info(
      { to: params.to, link: params.link, ttlMinutes: params.ttlMinutes },
      '[email] magic-link (console): ссылка ниже, скопируй и открой в браузере',
    );
  }
}
