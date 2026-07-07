import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { buildTestApp } from '../setup/build-test-app.js';
import { closeTestDb, getSetupDb, truncateAll } from '../setup/test-db.js';
import { memberships, products } from '../../src/db/schema/index.js';
import { registerOwner, addMembership, switchTo } from '../projects/helpers.js';
import { createProductViaApi, getPlatformCategoryId, getUnitId } from './helpers.js';

describe('catalog — isolation, roles, sessions, platform-visibility', () => {
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

  // ── Happy path ──

  it('POST /products — создаёт товар компании (201, source=company, own id в companyId)', async () => {
    const a = await registerOwner(app, { email: 'a@a.com', companyName: 'Alpha' });
    const categoryId = await getPlatformCategoryId('video');
    const unitId = await getUnitId('pcs');

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/products',
      headers: { cookie: a.cookie },
      payload: {
        name: 'IP-камера 4МП купольная',
        categoryId,
        unitId,
        sku: 'HIK-DS-2CD',
        brand: 'Hikvision',
        buyPrice: '18500.00',
        sellPrice: '24000.00',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.source).toBe('company');
    expect(body.companyId).toBe(a.companyId);
    expect(body.name).toBe('IP-камера 4МП купольная');
    expect(body.sku).toBe('HIK-DS-2CD');
    expect(body.brand).toBe('Hikvision');
    expect(body.buyPrice).toBe('18500.0000');
    expect(body.sellPrice).toBe('24000.0000');
    expect(body.isActive).toBe(true);
  });

  it('GET /units — возвращает 8 платформенных единиц из seed', async () => {
    const a = await registerOwner(app, { email: 'u@a.com', companyName: 'UnitsCo' });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/units',
      headers: { cookie: a.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items.length).toBe(8);
  });

  it('GET /categories — возвращает 8 платформенных категорий из seed', async () => {
    const a = await registerOwner(app, { email: 'c@a.com', companyName: 'CatsCo' });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/categories',
      headers: { cookie: a.cookie },
    });
    expect(res.statusCode).toBe(200);
    const codes = res.json().items.map((c: { code: string }) => c.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        'video',
        'audio',
        'security',
        'network',
        'cable',
        'power',
        'mount',
        'other',
      ]),
    );
  });

  // ── Cross-tenant isolation ──

  it('GET /products/:id — id чужого товара → 404 (не 403)', async () => {
    const a = await registerOwner(app, { email: 'a1@a.com', companyName: 'A1' });
    const b = await registerOwner(app, { email: 'b1@b.com', companyName: 'B1' });
    const bProduct = await createProductViaApi(app, { cookie: b.cookie, name: 'B secret camera' });

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/products/${bProduct.id}`,
      headers: { cookie: a.cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it('PATCH /products/:id — попытка обновить чужой → 404, изменений в БД нет', async () => {
    const a = await registerOwner(app, { email: 'a2@a.com', companyName: 'A2' });
    const b = await registerOwner(app, { email: 'b2@b.com', companyName: 'B2' });
    const bProduct = await createProductViaApi(app, { cookie: b.cookie, name: 'B untouched' });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/products/${bProduct.id}`,
      headers: { cookie: a.cookie },
      payload: { name: 'HACKED' },
    });
    expect(res.statusCode).toBe(404);

    const { db: setup } = getSetupDb();
    const [row] = await setup.select().from(products).where(eq(products.id, bProduct.id));
    expect(row?.name).toBe('B untouched');
  });

  it('DELETE /products/:id — попытка удалить чужой → 404, deletedAt не установлен', async () => {
    const a = await registerOwner(app, { email: 'a3@a.com', companyName: 'A3' });
    const b = await registerOwner(app, { email: 'b3@b.com', companyName: 'B3' });
    // Дают а роль admin в своей — чтоб DELETE не отбился на role, а на visibility.
    const bProduct = await createProductViaApi(app, { cookie: b.cookie, name: 'B alive' });

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/products/${bProduct.id}`,
      headers: { cookie: a.cookie },
    });
    expect(res.statusCode).toBe(404);

    const { db: setup } = getSetupDb();
    const [row] = await setup.select().from(products).where(eq(products.id, bProduct.id));
    expect(row?.deletedAt).toBeNull();
  });

  it('GET /products (scope=own) — не показывает чужие, только свои и платформенные под scope=all', async () => {
    const a = await registerOwner(app, { email: 'a4@a.com', companyName: 'A4' });
    const b = await registerOwner(app, { email: 'b4@b.com', companyName: 'B4' });
    await createProductViaApi(app, { cookie: b.cookie, name: 'B private' });
    await createProductViaApi(app, { cookie: a.cookie, name: 'A own' });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/products?scope=own',
      headers: { cookie: a.cookie },
    });
    expect(res.statusCode).toBe(200);
    const names = res.json().items.map((p: { name: string }) => p.name);
    expect(names).toEqual(['A own']);
  });

  // ── Role gates ──

  it('POST /products — viewer → 403', async () => {
    const owner = await registerOwner(app, { email: 'o@x.com', companyName: 'X-Owner' });
    const guest = await registerOwner(app, { email: 'g@y.com', companyName: 'Y-Guest' });
    // Дать гостю membership в X с ролью viewer.
    const guestInX = await addMembership({
      userId: guest.userId,
      companyId: owner.companyId,
      role: 'viewer',
    });
    await switchTo(app, { cookie: guest.cookie, membershipId: guestInX.id });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/products',
      headers: { cookie: guest.cookie },
      payload: {
        name: 'блокируем',
        categoryId: await getPlatformCategoryId('video'),
        unitId: await getUnitId('pcs'),
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it('DELETE /products/:id — member (не admin) → 403', async () => {
    const owner = await registerOwner(app, { email: 'o2@x.com', companyName: 'X2' });
    const member = await registerOwner(app, { email: 'm@y.com', companyName: 'Y2' });
    const memberInX = await addMembership({
      userId: member.userId,
      companyId: owner.companyId,
      role: 'member',
    });
    await switchTo(app, { cookie: member.cookie, membershipId: memberInX.id });

    const created = await createProductViaApi(app, { cookie: owner.cookie, name: 'to keep' });

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/products/${created.id}`,
      headers: { cookie: member.cookie },
    });
    expect(res.statusCode).toBe(403);
  });

  // ── Session / membership gates ──

  it('GET /products без cookie → 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/products' });
    expect(res.statusCode).toBe(401);
  });

  it('GET /products при disabled membership → 401', async () => {
    const a = await registerOwner(app, { email: 'd@a.com', companyName: 'Disabled' });

    // Выключаем membership через setup-БД.
    const { db: setup } = getSetupDb();
    await setup
      .update(memberships)
      .set({ status: 'disabled' })
      .where(eq(memberships.id, a.membershipId));

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/products',
      headers: { cookie: a.cookie },
    });
    expect(res.statusCode).toBe(401);
  });
});
