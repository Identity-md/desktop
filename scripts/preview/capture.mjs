// Pictures of every state of the panel and the setup window, light and dark, as this computer draws them: Chrome on
// a Mac, Edge on Windows, each in its own fonts. Each is the window alone on clear pixels with room for its shadow,
// at twice its size, as the state pages draw it with ?shot. pnpm dev first, then:
//   node scripts/preview/capture.mjs [panel | setup | <picture>…]  →  scripts/preview/shots/<mac|windows>/<picture>-<theme>.png
// A picture is a window and a state, as panel-connected or setup-intro. PREVIEW_URL names another dev server.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { panelStates } from "./panel-states.js";
import { statesFor } from "./setup-states.js";

const BASE = `${process.env.PREVIEW_URL ?? "http://localhost:1430"}/scripts/preview/`;
const os = process.platform === "win32" ? "windows" : "mac";
const out = fileURLToPath(new URL(`./shots/${os}/`, import.meta.url));
const fixturesFile = new URL("./fixtures.json", import.meta.url);
const fixtures = existsSync(fixturesFile) ? JSON.parse(readFileSync(fixturesFile, "utf8")) : null;

// the panel is its own window; the setup window is its page in the title bar the review page draws
const pictures = [
  ...(fixtures ? panelStates(fixtures) : []).map((state) => ({ name: `panel-${state.id}`, window: "panel", width: 404, url: (theme) => `panel-state.html?state=${state.id}&theme=${theme}&shot` })),
  ...statesFor(os).map((state) => ({ name: `setup-${state.id}`, window: "setup", width: 516, url: (theme) => `setup-review.html?os=${os}&theme=${theme}&shot#${state.id}` })),
];
const asked = process.argv.slice(2);
const wanted = pictures.filter((p) => !asked.length || asked.includes(p.window) || asked.includes(p.name));
const unknown = asked.filter((name) => !pictures.some((p) => p.window === name || p.name === name));
if (unknown.length) {
  console.error(`No picture named ${unknown.join(", ")}.${fixtures ? "" : " The panel's need fixtures.json: node scripts/preview/fixtures.mjs <wallet>."}`);
  process.exit(1);
}
if (!fixtures) console.log("No wallet read, so the setup window only. node scripts/preview/fixtures.mjs <wallet> reads one for the panel.");
if (!(await fetch(`${BASE}panel-review.html`).then((r) => r.ok).catch(() => false))) {
  console.error(`Nothing at ${BASE}: start the preview with pnpm dev first.`);
  process.exit(1);
}
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ channel: os === "windows" ? "msedge" : "chrome" });
async function take(picture, theme) {
  // a context each, as each state keeps its settings in the page's storage, and one that prefers the theme, as Edge
  // needs for its dark
  const context = await browser.newContext({ colorScheme: theme, deviceScaleFactor: 2, viewport: { width: picture.width, height: 1200 } });
  try {
    const page = await context.newPage();
    await page.goto(`${BASE}${picture.url(theme)}`);
    const state = picture.window === "setup" ? page.frameLocator("#frame") : page;
    await state.locator("html[data-ready]").waitFor({ state: "attached", timeout: 30_000 });
    // what the last press set off, drawn
    await page.waitForTimeout(1000);
    const path = `${out}${picture.name}-${theme}.png`;
    if (picture.window === "setup") return await page.locator(".review").screenshot({ path, omitBackground: true });
    // the panel's window, as the app sizes it: the panel, a little room above, 22 at the sides, 32 below for the shadow
    const panel = await page.locator("#panel").boundingBox();
    await page.screenshot({ path, clip: { x: 0, y: 0, width: picture.width, height: Math.ceil(panel.y + panel.height + 32) }, omitBackground: true });
  } catch (error) {
    console.error(`${picture.name}-${theme}: ${error.message.split("\n")[0]}`);
    process.exitCode = 1;
  } finally {
    await context.close();
  }
}

// four at a time
const queue = wanted.flatMap((picture) => ["light", "dark"].map((theme) => [picture, theme]));
const total = queue.length;
await Promise.all(Array.from({ length: 4 }, async () => { while (queue.length) await take(...queue.shift()); }));
await browser.close();
console.log(`${total} pictures in ${out}`);
