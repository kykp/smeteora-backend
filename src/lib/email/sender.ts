// Абстракция отправки email. Единственная реализация в проекте у email-OTP,
// но интерфейс общий — потом сюда попадут «сброс пароля», «уведомление о
// платеже», etc. Прод-реализация подменяется через plugins/email.ts на SMTP.

export type EmailOtpEmail = {
  readonly to: string;
  readonly code: string;
  readonly ttlMinutes: number;
};

export interface EmailSender {
  readonly sendEmailOtp: (params: EmailOtpEmail) => Promise<void>;
}
