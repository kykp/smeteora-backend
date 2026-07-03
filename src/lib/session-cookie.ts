import { type CookieSerializeOptions } from '@fastify/cookie';
import { type Config } from '../config.js';

export const SESSION_COOKIE_NAME = 'smt_session';

const DAY_MS = 24 * 60 * 60 * 1000;

export const sessionCookieOptions = (config: Config): CookieSerializeOptions => ({
  httpOnly: true,
  secure: config.NODE_ENV === 'production',
  sameSite: 'strict',
  path: '/',
  signed: true,
  maxAge: config.SESSION_TTL_DAYS * DAY_MS,
  ...(config.COOKIE_DOMAIN ? { domain: config.COOKIE_DOMAIN } : {}),
});

// Опции для удаления cookie при logout. maxAge=0 + expires в прошлом.
export const clearSessionCookieOptions = (config: Config): CookieSerializeOptions => ({
  httpOnly: true,
  secure: config.NODE_ENV === 'production',
  sameSite: 'strict',
  path: '/',
  maxAge: 0,
  ...(config.COOKIE_DOMAIN ? { domain: config.COOKIE_DOMAIN } : {}),
});
