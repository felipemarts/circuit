/**
 * AST → VHDL text. Canonical formatting (lowercase keywords, fully
 * parenthesized binary operations); parsing the output gives the same AST
 * modulo source locations and redundant parentheses. Used by the parser
 * round-trip tests and handy for debugging.
 */
import type { Assoc, Choice, ConcStmt, Decl, DesignFile, Expr, InterfaceDecl, RangeExpr, SeqStmt, SubtypeInd, Waveform } from './ast';

export function printVhdl(file: DesignFile): string {
  const out: string[] = [];
  for (const u of file.units) {
    for (const c of u.context) out.push(c.kind === 'library' ? `library ${c.names.join(', ')};` : `use ${c.names.join('.')};`);
    if (u.kind === 'entity') {
      out.push(`entity ${u.name} is`);
      if (u.generics.length) out.push(`  generic (\n${u.generics.map(g => `    ${iface(g)}`).join(';\n')}\n  );`);
      if (u.ports.length) out.push(`  port (\n${u.ports.map(p => `    ${iface(p)}`).join(';\n')}\n  );`);
      out.push(`end entity ${u.name};`, '');
    } else {
      out.push(`architecture ${u.name} of ${u.entity} is`);
      for (const d of u.decls) out.push(...decl(d, '  '));
      out.push('begin');
      for (const s of u.stmts) out.push(...conc(s, '  '));
      out.push(`end architecture ${u.name};`, '');
    }
  }
  return out.join('\n');
}

function iface(d: InterfaceDecl): string {
  return `${d.names.join(', ')} : ${d.mode ? `${d.mode} ` : ''}${subtype(d.type)}${d.init ? ` := ${expr(d.init)}` : ''}`;
}

export function subtype(t: SubtypeInd): string {
  let s = t.name;
  if (t.index) s += `(${t.index.map(range).join(', ')})`;
  if (t.range) s += ` range ${range(t.range)}`;
  return s;
}

export function range(r: RangeExpr): string {
  if (r.kind === 'range') return `${expr(r.left)} ${r.dir} ${expr(r.right)}`;
  if (r.kind === 'attr-range') return `${expr(r.prefix)}'${r.attr}`;
  return subtype(r.type);
}

function decl(d: Decl, ind: string): string[] {
  switch (d.kind) {
    case 'signal':
    case 'constant':
    case 'variable':
      return [`${ind}${d.kind} ${d.names.join(', ')} : ${subtype(d.type)}${d.init ? ` := ${expr(d.init)}` : ''};`];
    case 'enum-type':
      return [`${ind}type ${d.name} is (${d.literals.join(', ')});`];
    case 'subtype':
      return [`${ind}subtype ${d.name} is ${subtype(d.type)};`];
    case 'component': {
      const lines = [`${ind}component ${d.name} is`];
      if (d.generics.length) lines.push(`${ind}  generic (${d.generics.map(iface).join('; ')});`);
      if (d.ports.length) lines.push(`${ind}  port (${d.ports.map(iface).join('; ')});`);
      lines.push(`${ind}end component;`);
      return lines;
    }
  }
}

function wave(w: Waveform): string {
  const mech = w.mechanism === 'transport' ? 'transport ' : w.mechanism === 'inertial' ? 'inertial ' : '';
  return (
    mech +
    w.elements.map(e => (e.value === 'unaffected' ? 'unaffected' : `${expr(e.value)}${e.after ? ` after ${expr(e.after)}` : ''}`)).join(', ')
  );
}

function choices(cs: Choice[]): string {
  return cs.map(c => (c.kind === 'others' ? 'others' : c.kind === 'range' ? range(c.range) : expr(c.expr))).join(' | ');
}

function assoc(a: Assoc): string {
  const actual = a.actual.kind === 'open' ? 'open' : a.actual.kind === 'range' || a.actual.kind === 'attr-range' || a.actual.kind === 'subtype-range' ? range(a.actual as RangeExpr) : expr(a.actual as Expr);
  return a.formal ? `${expr(a.formal)} => ${actual}` : actual;
}

