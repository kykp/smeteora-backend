import { type FastifyInstance } from 'fastify';
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';

import { buildTestApp } from '../setup/build-test-app.js';
import { closeTestDb, truncateAll } from '../setup/test-db.js';
import { registerOwner } from '../projects/helpers.js';
import { createProductViaApi, getPlatformCategoryId, getUnitId } from '../catalog/helpers.js';
import { createEmptyEstimate, createProjectViaApi } from './helpers.js';

// Автоматическая привязка работы к товару должна быть симметричной: юзер
// увеличивает qty товара → работа растёт, юзер уменьшает / удаляет товар →
// работа сжимается / исчезает. Иначе юзер увидит «5 камер добавил → 5 работ
// монтажа приехало → удалил все камеры → в смете остались 5 работ».
describe('estimates — автопривязка работ (add/update/delete)', () => {
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

  // Помощник для полного bootstrap: юзер, компания-work-категория, работа с
  // триггером на «Видеонаблюдение», проект + пустая смета, id раздела «Монтаж».
  const bootstrap = async (): Promise<{
    cookie: string;
    estimateId: string;
    sectionEquipmentId: string;
    sectionInstallId: string;
    videoCategoryId: string;
    workItemId: string;
  }> => {
    const { cookie } = await registerOwner(app, {
      email: 'al@a.com',
      companyName: 'AL',
    });

    const videoCategoryId = await getPlatformCategoryId('video');

    // Компания-work-категория. Нужна ссылка на неё для work_items.
    const catRes = await app.inject({
      method: 'POST',
      url: '/api/v1/work-categories',
      headers: { cookie },
      payload: { code: 'install', name: 'Установка' },
    });
    if (catRes.statusCode !== 201) throw new Error(`work-category: ${catRes.body}`);
    const workCategoryId = catRes.json().id as string;

    const unitId = await getUnitId('pcs');

    // Работа с триггером на video-категорию.
    const workRes = await app.inject({
      method: 'POST',
      url: '/api/v1/work-items',
      headers: { cookie },
      payload: {
        categoryId: workCategoryId,
        unitId,
        name: 'Монтаж камеры',
        price: '2000',
        triggerCategoryIds: [videoCategoryId],
      },
    });
    if (workRes.statusCode !== 201) throw new Error(`work-item: ${workRes.body}`);
    const workItemId = workRes.json().id as string;

    // Проект + смета.
    const project = await createProjectViaApi(app, { cookie });
    const est = await createEmptyEstimate(app, {
      cookie,
      projectId: project.id,
      title: 'Смета',
    });

    // Секции берём из tree.
    const tree = await app.inject({
      method: 'GET',
      url: `/api/v1/estimates/${est.id}`,
      headers: { cookie },
    });
    const sections = tree.json().sections as Array<{ id: string; title: string }>;
    const equip = sections.find((s) => s.title === 'Оборудование');
    const install = sections.find((s) => s.title === 'Монтаж');
    if (!equip || !install) throw new Error('canonical sections missing');

    return {
      cookie,
      estimateId: est.id,
      sectionEquipmentId: equip.id,
      sectionInstallId: install.id,
      videoCategoryId,
      workItemId,
    };
  };

  const addCamera = async (
    cookie: string,
    estimateId: string,
    sectionId: string,
    videoCategoryId: string,
    quantity: string,
  ): Promise<string> => {
    const productRes = await createProductViaApi(app, {
      cookie,
      name: `Камера ${Math.random()}`,
      categoryCode: 'video',
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/estimates/${estimateId}/line-items`,
      headers: { cookie },
      payload: {
        sectionId,
        productId: productRes.id,
        catalogSnapshot: { categoryId: videoCategoryId, productId: productRes.id },
        kind: 'material',
        name: 'Камера',
        unit: 'шт',
        quantity,
        price: '5000',
      },
    });
    if (res.statusCode !== 200) throw new Error(`add camera: ${res.statusCode} ${res.body}`);
    const items = res.json().lineItems as Array<{
      id: string;
      productId: string | null;
      name: string;
    }>;
    const line = items.find((li) => li.productId === productRes.id);
    if (!line) throw new Error('line not found in response');
    return line.id;
  };

  const findWorkLine = (
    treeJson: unknown,
    workItemId: string,
  ): { id: string; quantity: string; meta: Record<string, unknown> } | undefined => {
    const items = (
      treeJson as {
        lineItems: Array<{
          id: string;
          quantity: string;
          kind: string;
          catalogSnapshot: Record<string, unknown> | null;
          meta: Record<string, unknown>;
        }>;
      }
    ).lineItems;
    return items.find((li) => {
      const snap = li.catalogSnapshot;
      return li.kind === 'work' && snap?.['workItemId'] === workItemId;
    });
  };

  // ─── happy path ──────────────────────────────────────────────

  it('добавили камеру × 3 → авто-работа qty=3', async () => {
    const { cookie, estimateId, sectionEquipmentId, videoCategoryId, workItemId } =
      await bootstrap();
    await addCamera(cookie, estimateId, sectionEquipmentId, videoCategoryId, '3');

    const tree = await app.inject({
      method: 'GET',
      url: `/api/v1/estimates/${estimateId}`,
      headers: { cookie },
    });
    const work = findWorkLine(tree.json(), workItemId);
    expect(work).toBeDefined();
    expect(Number(work?.quantity)).toBe(3);
    expect(work?.meta['autoLinked']).toBe(true);
    expect(work?.meta['triggeredByCategoryId']).toBe(videoCategoryId);
  });

  it('PATCH: уменьшили qty товара 3→1 → авто-работа qty=1', async () => {
    const { cookie, estimateId, sectionEquipmentId, videoCategoryId, workItemId } =
      await bootstrap();
    const lineId = await addCamera(cookie, estimateId, sectionEquipmentId, videoCategoryId, '3');

    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/estimates/${estimateId}/line-items/${lineId}`,
      headers: { cookie },
      payload: { quantity: '1' },
    });
    expect(patch.statusCode).toBe(200);

    const work = findWorkLine(patch.json(), workItemId);
    expect(work).toBeDefined();
    expect(Number(work?.quantity)).toBe(1);
  });

  it('PATCH: увеличили qty товара 3→5 → авто-работа qty=5', async () => {
    const { cookie, estimateId, sectionEquipmentId, videoCategoryId, workItemId } =
      await bootstrap();
    const lineId = await addCamera(cookie, estimateId, sectionEquipmentId, videoCategoryId, '3');

    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/estimates/${estimateId}/line-items/${lineId}`,
      headers: { cookie },
      payload: { quantity: '5' },
    });
    expect(patch.statusCode).toBe(200);

    const work = findWorkLine(patch.json(), workItemId);
    expect(Number(work?.quantity)).toBe(5);
  });

  it('DELETE: удалили товар совсем → авто-работа исчезла', async () => {
    const { cookie, estimateId, sectionEquipmentId, videoCategoryId, workItemId } =
      await bootstrap();
    const lineId = await addCamera(cookie, estimateId, sectionEquipmentId, videoCategoryId, '3');

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v1/estimates/${estimateId}/line-items/${lineId}`,
      headers: { cookie },
    });
    expect(del.statusCode).toBe(200);

    const work = findWorkLine(del.json(), workItemId);
    expect(work).toBeUndefined();
  });

  // ─── страховки от нежелательного поведения ────────────────────

  it('DELETE: руками добавленная работа (без autoLinked) не удаляется', async () => {
    const {
      cookie,
      estimateId,
      sectionEquipmentId,
      sectionInstallId,
      videoCategoryId,
      workItemId,
    } = await bootstrap();
    const cameraLineId = await addCamera(
      cookie,
      estimateId,
      sectionEquipmentId,
      videoCategoryId,
      '2',
    );

    // Юзер сам добавил ещё одну работу «Монтаж камеры» руками (без autoLink).
    // При удалении товара качественно исчезает только автосвязанная строка,
    // ручная должна остаться на месте.
    const manualRes = await app.inject({
      method: 'POST',
      url: `/api/v1/estimates/${estimateId}/line-items`,
      headers: { cookie },
      payload: {
        sectionId: sectionInstallId,
        catalogSnapshot: { workItemId },
        kind: 'work',
        name: 'Монтаж камеры (руками)',
        unit: 'шт',
        quantity: '1',
        price: '3000',
        priceBasis: 'manual',
      },
    });
    expect(manualRes.statusCode).toBe(200);

    // Удаляем товар — авторабота ушла, ручная осталась.
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v1/estimates/${estimateId}/line-items/${cameraLineId}`,
      headers: { cookie },
    });
    expect(del.statusCode).toBe(200);

    const items = del.json().lineItems as Array<{
      name: string;
      kind: string;
      meta: Record<string, unknown>;
    }>;
    const workLines = items.filter((li) => li.kind === 'work');
    // Только ручная. Автоматическая должна была уйти.
    expect(workLines).toHaveLength(1);
    expect(workLines[0]?.meta['autoLinked']).toBeUndefined();
  });
});
