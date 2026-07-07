import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { buildTestApp } from '../setup/build-test-app.js';
import { closeTestDb, truncateAll } from '../setup/test-db.js';
import { registerOwner } from '../projects/helpers.js';

describe('company — валидация реквизитов', () => {
  let app: FastifyInstance;
  let cookie: string;

  beforeAll(async () => {
    app = await buildTestApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  beforeEach(async () => {
    await truncateAll();
    const owner = await registerOwner(app, { email: 'v@a.com', companyName: 'Valid' });
    cookie = owner.cookie;
  });

  const bad = async (payload: Record<string, unknown>): Promise<number> => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/company',
      headers: { cookie },
      payload,
    });
    return res.statusCode;
  };

  it('ИНН: 10 цифр → OK; 11 → 400; буквы → 400', async () => {
    expect(await bad({ inn: '1234567890' })).toBe(200);
    expect(await bad({ inn: '12345678901' })).toBe(400);
    expect(await bad({ inn: '123456789a' })).toBe(400);
  });

  it('ИНН: 12 цифр → OK (ИП)', async () => {
    expect(await bad({ inn: '123456789012' })).toBe(200);
  });

  it('КПП: 9 цифр → OK; 8/10 цифр → 400', async () => {
    expect(await bad({ kpp: '123456789' })).toBe(200);
    expect(await bad({ kpp: '12345678' })).toBe(400);
    expect(await bad({ kpp: '1234567890' })).toBe(400);
  });

  it('ОГРН: 13 (ЮЛ) и 15 (ИП) → OK; 14 → 400', async () => {
    expect(await bad({ ogrn: '1234567890123' })).toBe(200);
    expect(await bad({ ogrn: '123456789012345' })).toBe(200);
    expect(await bad({ ogrn: '12345678901234' })).toBe(400);
  });

  it('БИК: 9 цифр → OK', async () => {
    expect(await bad({ bik: '044525225' })).toBe(200);
    expect(await bad({ bik: '0445252' })).toBe(400);
  });

  it('Расчётный счёт: 20 цифр → OK', async () => {
    expect(await bad({ checkingAccount: '40702810900000000001' })).toBe(200);
    expect(await bad({ checkingAccount: '4070281' })).toBe(400);
  });

  it('legalForm: только из enum', async () => {
    expect(await bad({ legalForm: 'ooo' })).toBe(200);
    expect(await bad({ legalForm: 'ip' })).toBe(200);
    expect(await bad({ legalForm: 'self-employed' })).toBe(200);
    expect(await bad({ legalForm: 'ao' })).toBe(200);
    expect(await bad({ legalForm: 'zao' })).toBe(400);
  });

  it('email: некорректный → 400', async () => {
    expect(await bad({ email: 'not-an-email' })).toBe(400);
    expect(await bad({ email: 'valid@example.com' })).toBe(200);
  });

  it('name из пробелов → 400 (после trim пусто)', async () => {
    expect(await bad({ name: '   ' })).toBe(400);
  });
});
