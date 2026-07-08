// Абстракция отправки email. Единственная реализация в проекте у magic-link,
// но интерфейс общий — потом сюда попадут «сброс пароля», «уведомление о
// платеже», etc. Прод-реализация подменяется через plugins/email.ts на SMTP.

export type MagicLinkEmail = {
  readonly to: string;
  readonly link: string;
  readonly ttlMinutes: number;
};

export interface EmailSender {
  readonly sendMagicLink: (params: MagicLinkEmail) => Promise<void>;
}
