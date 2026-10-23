<p align="center"><img src="build/icon.png" width="128" alt="Token Trail icon"></p>

<h1 align="center">Token Trail</h1>

<p align="center">Your Claude usage hub, on your Mac.<br>Claude Code and Claude chat in one profile: lifetime tokens, streaks, a heatmap of every day you built something, and when you work best.</p>

## What you get

- **Stat strip:** lifetime tokens, peak day, longest task, longest streak, current streak.
- **Recent usage:** today, last 7 days, last 30 days, and a rough API-equivalent value of everything you have used.
- **Token activity:** a daily heatmap for the last year, plus weekly and cumulative views.
- **Top models and top projects** (or top conversations for chat).
- **Usage patterns:** which weekday and which hour of the day you use Claude most.
- **Insights:** extended thinking share, fast mode, skills explored and used, active days, average per active day, sessions and replies.
- **Source switcher:** All, Claude Code, or Claude chat.
- **Menu bar item:** today's tokens at a glance, with Open, Rescan and Quit.
- **Live updates:** the numbers refresh a few seconds after Claude Code writes to its logs.
- **Export CSV** of your daily usage, and an **Open at login** switch.
- **Auto-updates:** checks GitHub Releases, downloads the new version in the background and applies it on restart.

## Claude Code usage

Token Trail reads the session logs Claude Code already keeps in `~/.claude/projects`. It finds that folder on its own, so there is no setup. If Claude Code stores its logs somewhere unusual, the app asks once and remembers your choice.

Every log file is parsed once and remembered, so only new or changed files are read after the first scan. A 600 MB history rescans in a fraction of a second.

## Claude chat usage

Chats in the Claude app and on claude.ai are not stored on your Mac, so Token Trail reads the data export Anthropic gives you:

1. Open claude.ai, then Settings, then Privacy, then Export data.
2. Anthropic emails you a download link.
3. In Token Trail choose **Import chat export…** and pick the `.zip` (or the `conversations.json` inside it).

The export has no token counts, so chat tokens are **estimated** from message length (about 3.7 characters per token) and labelled as estimates. Re-import a newer export any time to refresh, or remove the chat data from the header.

Everything is computed on your Mac. Nothing is uploaded.

## Install

1. Download the latest `.dmg` from the [Releases](../../releases) page. Use `arm64` for Apple Silicon and `x64` for Intel.
2. Drag Token Trail into Applications.
3. The app is not notarized by Apple, so the first launch needs one extra step. The quickest way, which works on every macOS version, is to run this once in Terminal and then open the app normally:

```sh
xattr -cr "/Applications/Token Trail.app"
```

   Or open the app, dismiss the warning, then go to System Settings, Privacy & Security, scroll down and click **Open Anyway**. On macOS 14 and older you can also right-click the app, choose Open, then Open again.

If macOS says the app is "damaged and can't be opened", you have a build from before 1.1.1 (its signature was broken). Run the `xattr` command above, or install 1.1.1 or newer.

## Updates

Token Trail checks for a new release shortly after launch and every six hours. When one is found it downloads the zip for your Mac, checks its SHA-256, and shows a **Restart to update** banner. If you never click it, the update is applied the next time you quit.

The app is unsigned, so the usual macOS updater cannot be used. Token Trail swaps its own `.app` with a small script instead and keeps a backup that it restores if anything goes wrong. If the app is not somewhere it can replace itself (for example it is running from the DMG), the banner links to the release page instead.

Versions before 1.1.0 have no updater: install 1.1.0 or newer once by hand.

## Run from source

```sh
npm install
npm start
npm test
```

## Build it yourself

```sh
npm run dist
```

The DMGs and update zips are written to `dist/`.

## Publish a release

Push a version tag. GitHub Actions runs the tests, builds both DMGs and both update zips, and attaches them to a release. The tag sets the app version, so `v1.2.0` ships as 1.2.0:

```sh
git tag v1.2.0
git push origin v1.2.0
```

## How the numbers are counted

- **Lifetime tokens** adds input, output and cache tokens. The Count cache tokens switch limits it to input and output.
- **Peak day** is the day with the most tokens.
- **Longest task** is one prompt and everything Claude did until your next prompt, with waits longer than 15 minutes trimmed.
- **Streaks** count consecutive days with any activity. The current streak is still alive if your last active day was today or yesterday.
- **API-equivalent value** prices your usage at public API rates, including cache. It is a rough scale, not your bill: subscriptions are flat-rate, and models without a known price are left out.
- Replies are de-duplicated by message ID, across files, so streamed and resumed sessions are not counted twice. Subagent sessions count toward tokens but not toward tasks.

## Disclaimer

Token Trail is an unofficial community project and is not affiliated with Anthropic.

## License

MIT
