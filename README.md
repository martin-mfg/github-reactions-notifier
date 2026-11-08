<img src="docs/icon.png" alt="" width="96" align="right">

# GitHub Reactions Notifier

> [!WARNING]
> **This is a prototype (alpha).** It may have bugs, lose data, or be shut down at any time.
> I'm releasing it early to find out whether people want it.
> [Your feedback](#feedback) decides whether it gets developed further.

GitHub notifies you about comments, mentions and reviews, but never about reactions.
When someone adds 👍, ❤️ or 🎉 to your issue, you only find out by accident.

GitHub Reactions Notifier fills this gap. Sign in once, and you get a GitHub notification
whenever someone reacts to your issues, pull requests or comments.

**[Sign in here](https://TODO-SITE-URL)**

## How it works

1. **Sign in with GitHub.** The app asks for no permissions beyond your public profile.
2. **The app opens an inbox issue for you** in this repository and mentions you in it.
   That subscribes you to the issue, so GitHub notifies you about every comment on it.
3. **It scans your history** and posts a one-time **summary** of the reactions your content
   has received so far: how many items it found, how many reactions they have, and the total
   per emoji.
4. **New reactions are posted as comments** in your inbox, usually within a few minutes.
   Several reactions are bundled into one comment, for example:

   > - 2 new 👍 and 1 new 🎉 on your issue [Add dark mode](#how-it-works) in octo-org/octo-app
   >   - 👍 @&#8203;alice and @&#8203;bob
   >   - 🎉 @&#8203;carol

The people named in your inbox are **not** mentioned or notified. Only you are.

## What's included, and what isn't yet

| Included                                      | Not yet included                                      |
| --------------------------------------------- | ----------------------------------------------------- |
| Issues you opened                             | Discussions and discussion comments                   |
| Pull requests you opened                      | Pull request reviews and review inline comments              |
| Your comments on issues and pull requests     | Commit comments and releases                          |
| Content in public repositories                | Content in private repositories                       |
| Your content from all time, however old       | Content by others in repositories you own             |
| Notifications a few minutes after a reaction  | Other notification channels like [Atom](https://en.wikipedia.org/wiki/Atom_(web_standard)) or Webhooks                  |
| A one-time summary of your existing reactions | Filters (e.g. only open issues)     |
|                                               | A notification when a reaction is removed             |

Missing something you need? [Tell me](#feedback).

## Good to know

- **Your inbox is public.** Anyone can see the reactions on your content and who added them.
  Reactions are public on GitHub anyway, but your inbox collects them in one place.
  Content from private repositories never appears there.
- **Reactions from before you signed in are never notified one by one.** They only count
  towards the summary.
- **Your own reactions to your posts are reported too**. This is especially useful for testing.
- **The first scan takes time.** For most accounts it takes minutes to hours; for very active
  accounts it can take days. New reactions are reported while it runs, so you may get
  notifications before the summary arrives.
- **Older content is checked less often.** A reaction on something you posted yesterday shows
  up within minutes. One on something from years ago can take longer. Once an item gets a
  reaction, it is checked often again.
- **The app uses your GitHub API quota.** Every GitHub account can make a limited number of
  API requests per hour, shared by all apps and tools you use. The app stops making requests
  once 80% of your hourly quota is used.

## Only want the summary?

There's no "summary only" option yet. Sign in, wait for the summary to arrive in your inbox,
then delete your account (see below). Your inbox issue and the summary stay.

## Stopping and deleting your data

- **Delete your account** with the button on the website. This deletes all data the app
  holds about you and revokes its access to your GitHub account. Your inbox issue stays on
  GitHub.
- **Unsubscribing from the inbox issue** stops the notifications, but the app keeps running
  in the background. Delete your account to stop it completely.
- **Revoking the app** in your GitHub settings (Settings → Applications → Authorized OAuth
  Apps) also stops it. The app posts a short note to your inbox when it notices. Your data
  is kept until you delete your account, so signing in again resumes where it stopped.

## Known limitations of the prototype

- Data may be reset while the app is in development. You would have to sign in again.
- In rare edge cases, some reactions may not be reported. For example: more than 100 new
  reactions on a single item between two checks.
- If you rename a repository or edit a title, your inbox may keep showing the old name.

## Feedback

This prototype exists to find out whether the app is worth building further.
Please [open an issue](https://github.com/martin-mfg/github-reactions-notifier/issues) and
tell me:

- Do you find it useful? Would you keep using it?
- What's missing for you?
- Did anything go wrong?

## Credits

Daumen hoch hand Icon by recognizeapp.com on
<a href="https://icon-icons.com/de/authors/533-recognizeapp-com">Icon-Icons.com</a>
