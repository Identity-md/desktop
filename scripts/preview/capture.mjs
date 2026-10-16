// Screenshots of the panel in the browser, with the Rust side stood in for by real public data.
// pnpm dev (port 1430) first, then: node scripts/preview/capture.mjs  →  scripts/preview/shots/*.png
import { readFileSync, mkdirSync } from "node:fs";
import { chromium } from "playwright-core";
import { mockApp } from "./mock.mjs";
const fixtures = JSON.parse(readFileSync(new URL("./fixtures.json", import.meta.url), "utf8"));
const out = new URL("./shots/", import.meta.url).pathname;
mkdirSync(out, { recursive: true });
const owner = fixtures.wallet;
const other = fixtures.wallets?.[1] ?? null;

// `linked` may pause and resume; `watching` only shows
const scenarios = {
  connected: { box: "running", linked: [owner], watching: [] },
  watching: { box: "running", linked: [], watching: [owner] },
  rewards: { box: "running", linked: [], watching: [owner], clicks: ["[data-action=rewards]"] },
  agent: { box: "running", linked: [owner], watching: [], clicks: ["#agent-22 .lines"] },
  outdated: { box: "running", linked: [owner], watching: [], outdated: "22", clicks: ["#agent-22 .lines"] },
  restart: { box: "running", linked: [owner], watching: [], clicks: ["#agent-12 .lines"] },
  jailed: { box: "running", linked: [owner], watching: [], jailed: ["12", "22"], clicks: ["#agent-12 .lines"] },
  "jailed-other": { box: "running", linked: [owner], watching: [], jailed: ["12", "22"], clicks: ["#agent-22 .lines"] },
  held: { box: "running", linked: [owner], watching: [], held: "22" },
  welcome: { box: "no-docker", linked: [], watching: [] },
  "setup-docker": { box: "no-docker", linked: [], watching: [], setup: { docker: "missing", image: false, worker: false, claude: false, device_key: null }, clicks: ["[data-action=setup]"] },
  "setup-signin": { box: "no-docker", linked: [], watching: [], setup: { docker: "running", image: true, worker: true, claude: false, device_key: "e000000000000000000000000000000000000000000000000000000000000000" }, clicks: ["[data-action=setup]"] },
  "setup-pair": { box: "no-docker", linked: [], watching: [], setup: { docker: "running", image: true, worker: true, claude: true, device_key: "e000000000000000000000000000000000000000000000000000000000000000" }, clicks: ["[data-action=setup]", "[data-action=step]"] },
  "setup-start": { box: "no-docker", linked: [], watching: [], setup: { docker: "running", image: true, worker: true, claude: true, device_key: "d5e40d01".padEnd(64, "0") }, clicks: ["[data-action=setup]"] },
  linking: { box: "running", linked: [], watching: [owner], clicks: ["[data-action=settings]", "[data-action=connect]"] },
  settings: { box: "running", linked: [owner], watching: other ? [other] : [], clicks: ["[data-action=settings]"] },
  "settings-watching": { box: "running", linked: [], watching: [owner], clicks: ["[data-action=settings]"] },
  off: { box: "stopped", linked: [owner], watching: [] },
};
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
