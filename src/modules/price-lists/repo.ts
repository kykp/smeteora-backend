import { and, desc, eq, ne } from 'drizzle-orm';
import { type Db } from '../../db/client.js';
import {
  priceListUploads,
  type NewPriceListUpload,
  type PriceListUpload,
} from '../../db/schema/index.js';

export const insertUpload = async (
  tx: Db,
  values: NewPriceListUpload,
): Promise<PriceListUpload> => {
  const [row] = await tx.insert(priceListUploads).values(values).returning();
  if (!row) throw new Error('price_list_uploads insert вернул пусто');
  return row;
};

export const findUploadById = async (
  tx: Db,
  params: { id: string; companyId: string },
): Promise<PriceListUpload | undefined> => {
  const rows = await tx
    .select()
    .from(priceListUploads)
    .where(
      and(eq(priceListUploads.id, params.id), eq(priceListUploads.companyId, params.companyId)),
    )
    .limit(1);
  return rows[0];
};

type CommitPatch = {
  status: 'committed';
  rowsTotal: number;
  rowsCreated: number;
  rowsUpdated: number;
  rowsSkipped: number;
  summary: Record<string, unknown>;
  committedAt: Date;
};

export const updateUploadCommit = async (
  tx: Db,
  params: { id: string; companyId: string; patch: CommitPatch },
): Promise<PriceListUpload | undefined> => {
  const [row] = await tx
    .update(priceListUploads)
    .set(params.patch)
    .where(
      and(eq(priceListUploads.id, params.id), eq(priceListUploads.companyId, params.companyId)),
    )
    .returning();
  return row;
};

export const listUploads = async (
  tx: Db,
  params: { companyId: string; limit: number },
): Promise<PriceListUpload[]> => {
  return tx
    .select()
    .from(priceListUploads)
    .where(
      and(
        eq(priceListUploads.companyId, params.companyId),
        ne(priceListUploads.status, 'discarded'),
      ),
    )
    .orderBy(desc(priceListUploads.createdAt))
    .limit(params.limit);
};
