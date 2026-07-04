import { createHash, randomBytes } from 'node:crypto';

// Плоский токен: 32 crypto-байта → base64url ≈ 43 символа.
// Показывается пользователю ровно один раз (в ответе POST /invitations),
// на бэке хранится только sha256-хеш.
const TOKEN_BYTES = 32;

export const generateInvitationToken = (): string => randomBytes(TOKEN_BYTES).toString('base64url');

// Обычный sha256 (не argon2): токен уже 256 бит энтропии, brute-force
// не имеет смысла. Быстрый хеш нужен для точного lookup в БД.
export const hashInvitationToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');
