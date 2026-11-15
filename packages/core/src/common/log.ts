import { formatWithOptions } from "node:util";

/**
 * Starts every `warn` and `error` line, so one search finds every line that reports a problem.
 */
const PROBLEM_KEYWORD = "GRN-PROBLEM";

/**
 * Never wrap an object over several lines. `[WHY]` Vercel caps the log lines of a request
 * (256), and a line may hold up to 256 KB.
 */
const ONE_LINE = { compact: true, breakLength: Infinity } as const;

/**
 * Formats like `console.log`, but on one line: objects aren't wrapped, and the newlines left,
 * as in a stack trace, are escaped as `\n`. OAuth tokens are redacted.
 *
 * @param args What was logged.
 * @returns The line.
 */
const render = (args: Array<unknown>): string =>
  formatWithOptions(ONE_LINE, ...args)
    .replaceAll("\n", "\\n")
    .replace(/gho_[a-zA-Z0-9]+/g, "[REDACTED]");

/**
 * Writes each call as one line, with OAuth tokens redacted. `warn` and `error` lines start
 * with {@link PROBLEM_KEYWORD}. `debug` writes nothing. `[WHY]` Vercel caps the log lines of
 * a request, so routine lines that say nothing new are kept out.
 */
const logger: {
  debug: (...args: Array<unknown>) => void;
  log: (...args: Array<unknown>) => void;
  warn: (...args: Array<unknown>) => void;
  error: (...args: Array<unknown>) => void;
} = {
  debug: () => {
    // not written, see above
  },
  log: (...args) => {
    console.log(render(args));
  },
  warn: (...args) => {
    console.warn(`${PROBLEM_KEYWORD} ${render(args)}`);
  },
  error: (...args) => {
    console.error(`${PROBLEM_KEYWORD} ${render(args)}`);
  },
};

export { logger };
