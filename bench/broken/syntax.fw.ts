// A firmware file that does not compile (missing closing parenthesis).
import { pinMode, OUTPUT } from 'circuitsvibe/arduino';

export async function setup() {
  pinMode(13, OUTPUT;
}

export async function loop() {}
