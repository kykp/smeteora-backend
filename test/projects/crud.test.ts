import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { buildTestApp } from '../setup/build-test-app.js';
import { closeTestDb, truncateAll } from '../setup/test-db.js';
import { createProjectViaApi, registerOwner } from './helpers.js';

describe('projects — CRUD (happy path)', () => {
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

  it('POST /projects — создаёт проект (201) с дефолтным status=draft', async () => {
    const { cookie } = await registerOwner(app, {
      email: 'owner@a.com',
      companyName: 'Компания А',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { cookie },
      payload: {
        name: 'ЖК Ромашка, корпус 3',
        address: 'Москва, ул. Ленина, 10',
        clientName: 'ООО "Заказчик"',
        clientPhone: '+79991234567',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    // companyId наружу не отдаём — клиент работает в контексте активной компании из /me.
    expect(body).not.toHaveProperty('companyId');
    expect(body.name).toBe('ЖК Ромашка, корпус 3');
    expect(body.status).toBe('draft');
    expect(body.description).toBeNull();
    expect(body.address).toBe('Москва, ул. Ленина, 10');
    expect(body.clientName).toBe('ООО "Заказчик"');
    expect(body.clientPhone).toBe('+79991234567');
    expect(body.startDate).toBeNull();
    expect(body.endDate).toBeNull();
    expect(new Date(body.createdAt).toString()).not.toBe('Invalid Date');
  });

  it('GET /projects — пустой список для новой компании', async () => {
    const { cookie } = await registerOwner(app, {
      email: 'empty@a.com',
      companyName: 'Пустая',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/projects',
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toEqual([]);
    expect(body.total).toBe(0);
    expect(body.limit).toBe(20);
    expect(body.offset).toBe(0);
  });

  it('GET /projects — возвращает свои проекты, сортировка по createdAt desc', async () => {
    const { cookie } = await registerOwner(app, {
      email: 'many@a.com',
      companyName: 'Много',
    });

    const p1 = await createProjectViaApi(app, { cookie, name: 'Первый' });
    // Небольшой sleep — createdAt хранится с точностью до микросекунды,
    // но параллельные INSERT в тесте иногда попадают в одну мкс. 5ms достаточно.
    await new Promise((r) => setTimeout(r, 5));
    const p2 = await createProjectViaApi(app, { cookie, name: 'Второй' });
    await new Promise((r) => setTimeout(r, 5));
    const p3 = await createProjectViaApi(app, { cookie, name: 'Третий' });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/projects',
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(3);
    expect(body.items).toHaveLength(3);
    expect(body.items.map((p: { id: string }) => p.id)).toEqual([p3.id, p2.id, p1.id]);
  });

  it('GET /projects?status=in-progress — фильтрует по status', async () => {
    const { cookie } = await registerOwner(app, {
      email: 'filter@a.com',
      companyName: 'Фильтр',
    });

    await createProjectViaApi(app, { cookie, name: 'Черновик', status: 'draft' });
    await createProjectViaApi(app, { cookie, name: 'В работе', status: 'in-progress' });
    await createProjectViaApi(app, { cookie, name: 'Выигран', status: 'won' });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/projects?status=in-progress',
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(1);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].name).toBe('В работе');
  });

  it('GET /projects?limit=2&offset=1 — пагинация', async () => {
    const { cookie } = await registerOwner(app, {
      email: 'paging@a.com',
      companyName: 'Пагинация',
    });

    for (let i = 0; i < 5; i++) {
      await createProjectViaApi(app, { cookie, name: `P${i}` });
      await new Promise((r) => setTimeout(r, 3));
    }

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/projects?limit=2&offset=1',
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(5);
    expect(body.items).toHaveLength(2);
    expect(body.limit).toBe(2);
    expect(body.offset).toBe(1);
  });

  it('GET /projects/:id — читает свой проект', async () => {
    const { cookie } = await registerOwner(app, {
      email: 'one@a.com',
      companyName: 'Один',
    });

    const created = await createProjectViaApi(app, { cookie, name: 'Detail' });

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${created.id}`,
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(created.id);
    expect(res.json().name).toBe('Detail');
  });

  it('GET /projects/:id — несуществующий id → 404', async () => {
    const { cookie } = await registerOwner(app, {
      email: 'nf@a.com',
      companyName: 'NF',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/00000000-0000-0000-0000-000000000000',
      headers: { cookie },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
  });

  it('PATCH /projects/:id — частичное обновление, updatedAt меняется', async () => {
    const { cookie } = await registerOwner(app, {
      email: 'upd@a.com',
      companyName: 'Апдейт',
    });

    const created = await createProjectViaApi(app, { cookie, name: 'До' });
    const before = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${created.id}`,
      headers: { cookie },
    });
    await new Promise((r) => setTimeout(r, 10));

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${created.id}`,
      headers: { cookie },
      payload: { name: 'После', status: 'in-progress' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.name).toBe('После');
    expect(body.status).toBe('in-progress');
    expect(new Date(body.updatedAt).getTime()).toBeGreaterThan(
      new Date(before.json().updatedAt).getTime(),
    );
  });

  it('PATCH /projects/:id — прикладные метрики сохраняются и возвращаются', async () => {
    const { cookie } = await registerOwner(app, {
      email: 'metrics@a.com',
      companyName: 'Metrics',
    });

    const created = await createProjectViaApi(app, { cookie, name: 'X' });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${created.id}`,
      headers: { cookie },
      payload: {
        siteObject: 'Паркинг',
        areaM2: 1200,
        camerasCount: 16,
        equipmentBrand: 'Hikvision',
        budgetRub: 3_500_000,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.siteObject).toBe('Паркинг');
    expect(body.areaM2).toBe(1200);
    expect(body.camerasCount).toBe(16);
    expect(body.equipmentBrand).toBe('Hikvision');
    expect(body.budgetRub).toBe(3_500_000);

    // null очищает поле — как и для description
    const cleared = await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${created.id}`,
      headers: { cookie },
      payload: { areaM2: null, equipmentBrand: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().areaM2).toBeNull();
    expect(cleared.json().equipmentBrand).toBeNull();
  });

  it('PATCH /projects/:id — description=null очищает поле', async () => {
    const { cookie } = await registerOwner(app, {
      email: 'clr@a.com',
      companyName: 'Clear',
    });

    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { cookie },
      payload: { name: 'X', description: 'старое' },
    });
    const id = create.json().id;

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${id}`,
      headers: { cookie },
      payload: { description: null },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().description).toBeNull();
  });

  it('PATCH /projects/:id — пустой body → 400', async () => {
    const { cookie } = await registerOwner(app, {
      email: 'emp@a.com',
      companyName: 'Empty',
    });

    const created = await createProjectViaApi(app, { cookie, name: 'X' });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${created.id}`,
      headers: { cookie },
      payload: {},
    });

    expect(res.statusCode).toBe(400);
  });

  it('PATCH /projects/:id — несуществующий id → 404', async () => {
    const { cookie } = await registerOwner(app, {
      email: 'nf2@a.com',
      companyName: 'NF2',
    });

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/projects/00000000-0000-0000-0000-000000000000',
      headers: { cookie },
      payload: { name: 'Пофиг' },
    });

    expect(res.statusCode).toBe(404);
  });

  it('DELETE /projects/:id — помечает удалённым, повторный DELETE → 404', async () => {
    const { cookie } = await registerOwner(app, {
      email: 'del@a.com',
      companyName: 'Del',
    });

    const created = await createProjectViaApi(app, { cookie, name: 'To Delete' });

    const first = await app.inject({
      method: 'DELETE',
      url: `/api/v1/projects/${created.id}`,
      headers: { cookie },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ ok: true });

    // После удаления GET → 404.
    const getRes = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${created.id}`,
      headers: { cookie },
    });
    expect(getRes.statusCode).toBe(404);

    // Повторный DELETE → 404 (не идемпотентно — см. CLAUDE.md).
    const second = await app.inject({
      method: 'DELETE',
      url: `/api/v1/projects/${created.id}`,
      headers: { cookie },
    });
    expect(second.statusCode).toBe(404);
  });

  it('POST /projects — валидация: name пустой → 400', async () => {
    const { cookie } = await registerOwner(app, {
      email: 'v1@a.com',
      companyName: 'V1',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { cookie },
      payload: { name: '   ' },
    });

    expect(res.statusCode).toBe(400);
  });

  it('POST /projects — валидация: некорректный status → 400', async () => {
    const { cookie } = await registerOwner(app, {
      email: 'v2@a.com',
      companyName: 'V2',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { cookie },
      payload: { name: 'X', status: 'not-a-status' },
    });

    expect(res.statusCode).toBe(400);
  });

  it('POST /projects — валидация: startDate неверного формата → 400', async () => {
    const { cookie } = await registerOwner(app, {
      email: 'v3@a.com',
      companyName: 'V3',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { cookie },
      payload: { name: 'X', startDate: '01.02.2025' },
    });

    expect(res.statusCode).toBe(400);
  });
});
