// Potentiometer → analogRead(A0) → analogWrite(D9) duty, reported on Serial.
import { pinMode, analogRead, analogWrite, delay, Serial, OUTPUT, A0 } from 'circuitsvibe/arduino';

export async function setup() {
  Serial.begin(115200);
  pinMode(9, OUTPUT);
}

export async function loop() {
  const code = analogRead(A0); // 10-bit: floor(Vin · 1024 / 5 V)
  analogWrite(9, code >> 2); // 0..255 → 490 Hz phase-correct PWM, duty = value / 255
  Serial.println(code);
  await delay(100);
}
