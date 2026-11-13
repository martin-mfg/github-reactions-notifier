import { useEffect, useState } from "react";

import { inboxUrl } from "./inboxLink";

/** Messages for the `?status=` the backend's OAuth flows end on. */
const MESSAGES: Record<string, string> = {
  "signed-in":
    "You're signed in. Your inbox issue will be opened shortly; GitHub notifies you about it.",
  "summary-requested":
    "You're signed in. Your inbox issue will be opened shortly, and your summary is posted " +
    "there once GitHub-Reactions-Notifier has scanned your history.",
  "summary-pending":
    "Your summary is still being prepared. It will be posted to your inbox issue once it's " +
    "completed.",
  "summary-again":
    "GitHub-Reactions-Notifier is rescanning your history and will post a fresh summary to " +
    "your inbox issue when it's done.",
  "notifications-on":
    "Notifications are on. Additionally, GitHub-Reactions-Notifier is rescanning your " +
    "history and will post a fresh summary to your inbox issue when it's done.",
  "notifications-on-summary-pending":
    "Notifications are on. Additionally, your pending summary will be posted to your inbox " +
    "issue when the scan is done.",
  "notifications-off":
    'Notifications are off. Choose "Get notified about reactions" to turn them back on.',
  "notifications-off-summary-pending":
    "Notifications are off. Your pending summary will still be posted to your inbox issue " +
    "when the scan is done.",
  "scope-rejected":
    "GitHub granted this app more access than it asks for, even after we removed the grant. " +
    "Please revoke the app in your GitHub settings and sign in again.",
  deleted: "Your account and all data about you are deleted.",
  "deleted-grant-kept":
    "Your account and all data about you are deleted, but removing the app's authorization " +
    "from your GitHub account failed. You can revoke it in your GitHub settings.",
  cancelled: "Authorization on GitHub was cancelled.",
  "invalid-state": "The sign-in link expired. Please try again.",
  error: "Something went wrong. Please try again later.",
};

/** `signed-in` for a user whose inbox issue is open already. */
const SIGNED_IN_WITH_INBOX =
  "You're signed in. New reactions show up in your inbox issue.";

/** The words that link the inbox issue, when the redirect names it. */
const INBOX_WORDS = "your inbox issue";

interface Message {
  text: string;
  /** The inbox issue's URL, from a valid `?inbox=`. */
  inbox?: string;
}

const readStatus = (): Message | undefined => {
  const params = new URL(window.location.href).searchParams;
  const status = params.get("status");
  if (status === null) {
    return undefined;
  }
  const inbox = inboxUrl(params.get("inbox"));
  const text =
    status === "signed-in" && inbox !== undefined
      ? SIGNED_IN_WITH_INBOX
      : (MESSAGES[status] ?? MESSAGES["error"] ?? "");
  return inbox === undefined ? { text } : { text, inbox };
};

/**
 * Shows the outcome of a sign-in or deletion, then drops it from the URL so a reload
 * doesn't repeat it. Renders in the browser only (`client:only`), since it reads the URL.
 *
 * @returns The message, if any.
 */
export function StatusMessage() {
  const [message] = useState(readStatus);

  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.has("status") || url.searchParams.has("inbox")) {
      url.searchParams.delete("status");
      url.searchParams.delete("inbox");
      window.history.replaceState(null, "", url);
    }
  }, []);

  if (!message) {
    return null;
  }
  const index =
    message.inbox === undefined ? -1 : message.text.indexOf(INBOX_WORDS);
  if (index === -1) {
    return <p role="status">{message.text}</p>;
  }
  return (
    <p role="status">
      {message.text.slice(0, index)}
      <a href={message.inbox}>{INBOX_WORDS}</a>
      {message.text.slice(index + INBOX_WORDS.length)}
    </p>
  );
}
