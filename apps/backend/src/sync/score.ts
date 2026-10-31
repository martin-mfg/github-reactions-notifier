/**
 * §9.1's score, `wait / content_age^P × weight`, in seconds, as a SQL expression. Content age
 * is at least one second, because the score divides by it; a negative wait (GitHub's clock
 * ahead of GRN's) counts as none. Each term is a SQL expression evaluated against `now()`.
 *
 * @param terms The task's terms.
 * @param terms.wait An interval: how long the task has waited.
 * @param terms.age An interval: how old the task's newest content (or activity) is.
 * @param terms.exponent A `float8`: `P`, usually a parameter.
 * @param terms.weight A number: the task's weight, 1 or a parameter for `w`.
 * @returns The expression, a `float8`.
 */
export const scoreSql = (terms: {
  wait: string;
  age: string;
  exponent: string;
  weight: string;
}): string =>
  `(greatest(extract(epoch FROM ${terms.wait})::float8, 0)
    / power(greatest(extract(epoch FROM ${terms.age})::float8, 1), ${terms.exponent})
    * ${terms.weight})`;
