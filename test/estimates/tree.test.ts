import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { buildTestApp } from '../setup/build-test-app.js';
import { closeTestDb, truncateAll } from '../setup/test-db.js';
import { registerOwner } from '../projects/helpers.js';
import {
  createEmptyEstimate,
  createProjectViaApi,
  makeLineItemId,
  makeSectionId,
} from './helpers.js';

// PUT /estimates/:id/tree — центральный эндпоинт модуля.
// Клиент шлёт всё дерево целиком, сервер diff'ит с текущим состоянием.
describe('estimates — tree upsert', () => {
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

  const setup = async (): Promise<{ cookie: string; estimateId: string }> => {
    const { cookie } = await registerOwner(app, { email: 't@a.com', companyName: 'TT' });
    const project = await createProjectViaApi(app, { cookie });
    const est = await createEmptyEstimate(app, { cookie, projectId: project.id });
    return { cookie, estimateId: est.id };
  };

  it('первый upsert: создаёт две секции и три позиции, рассчитывает итог без НДС', async () => {
    const { cookie, estimateId } = await setup();
    const s1 = makeSectionId();
    const s2 = makeSectionId();
    const i1 = makeLineItemId();
    const i2 = makeLineItemId();
    const i3 = makeLineItemId();

    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/estimates/${estimateId}/tree`,
      headers: { cookie },
      payload: {
        sections: [
          { id: s1, title: 'Демонтаж', sortOrder: 0 },
          { id: s2, title: 'Черновая', sortOrder: 1 },
        ],
        lineItems: [
          {
            id: i1,
            sectionId: s1,
            name: 'Демонтаж плитки',
            unit: 'м²',
            quantity: '50',
            price: '300',
            sortOrder: 0,
          },
          {
            id: i2,
            sectionId: s2,
            name: 'Штукатурка',
            unit: 'м²',
            quantity: '80',
            price: '450',
            sortOrder: 0,
          },
          {
            id: i3,
            sectionId: s2,
            name: 'Стяжка',
            unit: 'м²',
            quantity: '35',
            price: '600',
            sortOrder: 1,
          },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sections).toHaveLength(2);
    expect(body.lineItems).toHaveLength(3);
    // 50*300 + 80*450 + 35*600 = 15000 + 36000 + 21000 = 72000
    expect(body.totals.itemsGross).toBe('72000.00');
    expect(body.totals.itemsNet).toBe('72000.00');
    expect(body.totals.total).toBe('72000.00');

    const section2 = body.sections.find((s: { id: string }) => s.id === s2);
    expect(section2.totals.itemsCount).toBe(2);
    expect(section2.totals.net).toBe('57000.00');
  });

  it('vatMode=added — начисляет НДС сверху', async () => {
    const { cookie } = await registerOwner(app, { email: 'vat@a.com', companyName: 'Vat' });
    const project = await createProjectViaApi(app, { cookie });
    const est = await createEmptyEstimate(app, {
      cookie,
      projectId: project.id,
      vatMode: 'added',
      vatRate: '20',
    });

    const s = makeSectionId();
    const i = makeLineItemId();

    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/estimates/${est.id}/tree`,
      headers: { cookie },
      payload: {
        sections: [{ id: s, title: 'Работы', sortOrder: 0 }],
        lineItems: [
          {
            id: i,
            sectionId: s,
            name: 'Работа',
            unit: 'шт',
            quantity: '10',
            price: '100',
            sortOrder: 0,
          },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // 10*100 = 1000, НДС 20% = 200, total = 1200
    expect(body.totals.itemsNet).toBe('1000.00');
    expect(body.totals.taxableBase).toBe('1000.00');
    expect(body.totals.vatAmount).toBe('200.00');
    expect(body.totals.total).toBe('1200.00');
  });

  it('vatMode=included — выделяет НДС из цены', async () => {
    const { cookie } = await registerOwner(app, { email: 'vin@a.com', companyName: 'VIn' });
    const project = await createProjectViaApi(app, { cookie });
    const est = await createEmptyEstimate(app, {
      cookie,
      projectId: project.id,
      vatMode: 'included',
      vatRate: '20',
    });

    const s = makeSectionId();
    const i = makeLineItemId();

    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/estimates/${est.id}/tree`,
      headers: { cookie },
      payload: {
        sections: [{ id: s, title: 'Работы', sortOrder: 0 }],
        lineItems: [
          {
            id: i,
            sectionId: s,
            name: 'Работа',
            unit: 'шт',
            quantity: '1',
            price: '1200',
            sortOrder: 0,
          },
        ],
      },
    });
    const body = res.json();
    // 1200 с НДС 20%, выделенный НДС = 1200 * 20 / 120 = 200, total = 1200
    expect(body.totals.vatAmount).toBe('200.00');
    expect(body.totals.total).toBe('1200.00');
  });

  it('позиционная скидка + сметная скидка — оба применяются', async () => {
    const { cookie } = await registerOwner(app, { email: 'ds@a.com', companyName: 'DS' });
    const project = await createProjectViaApi(app, { cookie });
    const est = await createEmptyEstimate(app, { cookie, projectId: project.id });

    // Скидка на смету 10%.
    const putHeader = await app.inject({
      method: 'PUT',
      url: `/api/v1/estimates/${est.id}/tree`,
      headers: { cookie },
      payload: {
        estimate: { discountPercent: '10' },
        sections: [],
        lineItems: [
          {
            id: makeLineItemId(),
            name: 'Работа',
            unit: 'шт',
            quantity: '10',
            price: '100',
            discountPercent: '10', // позиционная скидка
            sortOrder: 0,
          },
        ],
      },
    });
    expect(putHeader.statusCode).toBe(200);
    const body = putHeader.json();
    // 10*100 = 1000 gross, -10% позиционной = 900 net.
    // Скидка сметы 10% от 900 = 90, taxableBase = 810.
    expect(body.totals.itemsGross).toBe('1000.00');
    expect(body.totals.itemsNet).toBe('900.00');
    expect(body.totals.estimateDiscount).toBe('90.00');
    expect(body.totals.taxableBase).toBe('810.00');
    expect(body.totals.total).toBe('810.00');
  });

  it('второй upsert: удаляет одну секцию, добавляет одну, обновляет позицию', async () => {
    const { cookie, estimateId } = await setup();
    const s1 = makeSectionId();
    const s2 = makeSectionId();
    const i1 = makeLineItemId();
    const i2 = makeLineItemId();

    // Первый upsert: 2 секции, 2 позиции.
    await app.inject({
      method: 'PUT',
      url: `/api/v1/estimates/${estimateId}/tree`,
      headers: { cookie },
      payload: {
        sections: [
          { id: s1, title: 'S1', sortOrder: 0 },
          { id: s2, title: 'S2', sortOrder: 1 },
        ],
        lineItems: [
          {
            id: i1,
            sectionId: s1,
            name: 'A',
            unit: 'шт',
            quantity: '1',
            price: '100',
            sortOrder: 0,
          },
          {
            id: i2,
            sectionId: s2,
            name: 'B',
            unit: 'шт',
            quantity: '2',
            price: '200',
            sortOrder: 0,
          },
        ],
      },
    });

    // Второй upsert: удаляем s1 (и её позицию), меняем название s2, обновляем цену i2,
    // добавляем новую секцию s3 с позицией i3.
    const s3 = makeSectionId();
    const i3 = makeLineItemId();
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/estimates/${estimateId}/tree`,
      headers: { cookie },
      payload: {
        sections: [
          { id: s2, title: 'S2 переименован', sortOrder: 0 },
          { id: s3, title: 'S3 новый', sortOrder: 1 },
        ],
        lineItems: [
          {
            id: i2,
            sectionId: s2,
            name: 'B updated',
            unit: 'шт',
            quantity: '2',
            price: '300',
            sortOrder: 0,
          },
          {
            id: i3,
            sectionId: s3,
            name: 'C new',
            unit: 'шт',
            quantity: '5',
            price: '100',
            sortOrder: 0,
          },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sections).toHaveLength(2);
    expect(body.lineItems).toHaveLength(2);
    // 2*300 + 5*100 = 1100
    expect(body.totals.itemsNet).toBe('1100.00');
    expect(body.sections.find((s: { id: string }) => s.id === s2).title).toBe('S2 переименован');
    expect(body.lineItems.find((li: { id: string }) => li.id === i2).name).toBe('B updated');
    // i1 удалён, i3 добавлен.
    expect(body.lineItems.find((li: { id: string }) => li.id === i1)).toBeUndefined();
    expect(body.lineItems.find((li: { id: string }) => li.id === i3)).toBeDefined();
  });

  it('пустой upsert — очищает всё дерево, шапка остаётся', async () => {
    const { cookie, estimateId } = await setup();
    // Наполняем.
    const s = makeSectionId();
    const i = makeLineItemId();
    await app.inject({
      method: 'PUT',
      url: `/api/v1/estimates/${estimateId}/tree`,
      headers: { cookie },
      payload: {
        sections: [{ id: s, title: 'X', sortOrder: 0 }],
        lineItems: [
          {
            id: i,
            sectionId: s,
            name: 'X',
            unit: 'шт',
            quantity: '1',
            price: '100',
            sortOrder: 0,
          },
        ],
      },
    });

    // Пустой upsert.
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/estimates/${estimateId}/tree`,
      headers: { cookie },
      payload: { sections: [], lineItems: [] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sections).toEqual([]);
    expect(body.lineItems).toEqual([]);
    expect(body.totals.total).toBe('0.00');
  });

  it('валидация: позиция ссылается на sectionId, отсутствующий в body → 400', async () => {
    const { cookie, estimateId } = await setup();
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/estimates/${estimateId}/tree`,
      headers: { cookie },
      payload: {
        sections: [],
        lineItems: [
          {
            id: makeLineItemId(),
            sectionId: makeSectionId(), // такого раздела нет в body
            name: 'X',
            unit: 'шт',
            quantity: '1',
            price: '10',
            sortOrder: 0,
          },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('валидация: дублированные id секций → 400', async () => {
    const { cookie, estimateId } = await setup();
    const s = makeSectionId();
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/estimates/${estimateId}/tree`,
      headers: { cookie },
      payload: {
        sections: [
          { id: s, title: 'A', sortOrder: 0 },
          { id: s, title: 'B', sortOrder: 1 },
        ],
        lineItems: [],
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('PUT /:id/tree — несуществующая смета → 404', async () => {
    const { cookie } = await registerOwner(app, { email: 'nf@a.com', companyName: 'NF' });
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/estimates/00000000-0000-0000-0000-000000000000/tree',
      headers: { cookie },
      payload: { sections: [], lineItems: [] },
    });
    expect(res.statusCode).toBe(404);
  });

  it('изменение шапки через tree-upsert: title и vatMode/vatRate', async () => {
    const { cookie, estimateId } = await setup();
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/estimates/${estimateId}/tree`,
      headers: { cookie },
      payload: {
        estimate: { title: 'Новый заголовок', vatMode: 'added', vatRate: '10' },
        sections: [],
        lineItems: [
          {
            id: makeLineItemId(),
            name: 'X',
            unit: 'шт',
            quantity: '5',
            price: '100',
            sortOrder: 0,
          },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.estimate.title).toBe('Новый заголовок');
    expect(body.estimate.vatMode).toBe('added');
    // 5*100 = 500, НДС 10% = 50, total = 550
    expect(body.totals.total).toBe('550.00');
  });
});
