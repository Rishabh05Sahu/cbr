// Synthetic spreadsheet files built in memory for tests (no real customer files, no extra
// dependencies). `zip()` can also produce malformed archives (lying sizes, encrypted flags);
// `xlsx()` writes the smallest OOXML workbook real readers accept.
import { deflateRawSync } from 'node:zlib';

export interface ZipPart {
  name: string;
  data: Uint8Array | string;
  /** Lie about the uncompressed size in the headers. */
  declaredSize?: number;
  encrypted?: boolean;
  store?: boolean;
}

/** Minimal zip writer. */
export function zip(parts: ZipPart[]): Uint8Array {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const p of parts) {
    const raw = Buffer.from(p.data);
    const body = p.store ? raw : deflateRawSync(raw);
    const name = Buffer.from(p.name);
    const size = p.declaredSize ?? raw.length;
    const flags = (p.encrypted ? 1 : 0) | 0x800;
    const method = p.store ? 0 : 8;
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(flags, 6);
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt32LE(body.length, 18);
    lfh.writeUInt32LE(size, 22);
    lfh.writeUInt16LE(name.length, 26);
    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4);
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(flags, 8);
    cdh.writeUInt16LE(method, 10);
    cdh.writeUInt32LE(body.length, 20);
    cdh.writeUInt32LE(size, 24);
    cdh.writeUInt16LE(name.length, 28);
    cdh.writeUInt32LE(offset, 42);
    chunks.push(lfh, name, body);
    central.push(cdh, name);
    offset += lfh.length + name.length + body.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(parts.length, 8);
  eocd.writeUInt16LE(parts.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...chunks, cd, eocd]));
}

/** A cell for `xlsx()`. `{ f, v }` is a formula with its cached value; `{ date }` a dated serial. */
export type XCell =
  string | number | boolean | null | { f: string; v?: number | string } | { date: Date };

const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const colName = (i: number): string =>
  (i >= 26 ? colName(Math.floor(i / 26) - 1) : '') + String.fromCharCode(65 + (i % 26));
const serial = (d: Date) => d.getTime() / 86_400_000 + 25_569;

function cellXml(c: XCell, ref: string): string {
  if (c === null) return '';
  if (typeof c === 'string') return `<c r="${ref}" t="inlineStr"><is><t>${esc(c)}</t></is></c>`;
  if (typeof c === 'number') return `<c r="${ref}"><v>${c}</v></c>`;
  if (typeof c === 'boolean') return `<c r="${ref}" t="b"><v>${c ? 1 : 0}</v></c>`;
  if ('date' in c) return `<c r="${ref}" s="1"><v>${serial(c.date)}</v></c>`;
  const v = c.v === undefined ? '' : `<v>${esc(String(c.v))}</v>`;
  return `<c r="${ref}"${typeof c.v === 'string' ? ' t="str"' : ''}><f>${esc(c.f)}</f>${v}</c>`;
}

/** Smallest workbook read-excel-file accepts. Rows are 1-based in order; `null` rows are gaps. */
export function xlsx(
  sheets: Record<string, (XCell[] | null)[]>,
  extra: ZipPart[] = [],
): Uint8Array {
  const names = Object.keys(sheets);
  const sheetParts = names.map((name, i) => {
    const rows = sheets[name]!.map((row, r) =>
      row === null
        ? ''
        : `<row r="${r + 1}">${row.map((c, k) => cellXml(c, `${colName(k)}${r + 1}`)).join('')}</row>`,
    ).join('');
    return {
      name: `xl/worksheets/sheet${i + 1}.xml`,
      data: `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="${NS}"><sheetData>${rows}</sheetData></worksheet>`,
    };
  });
  return zip([
    {
      name: '[Content_Types].xml',
      data: `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>`,
    },
    {
      name: '_rels/.rels',
      data: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    {
      name: 'xl/workbook.xml',
      data: `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="${NS}" xmlns:r="${REL}"><sheets>${names
        .map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
        .join('')}</sheets></workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${names
        .map(
          (_, i) =>
            `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
        )
        .join(
          '',
        )}<Relationship Id="rIdS" Type="${REL}/styles" Target="styles.xml"/></Relationships>`,
    },
    {
      name: 'xl/styles.xml',
      data: `<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="${NS}"><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/></cellXfs></styleSheet>`,
    },
    ...sheetParts,
    ...extra,
  ]);
}
