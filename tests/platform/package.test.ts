import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ENGINE, PACKAGE_NAME, VERSION, RUN_SCHEMA } from '../../src/schema/version';

const repo = path.resolve(__dirname, '..', '..');
const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));

describe('package contract', () => {
  it('engine identity matches package.json', () => {
    expect(PACKAGE_NAME).toBe(pkg.name);
    expect(VERSION).toBe(pkg.version);
    expect(ENGINE).toBe(`${pkg.name}@${pkg.version}`);
    expect(RUN_SCHEMA).toBe('circuitsvibe-run/0.1');
  });

  it('has no runtime dependencies and ships only prebuilt files', () => {
    expect(pkg.dependencies ?? {}).toEqual({});
    expect(pkg.license).toBe('MIT');
    expect(fs.existsSync(path.join(repo, 'LICENSE'))).toBe(true);
    expect(pkg.files).not.toContain('src');
    for (const bin of Object.values(pkg.bin) as string[]) expect(bin.startsWith('dist/')).toBe(true);
    expect(pkg.exports['.'].import).toMatch(/^\.\/dist\//);
  });
});
