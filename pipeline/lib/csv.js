/**
 * Small RFC 4180-style CSV parser. Handles a UTF-8 BOM, CRLF, quoted fields and doubled quotes.
 * Returns { header: string[], rows: Array<{ line: number, cells: Record<string,string> }> }.
 * `line` is the 1-based file line of the row's first character, for error reports. Blank lines are skipped.
 */
export function parseCsv(text) {
  if (typeof text !== 'string') throw new TypeError('parseCsv expects a string');
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records = [];
  let field = '';
  let rec = [];
  let inQuotes = false;
  let line = 1;
  let recLine = 1;
  let touched = false;

  const endField = () => { rec.push(field); field = ''; };
  const endRecord = () => {
    endField();
    if (touched && !(rec.length === 1 && rec[0].trim() === '')) records.push({ line: recLine, cells: rec });
    rec = [];
    touched = false;
  };

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else {
        if (c === '\n') line++;
        field += c;
      }
      continue;
    }
    if (c === '"' && field === '') { inQuotes = true; touched = true; if (rec.length === 0) recLine = line; continue; }
    if (c === ',') { if (rec.length === 0 && !touched) recLine = line; touched = true; endField(); continue; }
    if (c === '\r') continue;
    if (c === '\n') { endRecord(); line++; recLine = line; continue; }
    if (!touched) { touched = true; recLine = line; }
    field += c;
  }
  if (inQuotes) throw new Error('Unterminated quoted field in CSV');
  if (touched || field !== '' || rec.length > 0) endRecord();

  if (records.length === 0) return { header: [], rows: [] };
  const header = records[0].cells.map((h) => h.trim());
  const rows = records.slice(1).map(({ line: ln, cells }) => {
    const obj = {};
    header.forEach((h, idx) => { if (h !== '') obj[h] = (cells[idx] ?? '').trim(); });
    return { line: ln, cells: obj };
  });
  return { header, rows };
}
