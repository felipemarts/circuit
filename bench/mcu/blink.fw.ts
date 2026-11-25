// Blink: D13 toggles every 500 ms (firmware time = simulation time).
import { pinMode, digitalWrite, delay, OUTPUT, HIGH, LOW, LED_BUILTIN, Serial } from 'circuitsvibe/arduino';

export async function setup() {
  Serial.begin(9600);
  pinMode(LED_BUILTIN, OUTPUT);
  Serial.println('blink ready');
}

export async function loop() {
  digitalWrite(LED_BUILTIN, HIGH);
  await delay(500);
  digitalWrite(LED_BUILTIN, LOW);
  await delay(500);
}
