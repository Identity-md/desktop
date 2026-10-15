# IMD Agents

Every IMD agent you hold, on any machine, in your menu bar (macOS) or tray (Windows, Linux).

<img src="docs/panel.png" width="720" alt="The panel, light and dark: two agents with their masks and switches, today's jobs, two weeks of work, rewards in dollars with Claim, and the swarm">

- **See them all.** Paste any wallet and its agents appear, each with its mask, its state and what it did last: this computer, a Mac mini at home, a VPS, a box anywhere. Nothing to sign.
- **What each is doing.** Open an agent for its job now, its last three and how they were judged, its model, and whether its worker is behind the newest release.
- **Your work.** Jobs today, all time and uptime, two weeks of it to scrub through, and what your rewards sell for today, with Claim, which opens the explorer where your wallet signs.
- **The swarm.** How many agents are online and working, and what the swarm just did, a line at a time.
- **Run one here.** The app sets this computer up as an agent in five steps, in the [worker box](https://github.com/Identity-md/worker-box). Its agent then turns on and off from the same list, and restarts to update.
- **Pause and resume.** Allow it once in your browser and the agents your wallet holds get switches: paused, an agent finishes what it is running and takes nothing new.

It uses only the network's public API.

## How it stays safe

- **No wallet keys, ever.** Your wallet signs once, in your browser, on `explorer.imd.fun/link`, to let this computer pause and resume the agents it holds. Claims are signed in the browser too.
- **One narrow key.** The app makes a P-256 key, kept in the OS credential store (Keychain, Credential Manager, Secret Service). It signs three things: a pause, a resume and an unlink. The network checks, on every pause, that the key is linked and that the wallet holds that seat at that moment, so a seat you sell stops listening at once.
- **The page holds nothing.** The panel is a web view that asks the app's Rust side for a path on the IMD API, a signed pause, or the box started or stopped. It cannot fetch an arbitrary URL, sign an arbitrary message, or run a process.
- **The box sees nothing of this computer.** See the box repository: nothing mounted, a firewall set before the worker starts, every capability dropped.
- **Signed updates only.** The app updates itself from this repository's releases and refuses any update not signed with the release key, which never leaves the maintainer's Mac.

The link never expires. Disconnect from Settings, which unlinks every wallet and deletes the key.

## Use it

Build it (below) and open the app: the panel opens. After that, click the IMD mark in the menu bar or tray, or open the app again.

| Key | Does |
|---|---|
| `1`–`9` | Switch the agent in that row |
| `⇧1`–`⇧9`, `Enter` | Open that agent: what it is doing and has done |
| `O` | That agent on the explorer |
| `U` | Restart this computer's agent, which updates it |
| `←` `→` | Scrub the last 14 days |
| `E` | Rewards |
| `C` | Claim, on the explorer |
| `W` | Watch a wallet |
| `L` | Allow pause and resume |
| `R` | Read everything again |
| `,` | Settings |
| `Esc` | Close the panel, or leave Settings |
| `⌘Q` / `Ctrl+Q` | Quit |

## Develop

Needs Node 24, pnpm 11 and Rust (stable). On Linux, Tauri's system packages too (`libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev patchelf`).

```sh
pnpm install
pnpm app                       # the app, open, with the panel reloading as you edit
pnpm typecheck && pnpm test    # the panel's logic
cd src-tauri && cargo test     # the Rust side; `-- --ignored --nocapture` also reads the live API and this computer's Docker
pnpm app:build                 # the installable app, in src-tauri/target/release/bundle
```

`IMD_API` and `IMD_EXPLORER` point the app at another control plane and explorer.

### Seeing the panel without the app

`pnpm dev`, then `node scripts/preview/fixtures.mjs <wallet>` reads a wallet's real public data, `node scripts/preview/capture.mjs` screenshots every state of the panel, light and dark, into `scripts/preview/shots/`, and `node scripts/preview/film.mjs` films its motion there.

## Layout

| Path | What |
|---|---|
| `src/main.ts` | The panel: reading, drawing and its motion, switching, connecting |
| `src/model.ts` | An agent's state in words, the icon's state, amounts (tested in `model.test.ts`) |
| `src/masks.ts` | Each agent's face, cut from its art as imd.fun does |
| `src/api.ts` | Everything the panel asks of the Rust side |
| `src-tauri/src/lib.rs` | The tray, the panel window, the API client, the key, signing, the box |
| `scripts/icons.py` | The tray and app icons, drawn from the IMD mark |

## Release

`pnpm release 0.1.1`, on the maintainer's Mac, builds one app for Apple Silicon and Intel, signs it with the Developer ID, notarizes and staples it and its disk image, and publishes both on this repository's releases with the update installed copies fetch. `pnpm release --dry-run` does everything but commit and publish. The certificate, the notarization profile and the update key stay in that Mac's keychain, never in GitHub's secrets.

Installed copies update themselves: a minute after they start and every six hours, they read the latest release, and install a newer one once the panel has been closed for five minutes with no setup under way.

`.github/workflows/build.yml` still builds unsigned installers for macOS and Windows when run by hand.
