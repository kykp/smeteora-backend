import { type Db } from '../../db/client.js';
import { type Company } from '../../db/schema/index.js';
import { NotFoundError } from '../../lib/errors.js';
import * as repo from './repo.js';
import { type CompanyResponse, type PatchCompanyBody } from './schema.js';

// Маппер Drizzle-строки → response. Все опциональные поля Drizzle возвращает
// как string | null, что совпадает с схемой ответа.
// legal_form на слое БД — свободный text, поэтому нормализуем: если в БД лежит
// значение вне enum'а — возвращаем null (defensive: старые записи, ручные правки).
const isKnownLegalForm = (v: string): v is 'ooo' | 'ip' | 'self-employed' | 'ao' =>
  v === 'ooo' || v === 'ip' || v === 'self-employed' || v === 'ao';

const toResponse = (row: Company): CompanyResponse => ({
  id: row.id,
  name: row.name,
  legalForm: row.legalForm && isKnownLegalForm(row.legalForm) ? row.legalForm : null,
  inn: row.inn,
  kpp: row.kpp,
  ogrn: row.ogrn,
  legalAddress: row.legalAddress,
  actualAddress: row.actualAddress,
  bankName: row.bankName,
  bik: row.bik,
  checkingAccount: row.checkingAccount,
  correspondentAccount: row.correspondentAccount,
  directorName: row.directorName,
  directorPosition: row.directorPosition,
  phone: row.phone,
  email: row.email,
  hasLogo: row.logoKey !== null,
  pdfShowLogo: row.pdfShowLogo,
  pdfShowAddresses: row.pdfShowAddresses,
  pdfShowBank: row.pdfShowBank,
  pdfShowDirector: row.pdfShowDirector,
  pdfOfferValidityDays: row.pdfOfferValidityDays,
});

export const get = async (tx: Db, companyId: string): Promise<CompanyResponse> => {
  const row = await repo.findById(tx, companyId);
  if (!row) throw new NotFoundError('Компания не найдена');
  return toResponse(row);
};

// Семантика partial update из фронта:
//   undefined — не трогаем;
//   null      — сбрасываем в БД в NULL;
//   string    — записываем.
// Собираем набор изменений и одним UPDATE отправляем в БД.
export const update = async (
  tx: Db,
  companyId: string,
  body: PatchCompanyBody,
): Promise<CompanyResponse> => {
  const values: Partial<Company> = {};

  // name — единственное поле NOT NULL. Zod-схема не даёт null, только string | undefined.
  if (body.name !== undefined) values.name = body.name;

  // Все остальные поля nullable — undefined пропускаем, null и string записываем.
  const assignNullable = <K extends keyof Company>(
    key: K,
    incoming: Company[K] | undefined,
  ): void => {
    if (incoming !== undefined) values[key] = incoming;
  };

  assignNullable('legalForm', body.legalForm);
  assignNullable('inn', body.inn);
  assignNullable('kpp', body.kpp);
  assignNullable('ogrn', body.ogrn);
  assignNullable('legalAddress', body.legalAddress);
  assignNullable('actualAddress', body.actualAddress);
  assignNullable('bankName', body.bankName);
  assignNullable('bik', body.bik);
  assignNullable('checkingAccount', body.checkingAccount);
  assignNullable('correspondentAccount', body.correspondentAccount);
  assignNullable('directorName', body.directorName);
  assignNullable('directorPosition', body.directorPosition);
  assignNullable('phone', body.phone);
  assignNullable('email', body.email);
  assignNullable('pdfShowLogo', body.pdfShowLogo);
  assignNullable('pdfShowAddresses', body.pdfShowAddresses);
  assignNullable('pdfShowBank', body.pdfShowBank);
  assignNullable('pdfShowDirector', body.pdfShowDirector);
  assignNullable('pdfOfferValidityDays', body.pdfOfferValidityDays);

  const row = await repo.patch(tx, companyId, values);
  if (!row) throw new NotFoundError('Компания не найдена');
  return toResponse(row);
};
