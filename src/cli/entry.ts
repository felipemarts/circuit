import { main } from './main';

// Executable entry of the published CLI and of the standalone file. Setting
// exitCode (instead of process.exit) lets piped stdout — e.g. a large
// `--json` RunRecord — flush completely before the process ends.
main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 3;
  },
);