function conc(s: ConcStmt, ind: string): string[] {
  const lbl = 'label' in s && s.label ? `${s.label}: ` : '';
  switch (s.kind) {
    case 'process': {
      const sens = s.sensitivity === null ? '' : s.sensitivity === 'all' ? ' (all)' : ` (${s.sensitivity.map(expr).join(', ')})`;
      return [`${ind}${lbl}process${sens} is`, ...s.decls.flatMap(d => decl(d, `${ind}  `)), `${ind}begin`, ...seq(s.body, `${ind}  `), `${ind}end process${s.label ? ` ${s.label}` : ''};`];
    }
    case 'cassign':
      if (s.form === 'simple') return [`${ind}${lbl}${expr(s.target)} <= ${wave(s.wave)};`];
      if (s.form === 'cond') return [`${ind}${lbl}${expr(s.target)} <= ${s.arms.map(a => `${wave(a.wave)}${a.cond ? ` when ${expr(a.cond)}` : ''}`).join(' else ')};`];
      return [`${ind}${lbl}with ${expr(s.selector)} select${s.matching ? '?' : ''} ${expr(s.target)} <= ${s.arms.map(a => `${wave(a.wave)} when ${choices(a.choices)}`).join(', ')};`];
    case 'instance': {
      const unit = s.unit.kind === 'entity' ? `entity ${s.unit.library}.${s.unit.name}${s.unit.arch ? `(${s.unit.arch})` : ''}` : s.unit.name;
      const gm = s.generics.length ? ` generic map (${s.generics.map(assoc).join(', ')})` : '';
      const pm = s.ports.length ? ` port map (${s.ports.map(assoc).join(', ')})` : '';
      return [`${ind}${s.label}: ${unit}${gm}${pm};`];
    }
    case 'for-generate':
      return [
        `${ind}${s.label}: for ${s.param} in ${range(s.range)} generate`,
        ...s.decls.flatMap(d => decl(d, `${ind}  `)),
        ...(s.decls.length ? [`${ind}begin`] : []),
        ...s.stmts.flatMap(x => conc(x, `${ind}  `)),
        `${ind}end generate ${s.label};`,
      ];
    case 'if-generate': {
      const lines: string[] = [];
      s.arms.forEach((a, i) => {
        const head = i === 0 ? `${ind}${s.label}: if ${expr(a.cond!)} generate` : a.cond ? `${ind}elsif ${expr(a.cond)} generate` : `${ind}else generate`;
        lines.push(head, ...a.decls.flatMap(d => decl(d, `${ind}  `)), ...(a.decls.length ? [`${ind}begin`] : []), ...a.stmts.flatMap(x => conc(x, `${ind}  `)));
      });
      lines.push(`${ind}end generate ${s.label};`);
      return lines;
    }
    case 'cassert':
      return [`${ind}${lbl}assert ${expr(s.cond)}${s.report ? ` report ${expr(s.report)}` : ''}${s.severity ? ` severity ${expr(s.severity)}` : ''};`];
  }
}

function seq(body: SeqStmt[], ind: string): string[] {
  return body.flatMap(s => seq1(s, ind));
}

