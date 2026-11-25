// Firmware entry importing a relative helper module.
import { Serial, delay } from 'circuitsvibe/arduino';
import { label } from './lib/fmt';

let n = 0;

export async function setup() {
  Serial.begin(9600);
}

export async function loop() {
  n++;
  Serial.println(label(n));
  if (n === 3) throw new Error('third pass');
  await delay(10);
}
