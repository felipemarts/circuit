// Firmware that throws after the first second: readings[] has 4 entries.
import { analogRead, delay, Serial, A0 } from 'circuitsvibe/arduino';

const readings: number[] = [];

export async function setup() {
  Serial.begin(9600);
}

export async function loop() {
  readings.push(analogRead(A0));
  if (readings.length > 4) {
    throw new RangeError(`buffer full (${readings.length} readings)`);
  }
  await delay(250);
}
