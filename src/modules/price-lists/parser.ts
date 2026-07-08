import * as XLSX from 'xlsx';
import type { AutoMapping, ProductField } from '@smeteora/shared';
import { ValidationError } from '../../lib/errors.js';

// Парсер файла прайс-листа. Поддерживает .xlsx, .xls и .csv/tsv — SheetJS сам
// определяет формат по сигнатуре буфера. Возвращает первую страницу как
// массив строк-строк (все ячейки приведены к string через raw:false).
//
// codepage: 65001 — говорит парсеру, что CSV в UTF-8. Русские CSV, сохранённые
// из Excel в cp1251, отдадут кракозябры — юзер пересохранит в UTF-8, это дешевле,
// чем таскать cptable в бандл.

export type ParsedSheet = {
  readonly headers: string[];
  readonly rows: string[][];
  readonly source: 'csv' | 'xlsx';
};

const XLSX_MIME_MARKERS = ['sheet', 'excel', 'spreadsheet', 'ms-excel', 'openxmlformats'];

const CSV_MIME_MARKERS = ['csv', 'comma-separated', 'text/plain'];

// Определяем канал загрузки по MIME/filename. Нужно для price_list_uploads.source.
export const detectSource = (params: {
  mimeType: string | null | undefined;
  filename: string;
}): 'csv' | 'xlsx' => {
  const mime = (params.mimeType ?? '').toLowerCase();
  const lowerName = params.filename.toLowerCase();
  if (
    lowerName.endsWith('.xlsx') ||
    lowerName.endsWith('.xls') ||
    XLSX_MIME_MARKERS.some((m) => mime.includes(m))
  ) {
    return 'xlsx';
  }
  if (
    lowerName.endsWith('.csv') ||
    lowerName.endsWith('.tsv') ||
    CSV_MIME_MARKERS.some((m) => mime.includes(m))
  ) {
    return 'csv';
  }
  // Дефолт — trust filename, юзер знает что грузит.
  throw new ValidationError('Поддерживаются только файлы .xlsx, .xls, .csv, .tsv');
};

export const parseSheet = (buffer: Buffer, source: 'csv' | 'xlsx'): ParsedSheet => {
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(buffer, {
      type: 'buffer',
      codepage: 65001,
      raw: false,
    });
  } catch (err) {
    throw new ValidationError(
      `Не удалось прочитать файл: ${err instanceof Error ? err.message : 'неизвестная ошибка'}`,
    );
  }

  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new ValidationError('Файл не содержит листов');
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) throw new ValidationError('Не удалось прочитать первый лист');

  // header: 1 — читаем как массив массивов, без биндинга к заголовкам.
  // defval: '' — пустые ячейки становятся '', а не undefined.
  // blankrows: false — пустые строки выбрасываем сразу.
  const table = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: '',
    blankrows: false,
    raw: false,
  });

  if (table.length === 0) throw new ValidationError('Файл пустой');

  const cellToString = (cell: unknown): string => {
    if (cell === null || cell === undefined) return '';
    if (typeof cell === 'string') return cell.trim();
    if (typeof cell === 'number' || typeof cell === 'boolean') return String(cell);
    return String(cell).trim();
  };

  const headerRow = table[0] ?? [];
  const headers = headerRow.map((c, i) => {
    const v = cellToString(c);
    return v.length > 0 ? v : `Колонка ${i + 1}`;
  });

  const rows: string[][] = [];
  for (let i = 1; i < table.length; i += 1) {
    const row = table[i] ?? [];
    // Выравниваем длину до headers — SheetJS может отдать более короткие строки.
    const normalized: string[] = [];
    for (let c = 0; c < headers.length; c += 1) {
      normalized.push(cellToString(row[c]));
    }
    // Полностью пустые строки не считаем — но blankrows:false уже отфильтровало.
    if (normalized.some((v) => v.length > 0)) rows.push(normalized);
  }

  return { headers, rows, source };
};

// ── Автомаппинг ─────────────────────────────────────────────────
// Нормализация: lower + убираем всё, что не буква/цифра. Так
// «Ед. изм.» → «едизм», «Цена, руб» → «ценаруб».
const normalizeHeader = (h: string): string => h.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

