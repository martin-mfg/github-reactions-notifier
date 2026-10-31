import { logger } from "@grn/core";
import type { BackfillCommentFragment } from "@grn/core";

import { settleSyncFailure } from "../github/syncClient.ts";
import type { SyncFailure, SyncSession } from "../github/syncClient.ts";

import type { DiscoveredItem } from "./store.ts";

/** What a discovery task's log lines carry. */
export type TaskContext = Record<string, string>;

/**
 * @param session The leased `sync` job.
 * @param categoryId The task's category.
 * @returns The fields every log line of the task carries.
 */
export const taskContext = (
  session: SyncSession,
  categoryId: string,
): TaskContext => ({
  job: session.lease.id,
  user: session.lease.userId,
  kind: session.lease.kind,
  category: categoryId,
});

export const author = (
  actor: { id: string; login: string } | null,
): Pick<DiscoveredItem, "authorId" | "authorLogin"> => ({
  authorId: actor?.id ?? null,
  authorLogin: actor?.login ?? null,
});

export const present = <T>(nodes: Array<T | null> | null): Array<T> =>
  (nodes ?? []).filter((node): node is T => node !== null);

/**
 * @param node A timeline item, which is `{}` unless it is a comment.
 * @returns Whether it is a comment.
 */
export const isComment = (
  node: BackfillCommentFragment | Record<PropertyKey, never>,
): node is BackfillCommentFragment => "__typename" in node;

/**
 * @param comment A comment of a backfilled or scanned thread.
 * @returns The comment as an item; its `last_event_at` is its `createdAt`, with no probe (§9.2).
 */
export const commentItem = (
  comment: BackfillCommentFragment,
): DiscoveredItem => ({
  nodeId: comment.id,
  type: comment.__typename,
  repoFullName: comment.repository.nameWithOwner,
  url: comment.url,
  title: comment.issue.title,
  ...author(comment.author),
  lastEventAt: comment.createdAt,
});

/**
 * Someone else's content must never be tracked as the user's. A `viewer` other than the job's
 * user is retried as transient (§12), but alerted: this means a mixed-up token or a bug.
 *
 * @param session The leased `sync` job.
 * @param viewerId The query's `viewer.id`.
 * @param context The task's log fields.
 * @returns The settled failure, or `null` if the viewer is the job's user.
 */
export const rejectForeignViewer = async (
  session: SyncSession,
  viewerId: string,
  context: TaskContext,
): Promise<SyncFailure | null> => {
  if (viewerId === session.lease.userId) {
    return null;
  }
  logger.error("ALERT: viewer is not the job's user", {
    ...context,
    viewer: viewerId,
  });
  const failure: SyncFailure = { kind: "transient" };
  await settleSyncFailure(session, failure);
  return failure;
};
