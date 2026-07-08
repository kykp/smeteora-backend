// Типизированная иерархия доменных ошибок.
// Service бросает подкласс DomainError, единый error handler в app.ts
// маппит его на HTTP-ответ { error: { code, message } }.
//
// Наружу — только code и message. Никаких stacktrace в prod.

export type ErrorCode =
  | 'not_found'
  | 'forbidden'
  | 'unauthorized'
  | 'validation'
  | 'conflict'
  | 'payload_too_large'
  | 'rate_limited'
  | 'internal_error';

const STATUS_BY_CODE: Readonly<Record<ErrorCode, number>> = Object.freeze({
  not_found: 404,
  forbidden: 403,
  unauthorized: 401,
  validation: 400,
  conflict: 409,
  payload_too_large: 413,
  rate_limited: 429,
  internal_error: 500,
});

export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.statusCode = STATUS_BY_CODE[code];
  }
}

// Ресурс отсутствует ИЛИ существует, но не принадлежит компании юзера.
// Для cross-tenant ситуаций возвращаем именно 404 (а не 403), чтобы не
// подтверждать существование чужих ресурсов.
export class NotFoundError extends DomainError {
  constructor(message = 'Ресурс не найден') {
    super('not_found', message);
  }
}

// Юзер аутентифицирован, но роль не позволяет операцию.
// Пример: viewer пытается POST /projects.
export class ForbiddenError extends DomainError {
  constructor(message = 'Недостаточно прав для операции') {
    super('forbidden', message);
  }
}

// Юзер не аутентифицирован ИЛИ session/membership недействительны.
// Пример: нет cookie, session revoked, membership disabled.
export class UnauthorizedError extends DomainError {
  constructor(message = 'Требуется авторизация') {
    super('unauthorized', message);
  }
}

// Данные запроса не проходят бизнес-валидацию (не структурную — её ловит zod).
// Пример: попытка изменить роль последнего owner'а компании.
export class ValidationError extends DomainError {
  constructor(message: string) {
    super('validation', message);
  }
}

// Нарушено уникальное ограничение или семантический конфликт.
// Пример: регистрация с уже занятым email.
export class ConflictError extends DomainError {
  constructor(message: string) {
    super('conflict', message);
  }
}

export class RateLimitError extends DomainError {
  constructor(message = 'Слишком много попыток, повторите позже') {
    super('rate_limited', message);
  }
}

// Тело запроса (обычно multipart-файл) превышает разрешённый размер.
// Используется когда сервер сам режет большой аплоад — семантически это 413,
// а не 400 (валидация тела было бы 400, а «слишком много байт» — 413).
export class PayloadTooLargeError extends DomainError {
  constructor(message: string) {
    super('payload_too_large', message);
  }
}
