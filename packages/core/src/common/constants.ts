// github-stats-extended imports this from its generated GraphQL types.
type RepositoryAffiliation = "OWNER" | "COLLABORATOR" | "ORGANIZATION_MEMBER";

/**
 * Valid owner affiliations for GitHub API queries.
 */
const OWNER_AFFILIATIONS: Array<RepositoryAffiliation> = [
  "OWNER",
  "COLLABORATOR",
  "ORGANIZATION_MEMBER",
];

export { OWNER_AFFILIATIONS };
