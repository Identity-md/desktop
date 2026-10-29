# Preview

The app's two windows in a browser: every state of the panel and of the setup window, the real pages drawn from a wallet's public data, with the app's Rust side stood in for. No Tauri, Docker or agent needed, and changes to `src/` show as they're saved. Nothing here ships in the app.

## Start

```sh
pnpm install
node scripts/preview/fixtures.mjs <wallet> [<wallet>]
pnpm dev
```

`fixtures.mjs` reads a wallet's public data into `fixtures.json`, which git ignores: its seats, their records, rewards and faces, and the swarm. The wallet should hold a seat or two. Its first seat plays this computer's agent, and its second one on another machine. A second wallet, if you give one, is the one it watches. The panel's clock reads the moment the data was read, so "today" and "4h ago" stay true however old the file is. Read again for fresh data.

Then open:

- [panel-review.html](http://localhost:1430/scripts/preview/panel-review.html), the panel
- [setup-review.html](http://localhost:1430/scripts/preview/setup-review.html), the setup window, a Mac's or a PC's

`←` `→` page through the states, `R` plays one again, `T` switches light and dark, and in setup `M` and `W` pick the computer. Every state has its own link, as `panel-review.html#working`.

## Pictures

```sh
node scripts/preview/capture.mjs [panel | setup | <picture>…]
```

Takes every state of both windows, light and dark, into `shots/mac/` or `shots/windows/`, as `panel-connected-dark.png` or `setup-intro-light.png`. Each is the window alone on clear pixels, with room for its shadow, at twice its size. Name a window or pictures to take only those: `node scripts/preview/capture.mjs panel-connected setup-done`.

It draws with this computer's browser and fonts, Chrome on a Mac and Edge on Windows, so a PC's pictures are taken on a PC.

`node scripts/preview/film.mjs [light|dark]` films the panel's motion into `shots/motion-<theme>.webm`.

## One state

| Link | Shows |
|---|---|
| `panel-state.html?state=<id>` | The panel in one state |
| `setup-state.html?state=<id>&os=mac` | The setup page in one state, a Mac's, or a PC's with `os=windows` |
| `setup-review.html?os=mac&shot#<id>` | The setup window alone, in its title bar |

Each takes `&theme=light` or `&theme=dark`. `&shot` holds the state still for a picture: every animation ends at once, and the panel is as tall as what's in it. The ids, and what each state shows, are in `panel-states.js` and `setup-states.js`.

## Files

| File | What |
|---|---|
| `panel-review.html`, `setup-review.html` | The pages that go through every state |
| `panel-state.html`, `setup-state.html` | One state: the real page, with the stand-in |
| `panel-states.js`, `setup-states.js` | Every state: what the stand-in answers, and what to press to get there |
| `mock.mjs` | The stand-in for the Rust side, answering from `fixtures.json` |
| `preview.js` | What the pages share: the wallet's data, the theme, and `&shot` |
| `fixtures.mjs` | Reads a wallet's public data |
| `capture.mjs`, `film.mjs` | Pictures and a film, through Playwright |
