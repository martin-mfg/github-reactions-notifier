import { format } from "node:util";

const redact = (args: Array<unknown>): string =>
  format(...args).replace(/gho_[a-zA-Z0-9]+/g, "[REDACTED]");

/**
 * Redact OAuth tokens from the formatted output before sending it to the console.
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
    console.warn(redact(args));
  },
  error: (...args) => {
    console.error(redact(args));
  },
};

export { logger };
