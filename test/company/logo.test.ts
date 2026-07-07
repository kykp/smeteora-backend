import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { buildTestApp } from '../setup/build-test-app.js';
import { closeTestDb, truncateAll } from '../setup/test-db.js';
import { registerOwner, addMembership, switchTo } from '../projects/helpers.js';

// Собирает multipart-body руками. fastify.inject не умеет FormData, но
// принимает сырую строку/буфер с corresponding Content-Type header.
const buildMultipartBody = (
  fieldName: string,
  filename: string,
  contentType: string,
  fileData: Buffer,
): { body: Buffer; contentType: string } => {
  const boundary = `----smeteoraTest${Math.floor(Math.random() * 1e9)}`;
  const preamble = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`,
  );
  const epilogue = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    body: Buffer.concat([preamble, fileData, epilogue]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
};

// Валидный минимальный PNG — 8 байт сигнатуры + IHDR + IDAT + IEND.
// Достаточно чтобы Fastify его прочитал; MIME определяем из Content-Type multipart-поля.
const smallPng = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4' +
    '890000000d49444154789c626000000000ffff03000006000557bf0d7a0000' +
    '00004945' +
    '4e44ae426082',
  'hex',
);

const uploadLogo = async (
  app: FastifyInstance,
  cookie: string,
  overrides: Partial<{ contentType: string; data: Buffer; filename: string }> = {},
) => {
  const contentType = overrides.contentType ?? 'image/png';
  const data = overrides.data ?? smallPng;
  const filename = overrides.filename ?? 'logo.png';
  const mp = buildMultipartBody('logo', filename, contentType, data);
  return app.inject({
    method: 'POST',
    url: '/api/v1/company/logo',
    headers: { cookie, 'content-type': mp.contentType },
    payload: mp.body,
  });
};

describe('company logo — upload / get / delete', () => {
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

  it('POST /company/logo — happy path: 200 + hasLogo=true в GET /company', async () => {
    const { cookie } = await registerOwner(app, { email: 'a@a.com', companyName: 'Логотипная' });

    const upload = await uploadLogo(app, cookie);
    expect(upload.statusCode).toBe(200);
    expect(upload.json()).toEqual({ ok: true, hasLogo: true });

    const info = await app.inject({ method: 'GET', url: '/api/v1/company', headers: { cookie } });
    expect(info.statusCode).toBe(200);
    expect(info.json().hasLogo).toBe(true);
  });

  it('GET /company/logo — отдаёт бинарник с корректным Content-Type', async () => {
    const { cookie } = await registerOwner(app, { email: 'g@a.com', companyName: 'Гет' });
    await uploadLogo(app, cookie);

    const get = await app.inject({
      method: 'GET',
      url: '/api/v1/company/logo',
      headers: { cookie },
    });
    expect(get.statusCode).toBe(200);
    expect(get.headers['content-type']).toBe('image/png');
    // rawPayload — Buffer, при сравнении длина должна совпадать с загруженной.
    expect(Buffer.from(get.rawPayload).length).toBe(smallPng.length);
  });

  it('GET /company/logo — без установленного логотипа → 404', async () => {
    const { cookie } = await registerOwner(app, { email: 'n@a.com', companyName: 'НетЛого' });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/company/logo',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it('DELETE /company/logo — сбрасывает hasLogo в false', async () => {
    const { cookie } = await registerOwner(app, { email: 'd@a.com', companyName: 'Del' });
    await uploadLogo(app, cookie);

    const del = await app.inject({
      method: 'DELETE',
      url: '/api/v1/company/logo',
      headers: { cookie },
    });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ ok: true, hasLogo: false });

    const info = await app.inject({ method: 'GET', url: '/api/v1/company', headers: { cookie } });
    expect(info.json().hasLogo).toBe(false);
  });

  it('DELETE /company/logo — идемпотентно: 200 если логотипа не было', async () => {
    const { cookie } = await registerOwner(app, { email: 'i@a.com', companyName: 'Idempo' });
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/company/logo',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
  });

  it('POST — MIME не image/png|jpeg|webp → 400', async () => {
    const { cookie } = await registerOwner(app, { email: 'm@a.com', companyName: 'MIME' });
    const res = await uploadLogo(app, cookie, {
      contentType: 'application/pdf',
      filename: 'evil.pdf',
      data: Buffer.from('not a png'),
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST — jpeg и webp — OK', async () => {
    const { cookie } = await registerOwner(app, { email: 'j@a.com', companyName: 'JW' });
    const jpg = await uploadLogo(app, cookie, {
      contentType: 'image/jpeg',
      filename: 'logo.jpg',
    });
    expect(jpg.statusCode).toBe(200);
    const webp = await uploadLogo(app, cookie, {
      contentType: 'image/webp',
      filename: 'logo.webp',
    });
    expect(webp.statusCode).toBe(200);
  });

  it('POST — пустой файл → 400', async () => {
    const { cookie } = await registerOwner(app, { email: 'e@a.com', companyName: 'Пусто' });
    const res = await uploadLogo(app, cookie, { data: Buffer.alloc(0) });
    expect(res.statusCode).toBe(400);
  });

  it('POST — файл > 2 МБ → 413 Payload Too Large', async () => {
    const { cookie } = await registerOwner(app, { email: 'big@a.com', companyName: 'Big' });
    const oversized = Buffer.alloc(3 * 1024 * 1024, 0xff);
    const res = await uploadLogo(app, cookie, { data: oversized });
    // fastify-multipart отдаёт 413 при превышении limits.fileSize —
    // это семантически корректный статус для "too large".
    expect(res.statusCode).toBe(413);
  });

  it('viewer не может POST → 403; но может GET после того как admin загрузил', async () => {
    const a = await registerOwner(app, { email: 'a2@a.com', companyName: 'AA' });
    const b = await registerOwner(app, { email: 'b2@b.com', companyName: 'BB' });
    const viewer = await addMembership({
      userId: b.userId,
      companyId: a.companyId,
      role: 'viewer',
    });
    await switchTo(app, { cookie: b.cookie, membershipId: viewer.id });

    const post = await uploadLogo(app, b.cookie);
    expect(post.statusCode).toBe(403);

    // Admin компании A заливает.
    await uploadLogo(app, a.cookie);
    // Теперь viewer из компании A может GET.
    const get = await app.inject({
      method: 'GET',
      url: '/api/v1/company/logo',
      headers: { cookie: b.cookie },
    });
    expect(get.statusCode).toBe(200);
  });

  it('cross-tenant: юзер А не видит логотип компании Б', async () => {
    const a = await registerOwner(app, { email: 'x@x.com', companyName: 'XX' });
    const b = await registerOwner(app, { email: 'y@y.com', companyName: 'YY' });
    await uploadLogo(app, b.cookie);

    // A → GET своего логотипа → 404 (не установлен у A).
    const aRes = await app.inject({
      method: 'GET',
      url: '/api/v1/company/logo',
      headers: { cookie: a.cookie },
    });
    expect(aRes.statusCode).toBe(404);
    // B видит свой.
    const bRes = await app.inject({
      method: 'GET',
      url: '/api/v1/company/logo',
      headers: { cookie: b.cookie },
    });
    expect(bRes.statusCode).toBe(200);
  });

  it('POST без cookie → 401', async () => {
    const mp = buildMultipartBody('logo', 'l.png', 'image/png', smallPng);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/company/logo',
      headers: { 'content-type': mp.contentType },
      payload: mp.body,
    });
    expect(res.statusCode).toBe(401);
  });
});
