// ATtiny85: four LEDs on PB0–PB3, all on.
import { pinMode, digitalWrite, delay, OUTPUT, HIGH } from 'circuitsvibe/arduino';

export async function setup() {
  for (const p of [0, 1, 2, 3]) {
    pinMode(p, OUTPUT);
    digitalWrite(p, HIGH);
  }
}

export async function loop() {
  await delay(100);
}
