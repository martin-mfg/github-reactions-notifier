import { format } from "node:util";

/**
 * Starts every `warn` and `error` line, so one search finds every line that reports a problem.
 */
const PROBLEM_KEYWORD = "GRN-PROBLEM";

const redact = (args: Array<unknown>): string =>
  format(...args).replace(/gho_[a-zA-Z0-9]+/g, "[REDACTED]");

/**
 * Redact OAuth tokens from the formatted output before sending it to the console. `warn` and
 * `error` lines start with {@link PROBLEM_KEYWORD}.
 */
const logger: {
  log: (...args: Array<unknown>) => void;
  warn: (...args: Array<unknown>) => void;
  error: (...args: Array<unknown>) => void;
} = {
  log: (...args) => {
    console.log(redact(args));
  },
  warn: (...args) => {
    console.warn(`${PROBLEM_KEYWORD} ${redact(args)}`);
  },
  error: (...args) => {
    console.error(`${PROBLEM_KEYWORD} ${redact(args)}`);
  },
};

export { logger };
