import nodemailer, { type Transporter } from 'nodemailer';
import { type EmailSender, type EmailOtpEmail } from './sender.js';

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

  async sendEmailOtp(params: EmailOtpEmail): Promise<void> {
    const subject = `Код для входа в Smeteora: ${params.code}`;
    const text = [
      'Привет!',
      '',
      'Кто-то запросил вход в Smeteora по этому адресу. Если это ты — введи',
      'в форме входа этот код:',
      '',
      '    ' + params.code,
      '',
      'Код живёт следующие ' + params.ttlMinutes + ' минут и работает один раз.',
      '',
      'Если это не ты — просто проигнорируй письмо, ничего не произойдёт.',
    ].join('\n');

    const html = renderHtml(params.code, params.ttlMinutes);

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
const renderHtml = (code: string, ttlMinutes: number): string => `
<!doctype html>
<html lang="ru"><head><meta charset="utf-8"/></head>
<body style="font-family: -apple-system, Segoe UI, Roboto, Arial, sans-serif; background:#f7f8fa; margin:0; padding:32px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px; margin:0 auto; background:#ffffff; border-radius:12px; padding:32px;">
    <tr><td>
      <div style="font-size:22px; font-weight:800; color:#0f172a; margin-bottom:16px;">Вход в Smeteora</div>
      <p style="color:#334155; font-size:15px; line-height:1.5; margin:0 0 24px;">
        Кто-то запросил вход по этому адресу. Если это ты — введи код ниже в
        форме входа. Код живёт ${ttlMinutes} минут и работает один раз.
      </p>
      <div style="margin:0 0 24px; text-align:center;">
        <div style="display:inline-block; background:#f1f5f9; color:#0f172a; padding:16px 24px; border-radius:8px; font-family: 'SF Mono', Menlo, Consolas, monospace; font-size:32px; font-weight:700; letter-spacing:8px;">
          ${code}
        </div>
      </div>
      <hr style="border:none; border-top:1px solid #e2e5ea; margin:24px 0;"/>
      <p style="color:#94a3b8; font-size:12px; line-height:1.5; margin:0;">
        Если письмо пришло по ошибке — просто удали его. Никаких действий с твоей учётной записью не произойдёт.
      </p>
    </td></tr>
  </table>
</body></html>`;
