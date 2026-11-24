/**
 * Firmware lint (F140–F149) — static checks over firmware source text, run
 * before simulation, in the spirit of the circuit lint: catch the mistakes
 * that would otherwise surface as a hang, a silent no-op or a confusing
 * runtime diagnostic. Token-based (see instrument.ts), so comments and
 * strings never produce false positives. Heuristic by nature: every finding
 * names the line and the fix.
 */

import type { McuDiagnostic, McuProfile, PinSpec } from './types';
import { ATMEGA328P_UNO } from './profiles';
import { mcuDiagnostic, type McuCode, type DiagFields } from './diagnostics';
import { tokenize, matchBracket, lineOf, type Token } from './instrument';

export interface FirmwareLintOptions {
  /** Location prefix for `at` (cwd-relative path). Default 'firmware'. */
  file?: string;
  /** Part the firmware targets (default: ATmega328P / Uno). */
  profile?: McuProfile;
}

interface Call {
  name: string;
  /** Member root for `Serial.print` style calls. */
  object?: string;
  nameIdx: number;
  open: number;
  close: number;
  /** Token index ranges [start, end) of each top-level argument. */
  args: [number, number][];
}

const SIMPLE_PIN_APIS = ['pinMode', 'digitalWrite', 'digitalRead', 'analogWrite', 'tone', 'noTone', 'digitalPinToInterrupt'];

const UNSUPPORTED: Record<string, string> = {
  pulseIn: 'measure the pulse with attachInterrupt(…, CHANGE) and micros()',
  pulseInLong: 'measure the pulse with attachInterrupt(…, CHANGE) and micros()',
  shiftIn: 'bit-bang with digitalWrite/digitalRead and `await delayMicroseconds(…)` between edges',
  shiftOut: 'bit-bang with digitalWrite and `await delayMicroseconds(…)` between clock edges',
  analogWriteFrequency: 'PWM runs at the core default frequency of each pin',
  analogWriteFreq: 'PWM runs at the core default frequency of each pin',
  analogWriteResolution: 'analogWrite takes 0..255',
  analogWriteRange: 'analogWrite takes 0..255',
  ledcWrite: 'use analogWrite(pin, 0..255)',
  ledcAttach: 'use analogWrite(pin, 0..255)',
  ledcSetup: 'use analogWrite(pin, 0..255)',
  Wire: 'I2C is not simulated yet',
  SPI: 'SPI is not simulated yet',
  EEPROM: 'EEPROM is not simulated yet — keep state in variables',
  Serial1: 'only Serial is captured',
  Serial2: 'only Serial is captured',
  yield: 'use `await delay(0)` to yield',
};

const HOST_APIS: { root: string; member?: string; detail: string }[] = [
  { root: 'Date', member: 'now', detail: 'use millis()/micros() — firmware time is simulation time' },
  { root: 'Date', detail: 'use millis()/micros() — firmware time is simulation time' },
  { root: 'performance', member: 'now', detail: 'use micros() — firmware time is simulation time' },
  { root: 'setTimeout', detail: 'use `await delay(ms)`, or Timer1 for periodic callbacks' },
  { root: 'setInterval', detail: 'use Timer1.initialize(us) + Timer1.attachInterrupt(fn), or a loop with `await delay(ms)`' },
  { root: 'setImmediate', detail: 'use `await delay(0)`' },
  { root: 'queueMicrotask', detail: 'call the function directly' },
  { root: 'Math', member: 'random', detail: 'use random(max) / random(min, max) — seeded and reproducible' },
  { root: 'process', detail: 'firmware cannot access the host process' },
  { root: 'fetch', detail: 'firmware cannot access the network' },
];

