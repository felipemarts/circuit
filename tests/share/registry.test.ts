import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DOC_CODES } from '../../src/doc/errors';
import { DIAGNOSTIC_DOCS, findDiagnosticDoc } from '../../src/verify/registry';
import { repo } from './helpers';

describe('circuit document / share codes are registered and documented', () => {
  const md = fs.readFileSync(path.join(repo, 'docs', 'DIAGNOSTICS.md'), 'utf8');
  for (const [code, slug] of Object.entries(DOC_CODES)) {
    it(`${code} (${slug})`, () => {
      expect(code).toMatch(/^T0(1\d|2\d)$/);
      const doc = findDiagnosticDoc(code);
      expect(doc, code).toBeDefined();
      expect(doc!.slug).toBe(slug);
      expect(doc!.explanation.length).toBeGreaterThan(80);
      expect(md).toContain(`| \`${code}\` | ${slug} |`);
    });
  }
  it('codes are unique', () => {
    expect(new Set(DIAGNOSTIC_DOCS.map(d => d.code)).size).toBe(DIAGNOSTIC_DOCS.length);
  });
});
