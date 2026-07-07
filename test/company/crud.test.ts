import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { buildTestApp } from '../setup/build-test-app.js';
import { closeTestDb, truncateAll } from '../setup/test-db.js';
import { registerOwner } from '../projects/helpers.js';

describe('company — GET и PATCH', () => {
  let app: FastifyInstance;

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
  });

  it('GET /company — только что зарегистрированная: name задан, реквизиты null', async () => {
    const { cookie } = await registerOwner(app, {
      email: 'owner@a.com',
      companyName: 'ООО Ромашка',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/company',
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.name).toBe('ООО Ромашка');
    expect(body.legalForm).toBeNull();
    expect(body.inn).toBeNull();
    expect(body.kpp).toBeNull();
    expect(body.ogrn).toBeNull();
    expect(body.legalAddress).toBeNull();
    expect(body.actualAddress).toBeNull();
    expect(body.bankName).toBeNull();
    expect(body.bik).toBeNull();
    expect(body.checkingAccount).toBeNull();
    expect(body.correspondentAccount).toBeNull();
    expect(body.directorName).toBeNull();
    expect(body.directorPosition).toBeNull();
    expect(body.phone).toBeNull();
    expect(body.email).toBeNull();
  });

  it('PATCH /company — обновляет все реквизиты одним запросом', async () => {
    const { cookie } = await registerOwner(app, {
      email: 'owner@b.com',
      companyName: 'ООО Ромашка',
    });

    const patch = {
      legalForm: 'ooo' as const,
      inn: '1234567890',
      kpp: '123456789',
      ogrn: '1234567890123',
      legalAddress: 'г. Москва, ул. Ленина, 1',
      actualAddress: 'г. Москва, ул. Мира, 5',
      bankName: 'Сбербанк',
      bik: '044525225',
      checkingAccount: '40702810900000000001',
      correspondentAccount: '30101810400000000225',
      directorName: 'Иванов Иван Иванович',
      directorPosition: 'Генеральный директор',
      phone: '+7 (495) 123-45-67',
      email: 'info@romashka.ru',
    };

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/company',
      headers: { cookie },
      payload: patch,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    for (const [k, v] of Object.entries(patch)) {
      expect(body[k]).toBe(v);
    }
  });

  it('PATCH /company — частичный: только inn и phone', async () => {
    const { cookie } = await registerOwner(app, { email: 'p@a.com', companyName: 'Partial' });

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/company',
      headers: { cookie },
      payload: { inn: '7707083893', phone: '+79991112233' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.inn).toBe('7707083893');
    expect(body.phone).toBe('+79991112233');
    // Остальные — не тронуты.
    expect(body.kpp).toBeNull();
    expect(body.legalAddress).toBeNull();
  });

  it('PATCH /company — null сбрасывает поле в БД', async () => {
    const { cookie } = await registerOwner(app, { email: 'n@a.com', companyName: 'Nullable' });

    // Сначала записываем.
    await app.inject({
      method: 'PATCH',
      url: '/api/v1/company',
      headers: { cookie },
      payload: { inn: '1234567890' },
    });

    // Потом сбрасываем.
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/company',
      headers: { cookie },
      payload: { inn: null },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().inn).toBeNull();
  });

  it('PATCH /company — переименовать name', async () => {
    const { cookie } = await registerOwner(app, { email: 'r@a.com', companyName: 'Старое имя' });

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/company',
      headers: { cookie },
      payload: { name: 'Новое имя' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('Новое имя');
  });

  it('PATCH /company — пустое тело → 400 (нужно хоть одно поле)', async () => {
    const { cookie } = await registerOwner(app, { email: 'e@a.com', companyName: 'Empty' });

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/company',
      headers: { cookie },
      payload: {},
    });

    expect(res.statusCode).toBe(400);
  });
});
