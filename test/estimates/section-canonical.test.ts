import { randomUUID } from 'node:crypto';
import { type FastifyInstance } from 'fastify';
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';

import { buildTestApp } from '../setup/build-test-app.js';
import { closeTestDb, getSetupDb, truncateAll } from '../setup/test-db.js';
import { registerOwner } from '../projects/helpers.js';
import { createEmptyEstimate, createProjectViaApi } from './helpers.js';

// Инвариант: строка с product_id (из каталога) и kind∈{material,work} обязана
// лежать в каноническом разделе, соответствующем kind:
//   material → «Оборудование»
//   work     → «Монтаж»
// Ручные строки (product_id=null) и kind='other'/'service' — свободно.
//
// Тесты покрывают три слоя защиты:
//   1) валидация на POST /line-items и PATCH /line-items (400 на нарушение),
//   2) автолечение битых legacy-строк при следующем чтении сметы,
//   3) орфан c section_id=null / удалённым разделом — тоже по kind.
describe('estimates — sectionId ↔ kind канонический инвариант', () => {
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

  const setup = async (): Promise<{
    cookie: string;
    estimateId: string;
    sections: Array<{ id: string; title: string }>;
    companyId: string;
  }> => {
    const { cookie, companyId } = await registerOwner(app, {
      email: 'inv@a.com',
      companyName: 'INV',
    });
    const project = await createProjectViaApi(app, { cookie });
    const est = await createEmptyEstimate(app, { cookie, projectId: project.id });

    const tree = await app.inject({
      method: 'GET',
      url: `/api/v1/estimates/${est.id}`,
      headers: { cookie },
    });
    const body = tree.json() as { sections: Array<{ id: string; title: string }> };
    return { cookie, estimateId: est.id, sections: body.sections, companyId };
  };

  const findSection = (
    sections: Array<{ id: string; title: string }>,
    title: 'Оборудование' | 'Монтаж' | 'Другое',
  ): { id: string; title: string } => {
    const found = sections.find((s) => s.title === title);
    if (!found) throw new Error(`Раздел «${title}» не найден`);
    return found;
  };

  // ─── 1) валидация ────────────────────────────────────────────

  it('POST — material с product_id в «Другое» → 400', async () => {
    const { cookie, estimateId, sections } = await setup();
    const other = findSection(sections, 'Другое');

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/estimates/${estimateId}/line-items`,
      headers: { cookie },
      payload: {
        sectionId: other.id,
        productId: randomUUID(),
        kind: 'material',
        name: 'Камера в неправильном разделе',
        unit: 'шт',
        quantity: '1',
        price: '1000',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation');
  });

  it('POST — work с product_id в «Оборудование» → 400', async () => {
    const { cookie, estimateId, sections } = await setup();
    const equip = findSection(sections, 'Оборудование');

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/estimates/${estimateId}/line-items`,
      headers: { cookie },
      payload: {
        sectionId: equip.id,
        productId: randomUUID(),
        kind: 'work',
        name: 'Работа в неправильном разделе',
        unit: 'шт',
        quantity: '1',
        price: '500',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation');
  });

  it('POST — material с product_id в «Оборудование» → ok', async () => {
    const { cookie, estimateId, sections } = await setup();
    const equip = findSection(sections, 'Оборудование');

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/estimates/${estimateId}/line-items`,
      headers: { cookie },
      payload: {
        sectionId: equip.id,
        productId: randomUUID(),
        kind: 'material',
        name: 'Камера',
        unit: 'шт',
        quantity: '1',
        price: '1000',
      },
    });
    expect(res.statusCode).toBe(200);
  });

  it('POST — ручная строка (product_id=null) с kind=other в «Другое» → ok', async () => {
    const { cookie, estimateId, sections } = await setup();
    const other = findSection(sections, 'Другое');

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/estimates/${estimateId}/line-items`,
      headers: { cookie },
      payload: {
        sectionId: other.id,
        kind: 'other',
        name: 'Транспорт',
        unit: 'шт',
        quantity: '1',
        price: '3000',
      },
    });
    expect(res.statusCode).toBe(200);
  });

  it('PATCH — попытка переложить material с product_id в «Другое» → 400', async () => {
    const { cookie, estimateId, sections } = await setup();
    const equip = findSection(sections, 'Оборудование');
    const other = findSection(sections, 'Другое');

    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/estimates/${estimateId}/line-items`,
      headers: { cookie },
      payload: {
        sectionId: equip.id,
        productId: randomUUID(),
        kind: 'material',
        name: 'Камера',
        unit: 'шт',
        quantity: '1',
        price: '1000',
      },
    });
    const lineId = created
      .json()
      .lineItems.find((l: { name: string; id: string }) => l.name === 'Камера').id;

    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/estimates/${estimateId}/line-items/${lineId}`,
      headers: { cookie },
      payload: { sectionId: other.id },
    });
    expect(patch.statusCode).toBe(400);
    expect(patch.json().error.code).toBe('validation');
  });

  // ─── 2) автолечение legacy данных ──────────────────────────────

  it('GET — material с product_id залипший в «Другом» переезжает в «Оборудование»', async () => {
    const { cookie, estimateId, sections, companyId } = await setup();
    const other = findSection(sections, 'Другое');
    const equip = findSection(sections, 'Оборудование');

    // Байпасом через migrator-роль вставляем битую legacy-строку.
    const { pool } = getSetupDb();
    const badLineId = randomUUID();
    await pool.query(
      `INSERT INTO estimate_line_items
        (id, company_id, estimate_id, section_id, product_id, kind, name, unit,
         quantity, price, cost, discount_percent, price_basis, sort_order)
       VALUES ($1, $2, $3, $4, $5, 'material', 'IP-камера залипла', 'шт',
               '1', '9990', '0', '0', 'rrp', 0)`,
      [badLineId, companyId, estimateId, other.id, randomUUID()],
    );

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/estimates/${estimateId}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const line = res.json().lineItems.find((l: { id: string }) => l.id === badLineId) as {
      sectionId: string;
    };
    expect(line.sectionId).toBe(equip.id);
  });

  it('GET — orphan (section_id=null, kind=material) переезжает в «Оборудование», а не в «Другое»', async () => {
    const { cookie, estimateId, companyId, sections } = await setup();
    const equip = findSection(sections, 'Оборудование');

    const { pool } = getSetupDb();
    const orphanId = randomUUID();
    await pool.query(
      `INSERT INTO estimate_line_items
        (id, company_id, estimate_id, section_id, product_id, kind, name, unit,
         quantity, price, cost, discount_percent, price_basis, sort_order)
       VALUES ($1, $2, $3, NULL, NULL, 'material', 'Camera без раздела', 'шт',
               '1', '5000', '0', '0', 'rrp', 0)`,
      [orphanId, companyId, estimateId],
    );

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/estimates/${estimateId}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const line = res.json().lineItems.find((l: { id: string }) => l.id === orphanId) as {
      sectionId: string;
    };
    expect(line.sectionId).toBe(equip.id);
  });

  it('GET — ручная строка (product_id=null, kind=other) в «Другом» остаётся на месте', async () => {
    const { cookie, estimateId, sections } = await setup();
    const other = findSection(sections, 'Другое');

    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/estimates/${estimateId}/line-items`,
      headers: { cookie },
      payload: {
        sectionId: other.id,
        kind: 'other',
        name: 'Транспорт',
        unit: 'шт',
        quantity: '1',
        price: '3000',
      },
    });
    const lineId = created
      .json()
      .lineItems.find((l: { name: string; id: string }) => l.name === 'Транспорт').id;

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/estimates/${estimateId}`,
      headers: { cookie },
    });
    const line = res.json().lineItems.find((l: { id: string }) => l.id === lineId) as {
      sectionId: string;
    };
    expect(line.sectionId).toBe(other.id);
  });
});
