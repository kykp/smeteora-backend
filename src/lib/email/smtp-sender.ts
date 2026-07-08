import nodemailer, { type Transporter } from 'nodemailer';
import { type EmailSender, type MagicLinkEmail } from './sender.js';

export type SmtpConfig = {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly secure: boolean;
  readonly from: string;
};

// Прод-реализация через SMTP (nodemailer). Провайдер любой: Yandex 360,
// Mail.ru для бизнеса, Mailgun, SendGrid, SES — все дают SMTP-креды.
export class SmtpEmailSender implements EmailSender {
  private readonly transport: Transporter;
  private readonly from: string;

  constructor(cfg: SmtpConfig) {
    this.transport = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: { user: cfg.user, pass: cfg.password },
    });
    this.from = cfg.from;
  }

  async sendMagicLink(params: MagicLinkEmail): Promise<void> {
    const subject = 'Вход в Smeteora — ссылка внутри';
    const text = [
      'Привет!',
      '',
      'Кто-то запросил вход в Smeteora по этому адресу. Если это ты — открой',
      'ссылку ниже. Она живёт следующие ' + params.ttlMinutes + ' минут и работает один раз.',
      '',
      params.link,
      '',
      'Если это не ты — просто проигнорируй письмо, ничего не произойдёт.',
    ].join('\n');

    const html = renderHtml(params.link, params.ttlMinutes);

    await this.transport.sendMail({
      from: this.from,
      to: params.to,
      subject,
      text,
      html,
    });
  }
}

// Инлайновая HTML-вёрстка — почтовые клиенты душат внешние стили,
// поэтому всё сразу в атрибутах и минимально.
const renderHtml = (link: string, ttlMinutes: number): string => `
<!doctype html>
<html lang="ru"><head><meta charset="utf-8"/></head>
<body style="font-family: -apple-system, Segoe UI, Roboto, Arial, sans-serif; background:#f7f8fa; margin:0; padding:32px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px; margin:0 auto; background:#ffffff; border-radius:12px; padding:32px;">
    <tr><td>
      <div style="font-size:22px; font-weight:800; color:#0f172a; margin-bottom:16px;">Вход в Smeteora</div>
      <p style="color:#334155; font-size:15px; line-height:1.5; margin:0 0 24px;">
        Кто-то запросил вход по этому адресу. Если это ты — нажми кнопку ниже.
        Ссылка живёт ${ttlMinutes} минут и работает один раз.
      </p>
      <p style="margin:0 0 24px;">
        <a href="${link}" style="display:inline-block; background:#2563eb; color:#ffffff; text-decoration:none; padding:12px 20px; border-radius:8px; font-weight:600;">
          Открыть Smeteora
        </a>
      </p>
      <p style="color:#64748b; font-size:13px; line-height:1.5; margin:0;">
        Кнопка не работает? Скопируй адрес и открой в браузере:<br/>
        <span style="color:#2563eb; word-break:break-all;">${link}</span>
      </p>
      <hr style="border:none; border-top:1px solid #e2e5ea; margin:24px 0;"/>
      <p style="color:#94a3b8; font-size:12px; line-height:1.5; margin:0;">
        Если письмо пришло по ошибке — просто удали его. Никаких действий с твоей учётной записью не произойдёт.
      </p>
    </td></tr>
  </table>
</body></html>`;
