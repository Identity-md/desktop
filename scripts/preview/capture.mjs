// Screenshots of the panel in the browser, with the Rust side stood in for by real public data.
// pnpm dev (port 1430) first, then: node scripts/preview/capture.mjs  →  scripts/preview/shots/*.png
import { readFileSync, mkdirSync } from "node:fs";
import { chromium } from "playwright-core";
import { mockApp } from "./mock.mjs";
import { panelStates } from "./panel-states.js";
const fixtures = JSON.parse(readFileSync(new URL("./fixtures.json", import.meta.url), "utf8"));
const out = new URL("./shots/", import.meta.url).pathname;
mkdirSync(out, { recursive: true });
const owner = fixtures.wallet;
const scenarios = Object.fromEntries(panelStates(fixtures).map((state) => [state.id, state.scenario]));
const only = process.argv[2] ? new Set(process.argv[2].split(",")) : null;

const browser = await chromium.launch({ channel: "chrome", headless: true });
for (const [name, scenario] of Object.entries(scenarios)) {
  if (only && !only.has(name)) continue;
  for (const scheme of ["light", "dark"]) {
    const context = await browser.newContext({ viewport: { width: 404, height: 900 }, deviceScaleFactor: 2, colorScheme: scheme });
    await mockApp(context, { fixtures, scenario, owner, scheme });
    const page = await context.newPage();
    await page.goto("http://localhost:1430/", { waitUntil: "load" });
    await page.waitForTimeout(1800);
    for (const selector of scenario.clicks ?? []) { await page.click(selector); await page.waitForTimeout(900); }
    await page.mouse.move(0, 0);
    await page.waitForTimeout(500);
    const box = await page.locator("#panel").boundingBox();
    await page.screenshot({ path: `${out}${name}-${scheme}.png`, clip: { x: 0, y: 0, width: 404, height: Math.ceil(box.y + box.height + 32) } });
    await context.close();
  }
}
await browser.close();
console.log("shots in", out);
