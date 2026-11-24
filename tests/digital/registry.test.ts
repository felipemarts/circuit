import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { DIGITAL_CODES } from '../../src/digital';
import { findDiagnosticDoc } from '../../src/verify/registry';

describe('digital diagnostic codes are registered', () => {
  const md = fs.readFileSync(path.resolve(__dirname, '../../docs/DIAGNOSTICS.md'), 'utf8');

  for (const info of Object.values(DIGITAL_CODES)) {
    it(`${info.code} (${info.slug})`, () => {
      expect(info.code).toMatch(/^(D5([0-3]\d|4[0-9])|F13\d)$/);
      const doc = findDiagnosticDoc(info.code);
      expect(doc, `registry entry for ${info.code}`).toBeDefined();
      expect(doc!.slug).toBe(info.slug);
      expect(doc!.explanation.length).toBeGreaterThan(80);
      expect(md).toContain(`| \`${info.code}\` | ${info.slug} | ${info.severity} |`);
    });
  }
});
