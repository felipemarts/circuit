/** Op-amps and comparators: ideal VCVS, macro model, open-collector comparator, real parts. */
export { IdealOpAmp } from './IdealOpAmp';
export type { IdealOpAmpParams } from './IdealOpAmp';
export { OpAmp, OPAMP_DEFAULTS } from './OpAmp';
export type { OpAmpParams } from './OpAmp';
export { Comparator, COMPARATOR_DEFAULTS } from './Comparator';
export type { ComparatorParams } from './Comparator';
export { opampPart, opampPartParams, comparatorPartParams, AMPLIFIER_PART_IDS } from './parts';
