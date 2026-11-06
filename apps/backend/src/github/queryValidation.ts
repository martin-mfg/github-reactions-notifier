type Validator = (value: unknown) => boolean;

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const timestamp = (value: unknown): boolean =>
  typeof value === "string" && Number.isFinite(Date.parse(value));

const identity: Validator = (value) =>
  object(value) &&
  typeof value["id"] === "string" &&
  typeof value["login"] === "string";

const nodes = (value: unknown, validate: Validator): boolean =>
  Array.isArray(value) &&
  value.every((node: unknown) => node === null || validate(node));

const connection = (value: unknown, validate: Validator): boolean =>
  object(value) &&
  object(value["pageInfo"]) &&
  typeof value["pageInfo"]["hasNextPage"] === "boolean" &&
  nodes(value["nodes"], validate);

const content: Validator = (value) =>
  object(value) &&
  typeof value["id"] === "string" &&
  typeof value["url"] === "string" &&
  timestamp(value["createdAt"]) &&
  object(value["repository"]) &&
  typeof value["repository"]["nameWithOwner"] === "string" &&
  (value["author"] === null || identity(value["author"]));

const thread: Validator = (value) =>
  object(value) &&
  (value["__typename"] === "Issue" || value["__typename"] === "PullRequest") &&
  content(value) &&
  typeof value["title"] === "string";

const comment: Validator = (value) =>
  object(value) &&
  value["__typename"] === "IssueComment" &&
  content(value) &&
  object(value["issue"]) &&
  typeof value["issue"]["title"] === "string";

// Inline fragments on a node of another type legitimately return an empty object.
const empty: Validator = (value) =>
  object(value) && Object.keys(value).length === 0;

const timeline: Validator = (value) =>
  connection(value, (node) => empty(node) || comment(node));

const reactionTime: Validator = (value) =>
  object(value) && timestamp(value["createdAt"]);

export const validIncremental: Validator = (value) =>
  object(value) &&
  identity(value["viewer"]) &&
  object(value["viewer"]) &&
  connection(value["viewer"]["issues"], thread) &&
  connection(value["viewer"]["pullRequests"], thread) &&
  connection(
    value["viewer"]["issueComments"],
    (node) => comment(node) && object(node) && timestamp(node["updatedAt"]),
  );

export const validBackfill: Validator = (value) =>
  object(value) &&
  identity(value["viewer"]) &&
  connection(
    value["search"],
    (node) =>
      empty(node) ||
      (thread(node) &&
        object(node) &&
        timeline(node["timelineItems"]) &&
        object(node["reactions"]) &&
        nodes(node["reactions"]["nodes"], reactionTime)),
  );

const aliases = (
  value: unknown,
  prefix: string,
  count: number,
  validate: Validator,
): boolean =>
  object(value) &&
  Array.from({ length: count }, (_, index) => `${prefix}_${index}`).every(
    (alias) =>
      Object.hasOwn(value, alias) &&
      (value[alias] === null || empty(value[alias]) || validate(value[alias])),
  );

export const validThreadScans = (value: unknown, count: number): boolean =>
  object(value) &&
  identity(value["viewer"]) &&
  aliases(
    value,
    "thread",
    count,
    (node) => object(node) && timeline(node["timelineItems"]),
  );

const reactionGroup: Validator = (value) =>
  object(value) &&
  typeof value["content"] === "string" &&
  object(value["reactors"]) &&
  Number.isInteger(value["reactors"]["totalCount"]) &&
  Number(value["reactors"]["totalCount"]) >= 0;

/**
 * The snapshot sweep's response (M1.1 §4.2). Every alias must be present. An alias that has a
 * GraphQL error may hold anything: the error decides its row. Any other alias is `null`, an
 * object without `reactionGroups` (not reactable), or one with `reactionGroups` (`null`, or a
 * list of `{ content, reactors { totalCount } }`; any `content` string passes, so a new emoji
 * doesn't fail the batch).
 *
 * @param value The response's `data`.
 * @param count How many `item_<index>` aliases the query has.
 * @param erred The indexes of the aliases that have errors.
 * @returns Whether the response is usable.
 */
export const validReactionSnapshot = (
  value: unknown,
  count: number,
  erred: ReadonlySet<number>,
): boolean =>
  object(value) &&
  Array.from({ length: count }, (_, index) => index).every((index) => {
    const alias = `item_${index}`;
    if (!Object.hasOwn(value, alias)) {
      return false;
    }
    const node = value[alias];
    if (erred.has(index) || node === null) {
      return true;
    }
    if (!object(node)) {
      return false;
    }
    const groups = node["reactionGroups"];
    return (
      !Object.hasOwn(node, "reactionGroups") ||
      groups === null ||
      (Array.isArray(groups) && groups.every(reactionGroup))
    );
  });

export const validReactionPoll = (
  value: unknown,
  count: number,
  drillDown = false,
): boolean =>
  aliases(value, "item", count, (node) => {
    if (!object(node) || !object(node["reactions"])) {
      return false;
    }
    if (!drillDown) {
      return nodes(node["reactions"]["nodes"], reactionTime);
    }
    return connection(
      node["reactions"],
      (reaction) =>
        reactionTime(reaction) &&
        object(reaction) &&
        typeof reaction["content"] === "string" &&
        [
          "THUMBS_UP",
          "THUMBS_DOWN",
          "LAUGH",
          "HOORAY",
          "CONFUSED",
          "HEART",
          "ROCKET",
          "EYES",
        ].includes(reaction["content"]) &&
        (reaction["user"] === null || identity(reaction["user"])),
    );
  });
