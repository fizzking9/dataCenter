/**
 * The one CSV reader the manual file path uses.
 *
 * It follows RFC 4180 for quoting so a business export keeps its exact values:
 * a quoted cell may hold a delimiter or a line break, and a doubled quote is one
 * literal quote. Anything malformed fails closed through the caller's rejection.
 */

export type CsvFailure = (code: string, message: string) => never;

export interface CsvRow {
  /** The physical record number, where the header is row 1. */
  row: number;
  cells: string[];
}

export interface CsvDocument {
  header: string[];
  rows: CsvRow[];
}

interface CsvRecord {
  /** The position of this record in the file, where the header is record 1. */
  position: number;
  cells: string[];
}

/**
 * A record of only empty cells carries no source record, so it is not a row, but
 * it still occupies a line: numbering happens before it is dropped so a Record
 * Rejection locator keeps naming the physical record.
 */
function splitRecords(text: string, fail: CsvFailure): CsvRecord[] {
  const records: CsvRecord[] = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  let index = 0;

  const endRecord = (): void => {
    cells.push(cell);
    records.push({ position: records.length + 1, cells });
    cells = [];
    cell = '';
  };

  while (index < text.length) {
    const character = text[index]!;
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 2;
        continue;
      }
      if (character === '"') {
        quoted = false;
        index += 1;
        continue;
      }
      cell += character;
      index += 1;
      continue;
    }
    if (character === '"') {
      if (cell.length > 0) {
        fail('ACQUISITION_CSV_INVALID', 'A quote may only open a cell at its start.');
      }
      quoted = true;
      index += 1;
      continue;
    }
    if (character === ',') {
      cells.push(cell);
      cell = '';
      index += 1;
      continue;
    }
    if (character === '\r' || character === '\n') {
      endRecord();
      index += character === '\r' && text[index + 1] === '\n' ? 2 : 1;
      continue;
    }
    cell += character;
    index += 1;
  }

  if (quoted) {
    fail('ACQUISITION_CSV_INVALID', 'A quoted cell is not closed.');
  }
  if (cell.length > 0 || cells.length > 0) {
    endRecord();
  }
  return records.filter((record) => record.cells.some((value) => value.length > 0));
}

/** Parses a header-bearing CSV document and rejects ambiguous headers. */
export function parseCsv(text: string, fail: CsvFailure): CsvDocument {
  const records = splitRecords(text.startsWith('\uFEFF') ? text.slice(1) : text, fail);
  const [first, ...rest] = records;
  if (!first) {
    fail('ACQUISITION_CSV_INVALID', 'The file has no header row.');
  }
  const header = first.cells.map((value) => value.trim());
  if (header.some((value) => value.length === 0)) {
    fail('ACQUISITION_HEADER_INVALID', 'Every source column must be named.');
  }
  const seen = new Set<string>();
  for (const column of header) {
    if (seen.has(column)) {
      fail('ACQUISITION_HEADER_INVALID', `The source column ${column} appears more than once.`);
    }
    seen.add(column);
  }
  return {
    header,
    rows: rest.map((record) => ({ row: record.position, cells: record.cells })),
  };
}
