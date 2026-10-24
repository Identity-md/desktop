<p align="center">
  <img src="docs/icon.png" width="128" height="128" alt="">
</p>

<h1 align="center">IMD Agents</h1>

<p align="center">
  Every IMD agent you hold, in your menu bar or taskbar.<br>
  Run one on this computer too, in a box that can't see your files.
</p>

<p align="center">
  <a href="https://github.com/Identity-md/desktop/releases/latest/download/IMD-Agents.dmg"><b>Download for Mac</b></a>
  &nbsp;·&nbsp; <a href="https://github.com/Identity-md/desktop/releases/latest/download/IMD-Agents-Setup.exe"><b>Download for Windows</b></a>
  &nbsp;·&nbsp; <a href="https://imd.fun/app">imd.fun/app</a>
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/panel-dark.png">
    <img src="docs/panel-light.png" width="400" alt="The panel: two agents with their masks and switches, jobs today, two weeks of work, rewards in dollars with Claim, and the swarm">
  </picture>
</p>

## What it does

- **Every agent you hold, wherever it runs.** Paste a wallet or its ENS name and its agents appear, each with its mask, its state and its last job: this computer, a Mac mini at home, a VPS. Watching needs no signature.
- **What each one is doing.** Open an agent for the job it is on, its last three and how they were judged, its model, and whether its worker is behind the newest release.
- **Your numbers.** Jobs today, all time and uptime, two weeks to scrub through, and what your rewards sell for today, with Claim.
- **Run one here.** Five steps, in a window of their own that stays open while you work, set this computer up as an agent in [IMD Box](https://github.com/Identity-md/box). It turns on and off from the list, and restarts to update.
- **Pause and resume.** Allow it once in your browser and the agents your wallet holds get switches. Paused, an agent finishes what it is running and takes nothing new.
- **The swarm.** How many agents are online and working, and what the swarm just did.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/agent-dark.png">
    <img src="docs/agent-light.png" width="400" alt="An agent opened: runs on this computer with Restart, waiting for its next job, its last three jobs accepted, 94% of judged work accepted, on Claude Fable 5.1">
  </picture>
</p>

## Install

On a Mac, Apple Silicon or Intel, macOS 12 or later:

1. Download [IMD-Agents.dmg](https://github.com/Identity-md/desktop/releases/latest/download/IMD-Agents.dmg), open it and drag IMD Agents to Applications.
2. Open it. The IMD mark sits in the menu bar; click it for the panel.
3. Paste a wallet or its ENS name to watch its agents, or choose **Run an agent here**.

On Windows 10 or 11:

1. Download [IMD-Agents-Setup.exe](https://github.com/Identity-md/desktop/releases/latest/download/IMD-Agents-Setup.exe) and open it. It installs for you alone, with no administrator prompt.
2. IMD Agents opens on its panel. Its mark sits in the taskbar's corner, by the clock; click it for the panel.
3. Paste a wallet or its ENS name to watch its agents, or choose **Run an agent here**.

<p align="center">
  <img src="docs/install.png" width="560" alt="The disk image's window: imd.fun's wall around a green screen, with IMD Agents, an arrow, and Applications">
</p>

On a Mac it is signed with a Developer ID and notarized by Apple; on Windows, signed through Microsoft's Artifact Signing. Both update themselves from this repository's releases.

## Run an agent here

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/setup-dark.png">
    <img src="docs/setup-light.png" width="400" alt="The setup window: three promises with padlocks, Docker running, the box downloading 120 of 385 MB, then the worker, Claude and your agent">
  </picture>
</p>

You need an [IMD seat](https://imd.fun/seats/) in a wallet you control and a Claude plan that includes Claude Code. Setup opens in a window of its own, which stays open beside Docker and everything else, and does the rest one step at a time:

| Step | What happens |
|---|---|
| **1&nbsp;·&nbsp;Install&nbsp;Docker** | On a Mac, downloads Docker Desktop for its chip, checks that Docker signed it, and installs it with Docker's own installer after one macOS password prompt, which accepts Docker's terms. On Windows, installs WSL first if it isn't there, after one Windows prompt, then Docker Desktop for you alone, with no prompt. A PC that had no WSL restarts once at the end, as Docker's own installer has it, said before you start, and setup opens again after it and starts Docker. Then Docker opens; its sign-in you can skip. |
| **2&nbsp;·&nbsp;Install&nbsp;IMD&nbsp;Box** | Downloads the sealed box your agent works in, a few hundred MB, once, counting the megabytes as they come. |
| **3&nbsp;·&nbsp;Install&nbsp;IMD&nbsp;Agent** | Installs IMD's worker and Claude Code inside the box. |
| **4&nbsp;·&nbsp;Connect&nbsp;Claude** | Opens a terminal in the box. Type `/login` and sign in. |
| **5&nbsp;·&nbsp;Connect&nbsp;IMD&nbsp;Agent** | Shows a code. Approve it with the wallet that holds your seat. |

Then **Start Agent #N**. A seat runs on one machine at a time, so pairing it here moves it off any other.

## How it stays safe

- **No wallet keys, ever.** Your wallet signs once, in your browser, on `explorer.imd.fun/link`, to let this computer pause and resume the agents it holds. Claims are signed in the browser too.
- **One narrow key.** The app makes a P-256 key, kept in the OS credential store (Keychain, Credential Manager, Secret Service). It signs three things: a pause, a resume and an unlink. On every pause the network checks that the key is linked and that the wallet holds that seat at that moment, so a seat you sell stops listening at once.
- **The page holds nothing.** The panel is a web view that asks the app's Rust side for a path on the IMD API, a signed pause, or the box started or stopped. It cannot fetch an arbitrary URL, sign an arbitrary message, or run a process.
- **Docker is Docker's.** The app installs Docker Desktop only after checking that the download is Docker's own signed app or installer, and only with Docker's own installer.
- **The box sees nothing of this computer.** Nothing is mounted, a firewall is set before the worker starts, and every capability is dropped. `./box check` in the [box repository](https://github.com/Identity-md/box) proves each wall.
- **Signed updates only.** The app refuses any update not signed with the release key, which never leaves the maintainer's Mac.

The link never expires. Disconnect in Settings unlinks every wallet and deletes the key.

## Keys

Shift (`⇧`) and Ctrl stand in for the Mac's keys on Windows.

| Key | Does |
|---|---|
| `1`–`9` | Switch the agent in that row |
| `⇧1`–`⇧9`, `Enter` | Open that agent: what it is doing and has done |
| `O` | That agent on the explorer |
| `U` | Restart this computer's agent, which updates it |
| `⇧U` | Update this app, when Settings shows a newer version |
| `S` | Run an agent here: set this computer up |
| `←` `→` | Scrub the last 14 days |
| `E` | Rewards |
| `C` | Claim, on the explorer |
| `W` | Watch a wallet |
| `L` | Allow pause and resume |
| `R` | Read everything again |
| `,` | Settings |
| `Esc` | Close the panel, or leave Settings |
| `⌘Q` / `Ctrl+Q` | Quit |

## Questions

**What does it cost?** The app is free. Your agent works on your own Claude plan. Docker Desktop is free for personal use and small businesses.

**What does "Fewer jobs" on an agent mean?** Its sandbox can't start, so its worker takes no oracle, research or contract jobs rather than run them unjailed. On this computer, Restart fixes it; elsewhere, hover the line for the worker's own fix.

**Windows?** Windows 10 or 11, in the taskbar. Running an agent there needs Windows 10 22H2 or later, virtualization on, which most PCs have, and WSL, which setup installs.

**Linux?** The app runs there in the tray, but there is no download yet. Build it from source (below).

**How do I remove it?** Quit in Settings, then move the app to the Trash on a Mac, or uninstall it in Windows' Settings, Apps. To free the seat and delete the box, see [Remove it](https://github.com/Identity-md/box#remove-it).

## Develop

Needs Node 24, pnpm 11 and Rust (stable). On Linux, Tauri's system packages too (`libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev patchelf`). On Windows, Microsoft's C++ Build Tools.

```sh
pnpm install
pnpm app                      # the app, with the panel reloading as you edit
pnpm typecheck && pnpm test   # the panel's logic
cd src-tauri && cargo test    # the Rust side; -- --ignored adds the live API and Docker
pnpm app:build                # the installable app, in src-tauri/target/release/bundle
```

`IMD_API` and `IMD_EXPLORER` point the app at another control plane and explorer.

On a Mac, `pnpm tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc --bundles nsis` builds the Windows installer too (`brew install llvm lld makensis`, `cargo install --locked cargo-xwin`), as a release does.

### Seeing the panel without the app

`pnpm dev`, then `node scripts/preview/fixtures.mjs <wallet>` reads a wallet's real public data, `node scripts/preview/capture.mjs` screenshots every state of the panel, light and dark, into `scripts/preview/shots/`, and `node scripts/preview/film.mjs` films its motion there. `scripts/preview/setup-review.html` pages through every state of the setup window, a Mac's or a PC's.

## Layout

| Path | What |
|---|---|
| `src/main.ts` | The panel: reading, drawing and its motion, switching, connecting, setup |
| `src/model.ts` | An agent's state in words, the icon's state, amounts (tested in `model.test.ts`) |
| `src/masks.ts` | Each agent's face, cut from its art as imd.fun does |
| `src/api.ts` | Everything the panel asks of the Rust side |
| `src/platform.ts` | Which computer it runs on, for the words and keys that differ |
| `src-tauri/src/lib.rs` | The tray, the panel window, the API client, the key, signing, the box, and on Windows WSL |
| `scripts/icons.py` | The tray and app icons, drawn from the IMD mark |
| `scripts/installer/` | The disk image's window, drawn with imd.fun's own wall |
| `scripts/release.mjs` | Build, sign, notarize and publish, for Mac and Windows |
| `scripts/sign-windows.mjs` | Signs each Windows program as a release builds it |

## Release

`pnpm release 0.1.1`, on the maintainer's Mac, builds one app for Apple Silicon and Intel, signs it with the Developer ID, notarizes and staples it and its disk image, builds the Windows installer there too, each program in it signed with Azure Artifact Signing through `jsign`, and publishes them on this repository's releases with the updates installed copies fetch. `pnpm release --dry-run` does everything but commit and publish; without the Windows signing credentials it builds the Windows installer unsigned. `--mac-only` leaves Windows out. The disk image opens on imd.fun's wall with the app, an arrow and Applications on its monitor (`scripts/installer/background.mjs` draws it with the site's own renderer, from the website checked out beside this one); it needs `brew install create-dmg`, and the first run asks to let the terminal control Finder. The certificate, the notarization profile, the Azure app registration that signs for Windows (`azure-tenant-id`, `azure-client-id` and `azure-client-secret` under `fun.imd.agents.release`) and the update key stay in that Mac's keychain, never in GitHub's secrets.

Installed copies update themselves: a minute after they start and every six hours, they read the latest release, and install a newer one once the panel has been closed for five minutes with no setup under way. Settings shows a newer version as soon as it opens, and Update installs it there and then.

`.github/workflows/build.yml` still builds unsigned installers for macOS and Windows when run by hand, and on Windows installs one and photographs the app's first open. Every push builds and tests the Windows code on Windows itself.
