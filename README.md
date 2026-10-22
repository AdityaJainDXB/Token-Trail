<p align="center"><img src="build/icon.png" width="128" alt="Token Trail icon"></p>

<h1 align="center">Token Trail</h1>

<p align="center">Your Claude Code usage as a profile page, on your Mac.<br>Lifetime tokens, peak day, longest task, streaks and a heatmap of every day you built something.</p>

## What you get

- **Stat strip:** lifetime tokens, peak day, longest task, longest streak, current streak.
- **Token activity:** a daily heatmap for the last year, plus weekly and cumulative views.
- **Top models and top projects:** where your tokens actually went.
- **Insights:** extended thinking share, fast mode, skills explored and used, active days, sessions and replies.

## How it finds your data

Token Trail reads the session logs Claude Code already keeps in `~/.claude/projects`. It finds that folder on its own every time you open it, so there is no folder picker and no setup. It shows your last numbers right away and refreshes in the background, and it refreshes again when you switch back to the window. The Rescan button never asks for a folder.

If Claude Code stores its logs somewhere unusual, the app asks once and remembers your choice. You can change it later with Change folder.

Everything is computed on your Mac. Nothing is uploaded.

## Install

1. Download the latest `.dmg` from the [Releases](../../releases) page. Use `arm64` for Apple Silicon and `x64` for Intel.
2. Drag Token Trail into Applications.
3. The app is not signed with an Apple developer certificate, so the first launch needs one extra step. Right-click the app, choose Open, then Open again. Or run:

```sh
xattr -cr "/Applications/Token Trail.app"
```

## Run from source

```sh
npm install
npm start
```

## Build the DMG yourself

```sh
npm run dist
```

The DMG is written to `dist/`.

## Publish a release

Push a version tag. GitHub Actions builds both DMGs and attaches them to a release:

```sh
git tag v1.0.0
git push origin v1.0.0
```

## How the numbers are counted

- **Lifetime tokens** adds input, output and cache tokens. The Count cache tokens switch limits it to input and output.
- **Peak day** is the day with the most tokens.
- **Longest task** is one prompt and everything Claude did until your next prompt, with waits longer than 15 minutes trimmed.
- **Streaks** count consecutive days with any Claude Code activity. The current streak is still alive if your last active day was today or yesterday.
- Replies are de-duplicated by message ID so streamed responses are not counted twice. Subagent sessions count toward tokens but not toward tasks.
- Only Claude Code is covered. Chats in the Claude app are not in these logs.

## Disclaimer

Token Trail is an unofficial community project and is not affiliated with Anthropic.

## License

MIT