export function lintFirmware(source: string, opts: FirmwareLintOptions = {}): McuDiagnostic[] {
  const file = opts.file ?? 'firmware';
  const profile = opts.profile ?? ATMEGA328P_UNO;
  const all = tokenize(source);
  const toks = all.filter(t => t.type !== 'comment');
  const out: McuDiagnostic[] = [];
  const at = (tok: Token): string => `${file}:${lineOf(source, tok.start)}`;
  const emit = (code: McuCode, tok: Token, f: Omit<DiagFields, 'at'>): void => {
    out.push(mcuDiagnostic(code, { ...f, at: at(tok) }));
  };
  const isId = (k: number, text?: string): boolean => toks[k]?.type === 'ident' && (text === undefined || toks[k].text === text);
  const isP = (k: number, text: string): boolean => toks[k]?.type === 'punct' && toks[k].text === text;
  const textOf = (a: number, b: number): string => source.slice(toks[a].start, toks[b - 1].end);

  // ── collect calls ──
  const calls: Call[] = [];
  for (let k = 0; k < toks.length; k++) {
    if (toks[k].type !== 'ident' || !isP(k + 1, '(')) continue;
    const close = matchBracket(toks, k + 1);
    if (close < 0) continue;
    const args: [number, number][] = [];
    let depth = 0;
    let s = k + 2;
    for (let j = k + 2; j < close; j++) {
      const t = toks[j];
      if (t.type !== 'punct') continue;
      if (t.text === '(' || t.text === '[' || t.text === '{') depth++;
      else if (t.text === ')' || t.text === ']' || t.text === '}') depth--;
      else if (t.text === ',' && depth === 0) {
        args.push([s, j]);
        s = j + 1;
      }
    }
    if (s < close) args.push([s, close]);
    const object = isP(k - 1, '.') && isId(k - 2) ? toks[k - 2].text : undefined;
    if (isP(k - 1, '.') && !object) continue;
    calls.push({ name: toks[k].text, object, nameIdx: k, open: k + 1, close, args });
  }

  // ── simple constant resolution: const NAME = <literal | constant> ──
  const consts = new Map<string, string>();
  const declared = new Set<string>();
  for (let k = 0; k < toks.length; k++) {
    if (isId(k, 'function') && isId(k + 1)) declared.add(toks[k + 1].text);
    if (!(isId(k, 'const') || isId(k, 'let') || isId(k, 'var')) || !isId(k + 1)) continue;
    declared.add(toks[k + 1].text);
    let j = k + 2;
    if (isP(j, ':')) j += 2; // `: number`
    if (!isP(j, '=')) continue;
    const v = toks[j + 1];
    if (!v || !(v.type === 'number' || v.type === 'string' || v.type === 'ident')) continue;
    const nxt = toks[j + 2];
    const terminated = !nxt || isP(j + 2, ';') || isP(j + 2, ',') || source.slice(v.end, nxt.start).includes('\n');
    if (terminated) consts.set(toks[k + 1].text, v.text);
  }

  const valueOf = (text: string, depth = 0): number | string | undefined => {
    const s = text.trim();
    if (/^\d+$/.test(s)) return Number(s);
    if (/^0x[0-9a-f]+$/i.test(s)) return Number(s);
    const str = s.match(/^(['"])(.*)\1$/);
    if (str) return str[2];
    if (/^[A-Za-z_$][\w$]*$/.test(s)) {
      if (s in profile.constants) return profile.constants[s];
      const c = consts.get(s);
      if (c !== undefined && depth < 4) return valueOf(c, depth + 1);
    }
    return undefined;
  };
  const argText = (c: Call, i: number): string | undefined => (c.args[i] ? textOf(c.args[i][0], c.args[i][1]) : undefined);
  const pinFor = (v: number | string, numbers: Record<string, string>): PinSpec | undefined => {
    if (typeof v === 'number') {
      const name = numbers[String(v)];
      return name ? profile.pins.find(p => p.name === name) : undefined;
    }
    return profile.pins.find(p => p.name.toUpperCase() === v.toUpperCase());
  };
  const pwmList = profile.pins.filter(p => p.pwm).map(p => p.name).join(', ');
  const adcList = profile.pins.filter(p => p.adc !== undefined).map(p => p.name).join(', ');

  // ── F140: delay() not awaited ──
  for (const c of calls) {
    if (c.object || (c.name !== 'delay' && c.name !== 'delayMicroseconds')) continue;
    const prev = toks[c.nameIdx - 1];
    if (prev && prev.type === 'ident' && ['await', 'return', 'function', 'yield'].includes(prev.text)) continue;
    if (prev && prev.type === 'punct' && prev.text === '>' && isP(c.nameIdx - 2, '=')) continue; // => delay(…)
    if (isP(c.close + 1, '.') && isId(c.close + 2, 'then')) continue;
    emit('F140', toks[c.nameIdx], {
      message: `${c.name}(${argText(c, 0) ?? ''}) is not awaited — it will not wait`,
      subject: { api: c.name },
      note: 'delay() returns a promise; the simulated wait only happens when the firmware awaits it. Without await the next statement runs immediately (runtime diagnostic M605)',
      fixes: [{ kind: 'add-await', confidence: 'mechanical', detail: `write \`await ${c.name}(${argText(c, 0) ?? ''})\` and make the enclosing function async` }],
    });
  }

  // ── F141: entry points ──
  const exported = (name: string): boolean => {
    for (let k = 0; k < toks.length; k++) {
      if (!isId(k, 'export')) continue;
      let j = k + 1;
      if (isId(j, 'async')) j++;
      if (isId(j, 'function')) {
        j++;
        if (isP(j, '*')) j++;
        if (isId(j, name)) return true;
      }
      if ((isId(k + 1, 'const') || isId(k + 1, 'let') || isId(k + 1, 'var')) && isId(k + 2, name)) return true;
      if (isP(k + 1, '{')) {
        const close = matchBracket(toks, k + 1);
        for (let m = k + 2; m < close; m++) {
          if (isId(m, name) && !isId(m - 1, 'as')) return true;
          if (isId(m, 'as') && isId(m + 1, name)) return true;
        }
      }
    }
    return false;
  };
  const hasSetup = exported('setup');
  const hasLoop = exported('loop');
  if (!hasSetup || !hasLoop) {
    const first = toks[0] ?? ({ start: 0 } as Token);
    emit('F141', first, {
      severity: !hasSetup && !hasLoop ? 'error' : 'warning',
      message: !hasSetup && !hasLoop ? 'firmware exports neither setup() nor loop()' : `firmware does not export ${hasSetup ? 'loop' : 'setup'}()`,
      note: 'the runtime calls the exported setup() once at t = 0, then the exported loop() forever',
      fixes: [
        {
          kind: 'export-entry-points',
          confidence: 'mechanical',
          detail: `add \`export async function ${hasSetup ? 'loop' : 'setup'}() { … }\``,
        },
      ],
    });
  }

  // ── F142: synchronous polling loops ──
  const POLL = new Set(['digitalRead', 'analogRead', 'millis', 'micros', 'available']);
  for (let k = 0; k < toks.length; k++) {
    if (!isId(k, 'while') || !isP(k + 1, '(') || isP(k - 1, '.')) continue;
    const cClose = matchBracket(toks, k + 1);
    if (cClose < 0) continue;
    let body: [number, number];
    if (isP(k - 1, '}')) {
      // do { … } while (cond) — find the block's opening brace.
      let depth = 0;
      let open = -1;
      for (let j = k - 1; j >= 0; j--) {
        if (isP(j, '}')) depth++;
        else if (isP(j, '{') && --depth === 0) {
          open = j;
          break;
        }
      }
      body = open > 0 && isId(open - 1, 'do') ? [open, k] : [k + 1, k + 1];
    } else if (isP(cClose + 1, '{')) {
      body = [cClose + 1, matchBracket(toks, cClose + 1) + 1];
    } else {
      let j = cClose + 1;
      while (j < toks.length && !isP(j, ';')) j++;
      body = [cClose + 1, j + 1];
    }
    const cond = toks.slice(k + 2, cClose);
    const polls = cond.some(t => t.type === 'ident' && POLL.has(t.text));
    if (!polls) continue;
    const range = [...cond, ...toks.slice(body[0], body[1])];
    if (range.some(t => t.type === 'ident' && t.text === 'await')) continue;
    emit('F142', toks[k], {
      message: `while (${textOf(k + 2, cClose)}) never awaits — the condition can never change`,
      note: 'firmware runs in zero simulated time between awaits: inputs, millis() and micros() only change when the firmware yields, so a synchronous polling loop spins forever (runtime diagnostic M602)',
      fixes: [
        { kind: 'await-in-loop', confidence: 'mechanical', detail: 'add `await delay(1)` (or `await delayMicroseconds(10)`) inside the loop body' },
        { kind: 'use-interrupt', confidence: 'suggested', detail: 'or react to the input edge with attachInterrupt(digitalPinToInterrupt(pin), handler, FALLING)' },
      ],
    });
  }

  // ── F143 / F144: pin capabilities ──
  for (const c of calls) {
    if (c.object) continue;
    const isAnalogRead = c.name === 'analogRead';
    if (!isAnalogRead && !SIMPLE_PIN_APIS.includes(c.name)) continue;
    if (declared.has(c.name)) continue;
    const raw = argText(c, 0);
    if (raw === undefined) continue;
    const v = valueOf(raw);
    if (v === undefined) continue;
    const spec = pinFor(v, isAnalogRead ? profile.analogNumbers : profile.digitalNumbers);
    const tok = toks[c.nameIdx];
    if (!spec) {
      emit('F144', tok, {
        message: `${c.name}(${raw}): no such pin on ${profile.part} (${profile.board})`,
        subject: { api: c.name },
        note: `pins: ${profile.pins.map(p => p.name).join(', ')}`,
        fixes: [{ kind: 'use-existing-pin', confidence: 'suggested', detail: 'use a pin that exists on this part' }],
      });
      continue;
    }
    if (isAnalogRead && spec.adc === undefined) {
      emit('F144', tok, {
        message: `analogRead(${raw}): ${spec.name} has no ADC channel on ${profile.part}`,
        subject: { api: 'analogRead', pins: [spec.name] },
        note: `analog inputs: ${adcList}`,
        fixes: [{ kind: 'use-adc-pin', confidence: 'suggested', detail: `read an analog input (${adcList})` }],
      });
    } else if ((c.name === 'pinMode' || c.name === 'digitalWrite' || c.name === 'analogWrite' || c.name === 'tone') && !spec.output) {
      const modeText = argText(c, 1) ?? '';
      if (c.name !== 'pinMode' || /OUTPUT/.test(modeText)) {
        emit('F144', tok, {
          message: `${c.name}(${raw}${c.name === 'pinMode' ? `, ${modeText}` : ', …'}): ${spec.name} cannot be an output on ${profile.part}`,
          subject: { api: c.name, pins: [spec.name] },
          note: (spec.notes ?? []).join('; ') || undefined,
          fixes: [{ kind: 'use-output-pin', confidence: 'suggested', detail: 'use an output-capable pin' }],
        });
      }
    } else if (c.name === 'analogWrite' && !spec.pwm) {
      emit('F143', tok, {
        message: `analogWrite(${raw}, …): ${spec.name} has no PWM on ${profile.part} — the core falls back to digitalWrite (HIGH for values ≥ 128)`,
        subject: { api: 'analogWrite', pins: [spec.name] },
        note: `PWM pins: ${pwmList}`,
        fixes: [{ kind: 'use-pwm-pin', confidence: 'suggested', detail: `move the load to a PWM pin (${pwmList})` }],
      });
    }
  }

  // ── F145: attachInterrupt with a pin number ──
  const irqPins = profile.pins.filter(p => p.interrupt !== undefined);
  for (const c of calls) {
    if (c.object || c.name !== 'attachInterrupt' || declared.has(c.name)) continue;
    const raw = argText(c, 0);
    if (raw === undefined) continue;
    const tok = toks[c.nameIdx];
    const inner = raw.match(/^digitalPinToInterrupt\s*\(([\s\S]*)\)$/);
    if (inner) {
      const v = valueOf(inner[1]);
      if (v === undefined) continue;
      const spec = pinFor(v, profile.digitalNumbers);
      if (spec && spec.interrupt === undefined) {
        emit('F145', tok, {
          message: `attachInterrupt(${raw}, …): ${spec.name} cannot raise external interrupts on ${profile.part}`,
          subject: { api: 'attachInterrupt', pins: [spec.name] },
          note: `interrupt-capable pins: ${irqPins.map(p => p.name).join(', ')}`,
          fixes: [{ kind: 'use-interrupt-pin', confidence: 'suggested', detail: `wire the signal to ${irqPins.slice(0, 4).map(p => p.name).join(' or ')}` }],
        });
      }
      continue;
    }
    const v = valueOf(raw);
    if (typeof v !== 'number') continue;
    if (irqPins.some(p => p.interrupt === v)) continue;
    const asPin = pinFor(v, profile.digitalNumbers);
    emit('F145', tok, {
      message: `attachInterrupt(${raw}, …): ${v} is not an interrupt number on ${profile.part}`,
      subject: { api: 'attachInterrupt' },
      note: `attachInterrupt takes an interrupt number; interrupt-capable pins: ${irqPins.length > 6 ? 'all GPIOs' : irqPins.map(p => `${p.name} → ${p.interrupt}`).join(', ')}`,
      fixes:
        asPin && asPin.interrupt !== undefined
          ? [{ kind: 'use-digitalPinToInterrupt', confidence: 'mechanical', detail: `write \`attachInterrupt(digitalPinToInterrupt(${raw}), …)\`` }]
          : [{ kind: 'use-interrupt-pin', confidence: 'suggested', detail: `use digitalPinToInterrupt() with an interrupt-capable pin (${irqPins.slice(0, 4).map(p => p.name).join(', ')})` }],
    });
  }

  // ── F146 unsupported API / F147 host API ──
  const seenUnsupported = new Set<string>();
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t.type !== 'ident' || isP(k - 1, '.')) continue;
    if (t.text in UNSUPPORTED && !declared.has(t.text) && (isP(k + 1, '(') || isP(k + 1, '.')) && !seenUnsupported.has(t.text)) {
      seenUnsupported.add(t.text);
      emit('F146', t, {
        message: `${t.text} is not supported by the simulator`,
        subject: { api: t.text },
        fixes: [{ kind: 'alternative', confidence: 'suggested', detail: UNSUPPORTED[t.text] }],
      });
      continue;
    }
    for (const h of HOST_APIS) {
      if (t.text !== h.root || declared.has(t.text)) continue;
      if (h.member ? !(isP(k + 1, '.') && isId(k + 2, h.member)) : !(isP(k + 1, '(') || isP(k + 1, '.') || isId(k - 1, 'new'))) continue;
      if (!h.member && h.root === 'Date' && !isId(k - 1, 'new')) continue;
      emit('F147', t, {
        message: `${h.member ? `${h.root}.${h.member}` : h.root} in firmware — host APIs break simulated time and determinism`,
        subject: { api: h.member ? `${h.root}.${h.member}` : h.root },
        note: 'firmware time is simulation time: wall-clock reads, host timers and unseeded randomness make runs irreproducible and are never synchronized with the circuit',
        fixes: [{ kind: 'arduino-api', confidence: 'mechanical', detail: h.detail }],
      });
      break;
    }
  }

  // ── F148: Serial without begin ──
  const serialCalls = calls.filter(c => c.object === 'Serial');
  const begun = serialCalls.some(c => c.name === 'begin');
  const firstOut = serialCalls.find(c => c.name === 'print' || c.name === 'println' || c.name === 'write');
  if (firstOut && !begun) {
    emit('F148', toks[firstOut.nameIdx], {
      message: `Serial.${firstOut.name}() used but Serial.begin() is never called`,
      note: 'the UART is off until Serial.begin(baud): real hardware transmits nothing (runtime diagnostic M617)',
      fixes: [{ kind: 'add-serial-begin', confidence: 'mechanical', detail: 'call `Serial.begin(9600)` at the start of setup()' }],
    });
  }

  // ── F149: digitalWrite without pinMode(OUTPUT) ──
  const modeCalls = calls.filter(c => !c.object && c.name === 'pinMode' && c.args.length >= 2);
  const simple = (c: Call): boolean => c.args[0][1] - c.args[0][0] === 1;
  if (!declared.has('pinMode') && modeCalls.every(simple)) {
    const canon = (raw: string): string => {
      const v = valueOf(raw);
      const spec = v === undefined ? undefined : pinFor(v, profile.digitalNumbers);
      return spec ? spec.name : raw.trim();
    };
    const outputs = new Set(modeCalls.filter(c => /OUTPUT|^\s*1\s*$/.test(argText(c, 1) ?? '')).map(c => canon(argText(c, 0)!)));
    for (const c of calls) if (!c.object && (c.name === 'analogWrite' || c.name === 'tone') && c.args[0]) outputs.add(canon(argText(c, 0)!));
    const flagged = new Set<string>();
    for (const c of calls) {
      if (c.object || c.name !== 'digitalWrite' || !c.args[0] || !simple(c)) continue;
      const raw = argText(c, 0)!;
      const v = valueOf(raw);
      if (v !== undefined && !pinFor(v, profile.digitalNumbers)) continue; // F144 already covers it
      const pin = canon(raw);
      if (outputs.has(pin) || flagged.has(pin)) continue;
      flagged.add(pin);
      emit('F149', toks[c.nameIdx], {
        message: `digitalWrite(${argText(c, 0)}, …) but ${argText(c, 0)} is never set to OUTPUT`,
        subject: { api: 'digitalWrite' },
        note: profile.inputWriteControlsPullup
          ? 'pins start as INPUT; on AVR digitalWrite to an INPUT pin only toggles the internal pull-up (an LED glows faintly)'
          : 'pins start as INPUT; the write does not drive the pin',
        fixes: [{ kind: 'add-pinmode', confidence: 'mechanical', detail: `add \`pinMode(${argText(c, 0)}, OUTPUT)\` in setup()` }],
      });
    }
  }

  return out.sort((a, b) => lineNo(a.at) - lineNo(b.at) || a.code.localeCompare(b.code));
}

function lineNo(at?: string): number {
  const m = at?.match(/:(\d+)$/);
  return m ? Number(m[1]) : 0;
}
