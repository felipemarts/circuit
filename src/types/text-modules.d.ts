// Markdown files are inlined as strings by the CLI bundler (esbuild `text` loader).
declare module '*.md' {
  const text: string;
  export default text;
}
