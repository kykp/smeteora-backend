import { type FastifyInstance } from 'fastify';
import { getSetupDb } from '../setup/test-db.js';
import { productCategories, units } from '../../src/db/schema/index.js';
import { and, eq, isNull } from 'drizzle-orm';

// Возвращает id платформенной категории по code (после migrate seed'а гарантированно есть).
export const getPlatformCategoryId = async (code: string): Promise<string> => {
  const { db } = getSetupDb();
  const [row] = await db
    .select({ id: productCategories.id })
    .from(productCategories)
    .where(and(eq(productCategories.code, code), isNull(productCategories.companyId)))
    .limit(1);
  if (!row) throw new Error(`platform category ${code} не найдена`);
  return row.id;
};

// Возвращает id единицы измерения по code.
export const getUnitId = async (code: string): Promise<string> => {
  const { db } = getSetupDb();
  const [row] = await db.select({ id: units.id }).from(units).where(eq(units.code, code)).limit(1);
  if (!row) throw new Error(`unit ${code} не найдена`);
  return row.id;
};

// Создаёт товар через API. Возвращает id.
export const createProductViaApi = async (
  app: FastifyInstance,
  params: {
    cookie: string;
    name: string;
    categoryCode?: string;
    unitCode?: string;
    sellPrice?: string;
    buyPrice?: string;
  },
): Promise<{ id: string }> => {
  const categoryId = await getPlatformCategoryId(params.categoryCode ?? 'video');
  const unitId = await getUnitId(params.unitCode ?? 'pcs');
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/products',
    headers: { cookie: params.cookie },
    payload: {
      name: params.name,
      categoryId,
      unitId,
      ...(params.sellPrice ? { sellPrice: params.sellPrice } : {}),
      ...(params.buyPrice ? { buyPrice: params.buyPrice } : {}),
    },
  });
  if (res.statusCode !== 201) {
    throw new Error(`create product вернул ${res.statusCode}: ${res.body}`);
  }
  return { id: res.json().id };
};
