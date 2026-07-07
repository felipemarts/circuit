import { Diode } from './Diode';

export class LED extends Diode {
  override readonly kind: string = 'LED';

  constructor() {
    super({
      Is: 1e-20,
      n: 2,
      Vt: 0.02585,
    });
  }
}
