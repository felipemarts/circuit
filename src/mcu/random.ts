/**
 * Deterministic PRNG with Arduino semantics.
 *
 * The generator is avr-libc's random() (Park–Miller "minimal standard",
 * x ← 16807·x mod (2^31 − 1), Schrage's method; initial state 1), which is
 * what ArduinoCore-avr's random()/randomSeed() sit on — so an Uno firmware
 * gets the same sequence it would on hardware. Other profiles use the same
 * generator (their real cores use hardware RNGs, which a reproducible
 * simulator must not imitate).
 *
 * Source: avr-libc libc/stdlib/random.c (do_random), ArduinoCore-avr
 * cores/arduino/WMath.cpp (random(howbig), random(min, max), randomSeed).
 */

export const RANDOM_MAX = 0x7fffffff;

export class ArduinoRandom {
  private state: number;

  constructor(seed = 1) {
    this.state = seed >>> 0;
  }

  /** avr-libc random(): 0..RANDOM_MAX. */
  next(): number {
    // `long x = *ctx` — reinterpret the unsigned state as a signed 32-bit long.
    let x = this.state | 0;
    if (x === 0) x = 123459876;
    const hi = Math.trunc(x / 127773);
    const lo = x % 127773;
    x = 16807 * lo - 2836 * hi;
    if (x < 0) x += 0x7fffffff;
    this.state = x >>> 0;
    return x % (RANDOM_MAX + 1);
  }

  /** Arduino randomSeed(seed): a zero seed is ignored, like the core. */
  seed(seed: number): void {
    const s = Math.trunc(Number(seed)) >>> 0;
    if (s !== 0) this.state = s;
  }

  /** Arduino random(max) / random(min, max) — integer, max exclusive. */
  random(a?: number, b?: number): number {
    if (a === undefined) return this.next();
    if (b === undefined) {
      const howbig = Math.trunc(a);
      if (howbig === 0) return 0;
      return this.next() % howbig;
    }
    const lo = Math.trunc(a);
    const hi = Math.trunc(b);
    if (lo >= hi) return lo;
    return this.random(hi - lo) + lo;
  }
}
