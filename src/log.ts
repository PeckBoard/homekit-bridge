const DEBUG = /^(debug|trace)$/i.test(process.env.HOMEKIT_BRIDGE_LOG ?? "");
let quiet = false;

/** Silences info logs (tests). Errors still print. */
export function setQuiet(q: boolean): void {
  quiet = q;
}

function out(level: string, msg: string): void {
  process.stderr.write(`${new Date().toISOString()} ${level} ${msg}\n`);
}

export const log = {
  debug: (msg: string) => DEBUG && out("DEBUG", msg),
  info: (msg: string) => !quiet && out("INFO", msg),
  warn: (msg: string) => !quiet && out("WARN", msg),
  error: (msg: string) => out("ERROR", msg),
};
