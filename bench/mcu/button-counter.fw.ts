// Counts button presses on D2 (INPUT_PULLUP, interrupt on the FALLING edge) and
// prints the count from loop(); D13 mirrors the count's parity.
import { pinMode, digitalWrite, attachInterrupt, digitalPinToInterrupt, delay, Serial, INPUT_PULLUP, OUTPUT, FALLING } from 'circuitsvibe/arduino';

let presses = 0;
let reported = 0;

function onPress() {
  presses++;
}

export async function setup() {
  Serial.begin(9600);
  pinMode(2, INPUT_PULLUP);
  pinMode(13, OUTPUT);
  attachInterrupt(digitalPinToInterrupt(2), onPress, FALLING);
}

export async function loop() {
  if (presses !== reported) {
    reported = presses;
    digitalWrite(13, reported % 2);
    Serial.println(`presses=${reported}`);
  }
  await delay(5);
}
