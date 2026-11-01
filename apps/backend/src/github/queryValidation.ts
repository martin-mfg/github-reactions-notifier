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
