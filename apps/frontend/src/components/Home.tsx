import type { ReactNode } from "react";

import inboxDark from "../../../../docs/inbox-dark.png";
import inboxLight from "../../../../docs/inbox-light.png";

interface HomeProps {
  /** Shown at the top of the grey box, above the buttons: the status message. */
  children?: ReactNode;
}

export function Home({ children }: HomeProps) {
  return (
    <section className="home-columns">
      <div className="home-main">
        <p>
          GitHub notifies you about comments, mentions and reviews, but never
          about reactions. When someone adds 👍, ❤️ or 🎉 to your issue, you
          only find out by accident. GitHub Reactions Notifier fills this gap.
          Sign up once, and you get a summary of all reactions you've received
          so far, plus a GitHub notification for every new one.
        </p>
        <p>
          Signing in asks GitHub for no permissions beyond your public profile.
          GitHub-Reactions-Notifier then opens a public issue that mentions you,
          and posts updates in there, so GitHub notifies you.
        </p>
        <p>
          <a href="https://github.com/martin-mfg/github-reactions-notifier#readme">
            Learn more
          </a>
        </p>
        <div className="home-box">
          {children}
          <form className="home-option" method="get" action="api/login">
            <button className="home-button-primary" type="submit">
              Get notified about reactions
            </button>
            <p>
              A summary of your existing reactions, then a notification for
              every new one.
            </p>
          </form>
          <form className="home-option" method="get" action="api/login">
            <input type="hidden" name="mode" value="summary" />
            <button className="home-button-secondary" type="submit">
              Get a one-time summary
            </button>
            <p>
              A summary of your existing reactions, nothing after that. You can
              turn notifications on later.
            </p>
          </form>
          <form
            className="home-option"
            method="post"
            action="api/delete-account"
          >
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
      </div>
      <div className="home-aside">
        {/*
          Both are rendered; Starlight's classes show the one matching its theme toggle, not just the OS setting.
          The classes sit on the links, so the hidden one can't be reached with the keyboard either.
          `loading="lazy"` keeps browsers from downloading the hidden one.
        */}
        <a
          className="light:sl-hidden"
          href={inboxDark.src}
          target="_blank"
          rel="noopener noreferrer"
        >
          <img
            className="home-screenshot"
            loading="lazy"
            src={inboxDark.src}
            width={inboxDark.width}
            height={inboxDark.height}
            alt="Example inbox comment"
          />
        </a>
        <a
          className="dark:sl-hidden"
          href={inboxLight.src}
          target="_blank"
          rel="noopener noreferrer"
        >
          <img
            className="home-screenshot"
            loading="lazy"
            src={inboxLight.src}
            width={inboxLight.width}
            height={inboxLight.height}
            alt="Example inbox comment"
          />
        </a>
      </div>
    </section>
  );
}
