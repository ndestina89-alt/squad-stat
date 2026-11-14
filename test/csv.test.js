import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv } from '../pipeline/lib/csv.js';

test('parses BOM, CRLF, quotes, doubled quotes and embedded newlines', () => {
  const text = '﻿a,b,c\r\n1,"x, y",3\r\n"he said ""hi""","multi\nline",z\r\n';
  const { header, rows } = parseCsv(text);
  assert.deepEqual(header, ['a', 'b', 'c']);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0].cells, { a: '1', b: 'x, y', c: '3' });
  assert.equal(rows[1].cells.a, 'he said "hi"');
  assert.equal(rows[1].cells.b, 'multi\nline');
});

test('reports 1-based line numbers, including after a multi-line field', () => {
  const { rows } = parseCsv('a,b\n1,2\n"x\ny",3\n4,5\n');
  assert.deepEqual(rows.map((r) => r.line), [2, 3, 5]);
});

test('skips blank lines, pads short rows, ignores extra cells', () => {
  const { rows } = parseCsv('a,b,c\n\n1,2\n3,4,5,6\n   \n');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0].cells, { a: '1', b: '2', c: '' });
  assert.deepEqual(rows[1].cells, { a: '3', b: '4', c: '5' });
});

test('keeps all-comma rows (they are rejected later with a reason, not dropped silently)', () => {
  const { rows } = parseCsv('a,b\n,\n1,2\n');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0].cells, { a: '', b: '' });
});

test('handles a final line without a newline and an empty input', () => {
  assert.equal(parseCsv('a,b\n1,2').rows.length, 1);
  assert.deepEqual(parseCsv(''), { header: [], rows: [] });
});

test('throws on an unterminated quote and on non-string input', () => {
  assert.throws(() => parseCsv('a,b\n"oops,2\n'), /Unterminated/);
  assert.throws(() => parseCsv(null), TypeError);
});
