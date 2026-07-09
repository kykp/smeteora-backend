import { type FastifyBaseLogger } from 'fastify';
import { type EmailSender, type EmailOtpEmail } from './sender.js';

// Dev/test-реализация. Пишет код в лог, чтобы его можно было скопировать
// вручную. Никакого реального SMTP-подключения — работает без сети.
//
// Использование в проде — валидная ошибка конфига (config.ts падает, если
// MAIL_TRANSPORT=smtp без SMTP_*), поэтому проверок «а не прод ли?» здесь нет.
export class ConsoleEmailSender implements EmailSender {
  constructor(private readonly log: FastifyBaseLogger) {}

  async sendEmailOtp(params: EmailOtpEmail): Promise<void> {
    this.log.info(
      { to: params.to, code: params.code, ttlMinutes: params.ttlMinutes },
      '[email] email-otp (console): код ниже, введи его в форме входа',
    );
  }
}
