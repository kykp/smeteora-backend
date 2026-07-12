import { type FastifyInstance } from 'fastify';
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';

import { buildTestApp } from '../setup/build-test-app.js';
import { closeTestDb, truncateAll } from '../setup/test-db.js';
import { registerOwner } from '../projects/helpers.js';
import { createEmptyEstimate, createProjectViaApi } from '../estimates/helpers.js';
import { createProductViaApi, getPlatformCategoryId } from './helpers.js';

// Сортировка по популярности — тот самый смысл, ради которого затевалось:
// в панели редактора часто-используемое всплывает сверху. usageCount =
// COUNT(DISTINCT estimate_id) — товар в 3 сметах даёт count=3, независимо
// сколько раз добавлен в каждую (SUM quantity искажает: 100м кабеля из
// одной сметы даст 100, что ложно). При удалении строки count автоматически
// пересчитывается — денормализованного счётчика не держим.
describe('catalog — сортировка по популярности + usageCount', () => {
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

  const addProductToEstimate = async (
    cookie: string,
    estimateId: string,
    productId: string,
    sectionId: string,
    name: string,
  ): Promise<void> => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/estimates/${estimateId}/line-items`,
      headers: { cookie },
      payload: {
        sectionId,
        productId,
        kind: 'material',
        name,
        unit: 'шт',
        quantity: '1',
        price: '1000',
      },
    });
    if (res.statusCode !== 200) {
      throw new Error(`POST line-items: ${res.statusCode} ${res.body}`);
    }
  };

  const getSection = async (
    cookie: string,
    estimateId: string,
    title: 'Оборудование' | 'Монтаж' | 'Другое',
  ): Promise<string> => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/estimates/${estimateId}`,
      headers: { cookie },
    });
    const body = res.json() as { sections: Array<{ id: string; title: string }> };
    const found = body.sections.find((s) => s.title === title);
    if (!found) throw new Error(`Раздел «${title}» не найден`);
    return found.id;
  };

  it('sortBy=popularity — сверху товар с наибольшим usageCount', async () => {
    const { cookie } = await registerOwner(app, { email: 'pop@a.com', companyName: 'POP' });

    // 3 товара одной категории (видео), разной популярности. rare остаётся
    // без единого добавления в смету — усваивается только через список.
    await createProductViaApi(app, { cookie, name: 'A-редкий' });
    const middle = await createProductViaApi(app, { cookie, name: 'B-средний' });
    const popular = await createProductViaApi(app, { cookie, name: 'C-популярный' });

    // Тот же товар «popular» в 3 сметах = usageCount 3.
    // «middle» в 1 смете, «rare» ни в одной.
    const project = await createProjectViaApi(app, { cookie });
    for (let i = 0; i < 3; i += 1) {
      const est = await createEmptyEstimate(app, {
        cookie,
        projectId: project.id,
        title: `Смета ${i}`,
      });
      const sectionId = await getSection(cookie, est.id, 'Оборудование');
      await addProductToEstimate(cookie, est.id, popular.id, sectionId, 'C-популярный');
      if (i === 0) {
        await addProductToEstimate(cookie, est.id, middle.id, sectionId, 'B-средний');
      }
    }

    // Проверяем sortBy=popularity: popular → middle → rare, alphabet как
    // вторичный ключ. При равенстве usageCount падает на alphabet ASC.
    const listRes = await app.inject({
      method: 'GET',
      url: '/api/v1/products?scope=own&sortBy=popularity',
      headers: { cookie },
    });
    expect(listRes.statusCode).toBe(200);
    const items = listRes.json().items as Array<{
      id: string;
      name: string;
      usageCount: number;
    }>;

    const byName = new Map(items.map((it) => [it.name, it]));
    expect(byName.get('C-популярный')?.usageCount).toBe(3);
    expect(byName.get('B-средний')?.usageCount).toBe(1);
    expect(byName.get('A-редкий')?.usageCount).toBe(0);

    // Порядок в списке: сначала популярный, потом средний, потом редкий.
    const orderedNames = items.map((it) => it.name);
    const popIdx = orderedNames.indexOf('C-популярный');
    const midIdx = orderedNames.indexOf('B-средний');
    const rareIdx = orderedNames.indexOf('A-редкий');
    expect(popIdx).toBeLessThan(midIdx);
    expect(midIdx).toBeLessThan(rareIdx);
  });

  it('sortBy=name (default) — алфавитно, usageCount по-прежнему заполнен', async () => {
    const { cookie } = await registerOwner(app, { email: 'nom@a.com', companyName: 'NOM' });

    await createProductViaApi(app, { cookie, name: 'Zebra' });
    const alpha = await createProductViaApi(app, { cookie, name: 'Alpha' });

    // Добавляем Alpha в смету — usageCount=1, но он всё равно должен быть
    // первым при sortBy=name (Alpha < Zebra по алфавиту).
    const project = await createProjectViaApi(app, { cookie });
    const est = await createEmptyEstimate(app, {
      cookie,
      projectId: project.id,
      title: 'Смета',
    });
    const sectionId = await getSection(cookie, est.id, 'Оборудование');
    await addProductToEstimate(cookie, est.id, alpha.id, sectionId, 'Alpha');

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/products?scope=own',
      headers: { cookie },
    });
    const items = res.json().items as Array<{ name: string; usageCount: number }>;
    expect(items[0]?.name).toBe('Alpha');
    expect(items[0]?.usageCount).toBe(1);
    expect(items[1]?.name).toBe('Zebra');
    expect(items[1]?.usageCount).toBe(0);
  });

  it('usageCount изолирован: юзер А не видит статистику компании Б', async () => {
    const a = await registerOwner(app, { email: 'a-iso@a.com', companyName: 'A-ISO' });
    const b = await registerOwner(app, { email: 'b-iso@b.com', companyName: 'B-ISO' });

    // Компания A создаёт свой товар и активно его использует.
    const aProduct = await createProductViaApi(app, { cookie: a.cookie, name: 'Common' });
    const aProject = await createProjectViaApi(app, { cookie: a.cookie });
    for (let i = 0; i < 3; i += 1) {
      const est = await createEmptyEstimate(app, {
        cookie: a.cookie,
        projectId: aProject.id,
        title: `A-${i}`,
      });
      const sectionId = await getSection(a.cookie, est.id, 'Оборудование');
      await addProductToEstimate(a.cookie, est.id, aProduct.id, sectionId, 'Common');
    }

    // Компания B создаёт свой одноимённый товар и не использует.
    await createProductViaApi(app, { cookie: b.cookie, name: 'Common' });

    // B видит только свой Common с usageCount=0. A-стата не течёт.
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/products?scope=own',
      headers: { cookie: b.cookie },
    });
    const items = res.json().items as Array<{ name: string; usageCount: number }>;
    const common = items.find((it) => it.name === 'Common');
    expect(common?.usageCount).toBe(0);

    // И суммарно один Common (не два — из чужой компании нам не пришло).
    // getPlatformCategoryId зовём тут же чтобы не dead code варнинг.
    await getPlatformCategoryId('video');
    expect(items.filter((it) => it.name === 'Common')).toHaveLength(1);
  });
});
