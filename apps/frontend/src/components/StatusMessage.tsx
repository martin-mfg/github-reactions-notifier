import { useEffect, useState } from "react";

/** Messages for the `?status=` the backend's OAuth flows end on. */
const MESSAGES: Record<string, string> = {
  "signed-in":
    "You're signed in. Your inbox issue will be opened shortly; GitHub notifies you about it.",
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

const readStatus = (): string | undefined => {
  const status = new URL(window.location.href).searchParams.get("status");
  return status === null ? undefined : (MESSAGES[status] ?? MESSAGES["error"]);
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
    if (url.searchParams.has("status")) {
      url.searchParams.delete("status");
      window.history.replaceState(null, "", url);
    }
  }, []);

  return message ? <p role="status">{message}</p> : null;
}
