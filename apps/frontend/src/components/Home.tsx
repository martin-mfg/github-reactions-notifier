export function Home() {
  return (
    <section>
      <p>
        Get notified when someone reacts to your GitHub issues, pull requests
        and comments.
      </p>
      <p>
        Signing in asks GitHub for no permissions beyond your public profile.
        GitHub-Reactions-Notifier then opens a <strong>public</strong> issue
        that mentions you, and posts there as comments, so GitHub notifies you.
      </p>
      <form method="get" action="api/login">
        <p>
          A summary of your existing reactions, then a notification for every
          new one.
        </p>
        <button type="submit">Get notified about reactions</button>
      </form>
      <form method="get" action="api/login">
        <input type="hidden" name="mode" value="summary" />
        <p>
          A summary of your existing reactions, nothing after that. You can turn
          notifications on later.
        </p>
        <button type="submit">Just send me a one-time summary</button>
      </form>
      <p>
        <a href="docs/">Learn more</a>
      </p>
      <form method="post" action="api/delete-account">
        <p>
          Deleting your account removes all data about you and revokes this
          app&apos;s access. GitHub asks you to confirm who you are first. Your
          inbox issue stays.
        </p>
        <button type="submit">Delete my account</button>
      </form>
    </section>
  );
}
