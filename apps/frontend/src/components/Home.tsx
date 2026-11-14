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
      <p>
        <a href="https://github.com/martin-mfg/github-reactions-notifier#readme">
          Learn more
        </a>
      </p>
      <div className="home-box">
        <form className="home-option" method="get" action="api/login">
          <button className="home-button-primary" type="submit">
            Get notified about reactions
          </button>
          <p>
            A summary of your existing reactions, then a notification for every
            new one.
          </p>
        </form>
        <form className="home-option" method="get" action="api/login">
          <input type="hidden" name="mode" value="summary" />
          <button className="home-button-secondary" type="submit">
            Just send me a one-time summary
          </button>
          <p>
            A summary of your existing reactions, nothing after that. You can
            turn notifications on later.
          </p>
        </form>
        <form className="home-option" method="post" action="api/delete-account">
          <button className="home-button-danger" type="submit">
            Delete my account
          </button>
          <p>
            Deleting your account removes all data about you and revokes this
            app&apos;s access. GitHub asks you to confirm who you are first.
            Your inbox issue stays.
          </p>
        </form>
      </div>
    </section>
  );
}
