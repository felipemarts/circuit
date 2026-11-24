// Six LEDs on D8–D13, all switched on at once.
import { pinMode, digitalWrite, delay, OUTPUT, HIGH } from 'circuitsvibe/arduino';

const PINS = [8, 9, 10, 11, 12, 13];

export async function setup() {
  for (const p of PINS) {
    pinMode(p, OUTPUT);
    digitalWrite(p, HIGH);
  }
}

export async function loop() {
  await delay(100);
}