const ALIASES: Readonly<Record<ProductField, readonly string[]>> = Object.freeze({
  name: [
    'наименование',
    'название',
    'товар',
    'номенклатура',
    'позиция',
    'name',
    'product',
    'title',
    'productname',
  ],
  sku: [
    'артикул',
    'код',
    'кодтовара',
    'sku',
    'article',
    'articul',
    'productcode',
    'model',
    'модель',
    'парткод',
    'partnumber',
  ],
  brand: [
    'бренд',
    'производитель',
    'марка',
    'изготовитель',
    'brand',
    'manufacturer',
    'vendor',
    'maker',
  ],
  unit: [
    'единица',
    'единицаизмерения',
    'ед',
    'едизм',
    'едизмерения',
    'unit',
    'measure',
    'unitofmeasure',
    'uom',
    'мера',
  ],
  // Продажная: то, что мы выставим клиенту. Розница/РРЦ/рекомендованная.
  // Общее «цена» тоже сюда — по умолчанию считаем что «цена» = продажа.
  sellPrice: [
    'ценарозница',
    'ценарекомендованная',
    'ценапродажи',
    'розница',
    'ррц',
    'рекомендованнаяцена',
    'ценасндс',
    'ценаснндс',
    'ценасбндс',
    'цена',
    'ценаруб',
    'стоимость',
    'sellprice',
    'retailprice',
    'msrp',
    'rrc',
    'price',
  ],
  // Закупочная: что мы платим поставщику. Опт/закуп/вход.
  buyPrice: [
    'ценазакупки',
    'ценазакупочная',
    'закупочнаяцена',
    'закупка',
    'ценаопт',
    'ценаоптовая',
    'опт',
    'ценавходная',
    'входнаяцена',
    'вх',
    'buyprice',
    'purchaseprice',
    'costprice',
    'cost',
    'wholesale',
  ],
  category: [
    'категория',
    'группа',
    'раздел',
    'подгруппа',
    'группатоваров',
    'category',
    'group',
    'section',
  ],
  description: [
    'описание',
    'описаниетовара',
    'комментарий',
    'детали',
    'характеристики',
    'description',
    'details',
    'notes',
  ],
});

// Собираем «лучший индекс» для каждого поля — первое совпадение в порядке
// приоритета алиасов (в списке они от самого специфичного к общему).
export const autoDetectMapping = (headers: string[]): AutoMapping => {
  const normalized = headers.map(normalizeHeader);
  const usedIndexes = new Set<number>();

  const findFor = (field: ProductField): number | null => {
    const aliases = ALIASES[field];
    // Точное совпадение — приоритет.
    for (const alias of aliases) {
      const idx = normalized.findIndex((h, i) => h === alias && !usedIndexes.has(i));
      if (idx !== -1) return idx;
    }
    // Contains-совпадение — fallback (для составных: «наименование_товара» и т.п.).
    for (const alias of aliases) {
      const idx = normalized.findIndex((h, i) => h.includes(alias) && !usedIndexes.has(i));
      if (idx !== -1) return idx;
    }
    return null;
  };

  const result: AutoMapping = {
    name: null,
    sku: null,
    brand: null,
    unit: null,
    sellPrice: null,
    buyPrice: null,
    category: null,
    description: null,
  };

  // Порядок важен — name самый «жадный», он первым забирает свою колонку.
  // buyPrice раньше sellPrice: чтобы явная «закупочная» ушла в buy, а общая
  // «цена» (алиас на самом «дне» списка sellPrice) не перехватила её contains-ом.
  const order: ProductField[] = [
    'name',
    'sku',
    'brand',
    'buyPrice',
    'sellPrice',
    'unit',
    'category',
    'description',
  ];
  for (const field of order) {
    const idx = findFor(field);
    if (idx !== null) {
      result[field] = idx;
      usedIndexes.add(idx);
    }
  }
  return result;
};

// ── Нормализация цены ────────────────────────────────────────────
// «1 234,56 ₽» → «1234.56». Возвращает decimal-as-string совместимый с
// numeric(14,4). Null если пусто; throw если нечитаемо.
export const parsePriceCell = (raw: string): string | null => {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  // Убираем разделители тысяч (пробелы, неразрывный пробел, апостроф),
  // валютные знаки, буквы. Оставляем цифры, запятую, точку, минус.
  const cleaned = trimmed
    .replace(/[\s\u00A0']/g, '')
    .replace(/[₽€$₴¥£₽руб.]/gi, '')
    .replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) {
    throw new ValidationError(`не удалось распознать цену «${raw}»`);
  }
  const n = Number(cleaned);
  if (!Number.isFinite(n)) {
    throw new ValidationError(`не удалось распознать цену «${raw}»`);
  }
  if (n < 0) {
    throw new ValidationError(`цена не может быть отрицательной («${raw}»)`);
  }
  // decimal-as-string. Хвостовые нули отсекать не будем — Postgres сам нормализует.
  return n.toFixed(4);
};
