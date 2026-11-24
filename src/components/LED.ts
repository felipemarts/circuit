import { Diode, readDiodeCard, type DiodeParams } from './Diode';

/**
 * Light-emitting diode: a Diode with LED-like defaults (Is = 1e-20 A, n = 2,
 * about 2 V at a few mA). `new LED()` keeps the legacy behavior; parameters
 * override the defaults (Part('LED-RED-5MM') uses the catalog's fitted card).
 */
export class LED extends Diode {
  override readonly kind: string = 'LED';

  constructor(params?: DiodeParams) {
    super({
      Is: 1e-20,
      n: 2,
      Vt: 0.02585,
      ...(params ? normalizeKeys(params) : {}),
    });
  }

  static override fromModel(card: string): LED {
    const { params, name, diagnostics } = readDiodeCard(card);
    const led = new LED(params);
    led.modelName = name;
    led.modelDiagnostics = diagnostics;
    led.modelCard = card;
    return led;
  }
}

/** Map user keys onto the defaults' spelling so { is: 1e-18 } overrides Is instead of colliding with it. */
function normalizeKeys(params: DiodeParams): DiodeParams {
  const canonical: Record<string, string> = { is: 'Is', n: 'n', vt: 'Vt' };
  const out: DiodeParams = {};
  for (const [k, v] of Object.entries(params)) out[canonical[k.toLowerCase()] ?? k] = v;
  return out;
}
