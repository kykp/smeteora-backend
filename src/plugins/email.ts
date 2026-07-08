import fp from 'fastify-plugin';
import { type FastifyPluginAsync } from 'fastify';
import { ConsoleEmailSender } from '../lib/email/console-sender.js';
import { SmtpEmailSender } from '../lib/email/smtp-sender.js';
import { type EmailSender } from '../lib/email/sender.js';

// Регистрирует app.email: EmailSender. Реализация выбирается по MAIL_TRANSPORT.
// В тестах можно подменить через overrides.emailSender (см. app.ts BuildAppOverrides).
declare module 'fastify' {
  interface FastifyInstance {
    email: EmailSender;
  }
}

const emailPlugin: FastifyPluginAsync = async (app) => {
  if (app.config.MAIL_TRANSPORT === 'smtp') {
    // Наличие всех SMTP_* уже проверено в config.ts, но TS не знает про refine.
    const host = app.config.SMTP_HOST;
    const port = app.config.SMTP_PORT;
    const user = app.config.SMTP_USER;
    const password = app.config.SMTP_PASSWORD;
    if (!host || !port || !user || !password) {
      throw new Error('SMTP-креды не полны — проверьте config');
    }
    app.decorate(
      'email',
      new SmtpEmailSender({
        host,
        port,
        user,
        password,
        secure: app.config.SMTP_SECURE,
        from: app.config.MAIL_FROM,
      }),
    );
  } else {
    app.decorate('email', new ConsoleEmailSender(app.log));
  }
};

export default fp(emailPlugin, { name: 'email', dependencies: [] });
