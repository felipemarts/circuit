import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { findDiagnosticDoc } from '../../src/verify/registry';
import { AMPLIFIER_DIAGNOSTIC_DOCS } from '../../src/opamps/registry';

const root = path.resolve(__dirname, '..', '..');
const md = fs.readFileSync(path.join(root, 'docs', 'DIAGNOSTICS.md'), 'utf8');
const agents = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
const broken = fs
  .readdirSync(path.join(root, 'bench', 'broken'))
  .map(f => fs.readFileSync(path.join(root, 'bench', 'broken', f), 'utf8'));

describe('op-amp codes F120–F124 and R420–R425 are registered, documented and seeded', () => {
  it('the family is exactly F120–F124 + R420–R425', () => {
    expect(AMPLIFIER_DIAGNOSTIC_DOCS.map(d => d.code)).toEqual(['F120', 'F121', 'F122', 'F123', 'F124', 'R420', 'R421', 'R422', 'R423', 'R424', 'R425']);
  });
  for (const d of AMPLIFIER_DIAGNOSTIC_DOCS) {
    it(`${d.code} (${d.slug})`, () => {
      expect(findDiagnosticDoc(d.code)).toBe(d);
      expect(d.explanation.length).toBeGreaterThan(200);
      expect(md).toContain(`| \`${d.code}\` | ${d.slug} |`);
      expect(agents).toMatch(new RegExp(d.code.startsWith('R') ? 'R420–R425' : `\\| ${d.code} \\|`));
      // A seeded-broken bench declares it in its header.
      expect(broken.some(src => new RegExp(`Expected:\\s*${d.code}\\b`).test(src))).toBe(true);
    });
  }
});
