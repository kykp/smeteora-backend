import { type FastifyBaseLogger } from 'fastify';
import { type EmailSender, type EmailOtpEmail } from './sender.js';

// Dev/test-реализация. Не отправляет реальный e-mail — работает без сети.
//
// Раньше писала полный OTP-код на info-уровне. Если MAIL_TRANSPORT=console
// случайно попадёт в staging/prod (или CI с общими логами), любой с доступом
// к стриму сможет забирать коды к целевым email'ам. Теперь на info — только
// адрес и TTL, сам код видно ТОЛЬКО при LOG_LEVEL=trace, который в проде
// никогда не включён.
export class ConsoleEmailSender implements EmailSender {
  constructor(private readonly log: FastifyBaseLogger) {}

  async sendEmailOtp(params: EmailOtpEmail): Promise<void> {
    this.log.info(
      { to: params.to, ttlMinutes: params.ttlMinutes },
      '[email] email-otp (console): код доступен на LOG_LEVEL=trace',
    );
    this.log.trace({ to: params.to, code: params.code }, '[email] email-otp код');
  }
}
