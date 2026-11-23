/** npm package name — also the module specifier bench files import from. */
export const PACKAGE_NAME = 'circuitsvibe';

/** Kept in sync with package.json (asserted by tests/platform/package.test.ts). */
export const VERSION = '0.1.0';

/** Engine identity pinned into every RunRecord, for replay comparisons. */
export const ENGINE = `${PACKAGE_NAME}@${VERSION}`;

/** CLI command name used in every user-facing hint (`circuitsvibe explain F101`). */
export const CLI = PACKAGE_NAME;

/** RunRecord schema identifier. */
export const RUN_SCHEMA = 'circuitsvibe-run/0.1';