function seq1(s: SeqStmt, ind: string): string[] {
  const lbl = s.label ? `${s.label}: ` : '';
  switch (s.kind) {
    case 'sassign':
      return [`${ind}${lbl}${expr(s.target)} <= ${wave(s.wave)};`];
    case 'sassign-cond':
      return [`${ind}${lbl}${expr(s.target)} <= ${s.arms.map(a => `${wave(a.wave)}${a.cond ? ` when ${expr(a.cond)}` : ''}`).join(' else ')};`];
    case 'vassign':
      return [`${ind}${lbl}${expr(s.target)} := ${expr(s.value)};`];
    case 'if': {
      const lines: string[] = [];
      s.arms.forEach((a, i) => lines.push(`${ind}${i === 0 ? `${lbl}if` : 'elsif'} ${expr(a.cond)} then`, ...seq(a.body, `${ind}  `)));
      if (s.else) lines.push(`${ind}else`, ...seq(s.else, `${ind}  `));
      lines.push(`${ind}end if;`);
      return lines;
    }
    case 'case':
      return [
        `${ind}${lbl}case${s.matching ? '?' : ''} ${expr(s.expr)} is`,
        ...s.arms.flatMap(a => [`${ind}  when ${choices(a.choices)} =>`, ...seq(a.body, `${ind}    `)]),
        `${ind}end case${s.matching ? '?' : ''};`,
      ];
    case 'for':
      return [`${ind}${lbl}for ${s.param} in ${range(s.range)} loop`, ...seq(s.body, `${ind}  `), `${ind}end loop${s.label ? ` ${s.label}` : ''};`];
    case 'while':
      return [`${ind}${lbl}while ${expr(s.cond)} loop`, ...seq(s.body, `${ind}  `), `${ind}end loop${s.label ? ` ${s.label}` : ''};`];
    case 'loop':
      return [`${ind}${lbl}loop`, ...seq(s.body, `${ind}  `), `${ind}end loop${s.label ? ` ${s.label}` : ''};`];
    case 'exit':
    case 'next':
      return [`${ind}${lbl}${s.kind}${s.loopLabel ? ` ${s.loopLabel}` : ''}${s.cond ? ` when ${expr(s.cond)}` : ''};`];
    case 'null':
      return [`${ind}${lbl}null;`];
    case 'wait':
      return [`${ind}${lbl}wait${s.on ? ` on ${s.on.map(expr).join(', ')}` : ''}${s.until ? ` until ${expr(s.until)}` : ''}${s.for ? ` for ${expr(s.for)}` : ''};`];
    case 'assert':
      return s.cond
        ? [`${ind}${lbl}assert ${expr(s.cond)}${s.report ? ` report ${expr(s.report)}` : ''}${s.severity ? ` severity ${expr(s.severity)}` : ''};`]
        : [`${ind}${lbl}report ${expr(s.report!)}${s.severity ? ` severity ${expr(s.severity)}` : ''};`];
    case 'return':
      return [`${ind}${lbl}return${s.value ? ` ${expr(s.value)}` : ''};`];
    case 'pcall':
      return [`${ind}${lbl}${expr(s.call)};`];
  }
}

export function expr(e: Expr): string {
  switch (e.kind) {
    case 'id':
      return e.name;
    case 'call':
      return `${expr(e.prefix)}(${e.args.map(assoc).join(', ')})`;
    case 'attr':
      return `${expr(e.prefix)}'${e.attr}${e.arg ? `(${expr(e.arg)})` : ''}`;
    case 'sel':
      return `${expr(e.prefix)}.${e.suffix}`;
    case 'int':
    case 'real':
      return e.raw;
    case 'phys':
      return `${expr(e.value)} ${e.unit}`;
    case 'char':
      return `'${e.value}'`;
    case 'str':
      return `"${e.value.replace(/"/g, '""')}"`;
    case 'bitstr':
      return e.raw;
    case 'binary':
      return `(${expr(e.left)} ${e.op} ${expr(e.right)})`;
    case 'unary':
      return e.op === 'not' || e.op === 'abs' || e.op === '??' || /^[a-z]/.test(e.op) ? `(${e.op} ${expr(e.operand)})` : `(${e.op}${expr(e.operand)})`;
    case 'paren':
      // binary/unary operations already print their own parentheses
      return e.expr.kind === 'binary' || e.expr.kind === 'unary' ? expr(e.expr) : `(${expr(e.expr)})`;
    case 'agg':
      return `(${e.items.map(i => (i.choices ? `${choices(i.choices)} => ${expr(i.value)}` : expr(i.value))).join(', ')})`;
    case 'qual':
      return `${e.type}'(${expr(e.expr)})`;
    case 'null-lit':
      return 'null';
  }
}
