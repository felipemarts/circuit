/** Circuit document `circuitsvibe-circuit/1` and share links — browser-safe. */
export { CIRCUIT_SCHEMA } from './types';
export type { CircuitDoc, CircuitMeta, CircuitRatings, CircuitComponent, CircuitSource, CircuitLayout, ComponentPlacement, WireHint } from './types';
export { canonicalJson } from './canonical';
export { toCircuitDoc, benchFromDoc, canonicalizeDoc, stripLocations } from './convert';
export type { DocBenchDescriptor, ToCircuitDocOptions } from './convert';
export { validateCircuitDoc, normalizeDefinitions, canonicalPins } from './validate';
export type { ComponentDefinitions, ValidateOptions, CircuitDocValidation } from './validate';
export { CircuitDocError, isCircuitDocError, DOC_CODES } from './errors';
export {
  encodeShareUrl,
  decodeShareUrl,
  createShareLink,
  base64UrlEncode,
  base64UrlDecode,
  DEFAULT_SHARE_BASE_URL,
  SHARE_ENCODING_VERSION,
  SHARE_WARN_LENGTH,
  SHARE_MAX_LENGTH,
  SHARE_MAX_DOC_BYTES,
} from './share';
export type { ShareOptions, ShareLink } from './share';
