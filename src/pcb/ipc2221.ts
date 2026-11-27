/**
 * Current capacity of a PCB conductor — IPC-2221B §6.2 (the curve fit of the
 * IPC-2152 predecessor charts):
 *
 *   I = k · ΔT^0.44 · A^0.725        A in mil², ΔT in °C, I in A
 *   k = 0.048 for outer layers (0.024 for inner layers)
 *
 * A = width × copper thickness; 1 oz/ft² of copper is 34.79 µm (1.37 mil).
 * Valid up to about 35 A, 400 mil wide, ΔT 10–100 °C: a conservative
 * figure for traces in still air.
 */
const MIL_PER_MM = 1 / 0.0254;
const MIL_PER_OZ = 1.37;
const K_OUTER = 0.048;

export const IPC2221_SOURCE = 'IPC-2221B §6.2, conductor current capacity, outer layer (I = 0.048·ΔT^0.44·A^0.725)';

/** Largest current (A) a trace of `width` mm carries with a `tempRise` °C rise, on an outer layer of `copperOz` copper. */
export function traceCapacity(width: number, copperOz: number, tempRise: number): number {
  const area = width * MIL_PER_MM * copperOz * MIL_PER_OZ;
  return K_OUTER * Math.pow(tempRise, 0.44) * Math.pow(area, 0.725);
}

/** Narrowest trace (mm) that carries `current` A with a `tempRise` °C rise, on an outer layer of `copperOz` copper. */
export function requiredWidth(current: number, copperOz: number, tempRise: number): number {
  if (!(current > 0)) return 0;
  const area = Math.pow(current / (K_OUTER * Math.pow(tempRise, 0.44)), 1 / 0.725);
  return area / (copperOz * MIL_PER_OZ) / MIL_PER_MM;
}
