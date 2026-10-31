export function Home() {
  return (
    <section>
      <p>
        Get notified when someone reacts to your GitHub issues, pull requests
        and comments.
      </p>
      <p>
        Signing in asks GitHub for no permissions beyond your public profile.
        GitHub Reactions Notifier then opens a <strong>public</strong> issue
        that mentions you, and posts new reactions there as comments, so GitHub
        notifies you about them.
      </p>
      <p>
        <a href="api/login">Sign in with GitHub</a>
      </p>
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
