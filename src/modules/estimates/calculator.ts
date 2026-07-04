import { type VatMode } from '../../db/constants.js';

// Все денежные и количественные суммы приходят из БД строками (numeric в Postgres
// сериализуется в JS как string, чтобы не терять точность). Внутри calculator'а
// используем number для арифметики и возвращаем строки, округлённые до 2 знаков.
// Для сумм до триллиона такого diapason double хватает; когда встанет вопрос
// более длинных сумм — перейдём на decimal.js/dinero без смены API.

const parseAmount = (v: string): number => {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Некорректная числовая строка: ${v}`);
  return n;
};

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
const toMoney = (n: number): string => round2(n).toFixed(2);

export type CalcLineItemInput = {
  id: string;
  sectionId: string | null;
  quantity: string;
  price: string;
  discountPercent: string;
};

export type CalcLineItemOutput = {
  gross: string;
  discount: string;
  net: string;
};

export type CalcHeaderInput = {
  vatMode: VatMode;
  vatRate: string | null;
  discountPercent: string | null;
  discountAmount: string | null;
};

export type CalcEstimateTotals = {
  itemsGross: string;
  itemsDiscount: string;
  itemsNet: string;
  estimateDiscount: string;
  taxableBase: string;
  vatAmount: string;
  total: string;
};

export const calcLineItem = (input: CalcLineItemInput): CalcLineItemOutput => {
  const qty = parseAmount(input.quantity);
  const price = parseAmount(input.price);
  const discountPct = parseAmount(input.discountPercent);
  const gross = qty * price;
  const discount = gross * (discountPct / 100);
  const net = gross - discount;
  return {
    gross: toMoney(gross),
    discount: toMoney(discount),
    net: toMoney(net),
  };
};

const sumMoney = (values: string[]): number => values.reduce((acc, v) => acc + parseAmount(v), 0);

export const calcEstimate = (
  header: CalcHeaderInput,
  lineTotals: readonly CalcLineItemOutput[],
): CalcEstimateTotals => {
  const itemsGross = sumMoney(lineTotals.map((l) => l.gross));
  const itemsDiscount = sumMoney(lineTotals.map((l) => l.discount));
  const itemsNet = sumMoney(lineTotals.map((l) => l.net));

  // Скидка на смету: процент или фиксированная сумма (взаимоисключимо на contract'е).
  // Не даём уйти в минус: скидка обрезается по itemsNet.
  let estimateDiscount = 0;
  if (header.discountPercent != null) {
    estimateDiscount = itemsNet * (parseAmount(header.discountPercent) / 100);
  } else if (header.discountAmount != null) {
    estimateDiscount = Math.min(parseAmount(header.discountAmount), itemsNet);
  }

  const taxableBase = Math.max(0, itemsNet - estimateDiscount);

  let vatAmount = 0;
  if (header.vatMode !== 'none' && header.vatRate != null) {
    const rate = parseAmount(header.vatRate);
    if (header.vatMode === 'added') {
      vatAmount = taxableBase * (rate / 100);
    } else {
      // included: НДС уже внутри taxableBase, выделяем обратной формулой.
      vatAmount = taxableBase * (rate / (100 + rate));
    }
  }

  const total = header.vatMode === 'added' ? taxableBase + vatAmount : taxableBase;

  return {
    itemsGross: toMoney(itemsGross),
    itemsDiscount: toMoney(itemsDiscount),
    itemsNet: toMoney(itemsNet),
    estimateDiscount: toMoney(estimateDiscount),
    taxableBase: toMoney(taxableBase),
    vatAmount: toMoney(vatAmount),
    total: toMoney(total),
  };
};

// Итог по разделу: сумма net всех прямых потомков (в MVP tree плоский).
export const calcSectionNet = (lineNets: readonly string[]): string =>
  toMoney(sumMoney([...lineNets]));
