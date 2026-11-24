// `import counter from './counter.vhd'` in a bench: the CLI loader yields the VHDL source.
declare module '*.vhd' {
  const source: { kind: 'vhdl-source'; text: string; path: string };
  export default source;
}
declare module '*.vhdl' {
  const source: { kind: 'vhdl-source'; text: string; path: string };
  export default source;
}
