// Screenshots of the panel in the browser, with the Rust side stood in for by real public data.
// pnpm dev (port 1430) first, then: node scripts/preview/capture.mjs  →  scripts/preview/shots/*.png
import { readFileSync, mkdirSync } from "node:fs";
import { chromium } from "/Users/gtm/Documents/GitHub/node_modules/playwright-core/index.mjs";
const fixtures = JSON.parse(readFileSync(new URL("./fixtures.json", import.meta.url), "utf8"));
const out = new URL("./shots/", import.meta.url).pathname;
mkdirSync(out, { recursive: true });
const owner = fixtures.api[`/seats/12?work=200&reviews=0&collaborators=0`]?.body?.owner ?? fixtures.wallet;

const scenarios = {
  connected: { box: "running", wallets: [owner] },
  watching: { box: "running", wallets: [] },
  held: { box: "running", wallets: [owner], held: "22" },
  welcome: { box: "no-docker", wallets: [] },
  linking: { box: "running", wallets: [], click: "[data-action=connect]" },
  settings: { box: "running", wallets: [owner], click: "[data-action=settings]" },
  off: { box: "stopped", wallets: [owner] },
};

const browser = await chromium.launch({ channel: "chrome", headless: true });
for (const [name, scenario] of Object.entries(scenarios)) {
  for (const scheme of ["light", "dark"]) {
    const context = await browser.newContext({ viewport: { width: 360, height: 800 }, deviceScaleFactor: 2, colorScheme: scheme });
    await context.addInitScript(({ fixtures, scenario, owner }) => {
      localStorage.setItem("imd-agents:settings", JSON.stringify({ wallets: scenario.wallets, relayOrigin: "https://api.imd.fun", names: { "22": "Mac mini" }, runtime: "claude", localToken: scenario.box === "no-docker" ? null : "12" }));
      const deviceKey = "d5e40d01".padEnd(64, "0");
      const answer = (path) => {
        if (path === `/workers/${deviceKey}/standing?queue=0`) return { status: 200, body: { enrollment: { status: "active", tokenId: "12" } } };
        const hit = fixtures.api[path];
        if (!hit) return { status: 404, body: null };
        const body = structuredClone(hit.body);
        if (scenario.held && path === `/seats/${scenario.held}/standing?queue=0` && body?.standing) { body.standing.pausedByOwnerAt = new Date().toISOString(); body.standing.working = 0; body.standing.running = []; }
        if (scenario.box !== "running" && scenario.box !== "stopped" && path.startsWith("/pair/wallet/")) return { status: 200, body: { tokens: [] } };
        return { status: hit.status, body };
      };
      const box = { state: scenario.box, installed: scenario.box !== "no-docker", device_key: scenario.box === "running" ? deviceKey : null };
      window.__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label: "panel" }, currentWebview: { windowLabel: "panel", label: "panel" } },
        transformCallback: (cb) => { const id = Math.random(); window[`_${id}`] = cb; return id; },
        invoke: async (cmd, args) => {
          switch (cmd) {
            case "api_get": return answer(args.path);
            case "agent_svg": return fixtures.svg[args.tokenId] ?? null;
            case "box_state": return box;
            case "link_start": return { code: "K7QM4XJ2", expiresAt: new Date(Date.now() + 600000).toISOString(), relayOrigin: "https://api.imd.fun" };
            case "link_poll": return { status: 200, body: { status: "pending", wallet: null } };
            case "plugin:autostart|is_enabled": return true;
            default: return null;
          }
        },
      };
    }, { fixtures, scenario, owner });
    const page = await context.newPage();
    await page.goto("http://localhost:1430/", { waitUntil: "load" });
    await page.waitForTimeout(1800);
    if (scenario.click) { await page.click(scenario.click); await page.waitForTimeout(900); }
    const panel = page.locator("#app");
    await panel.screenshot({ path: `${out}${name}-${scheme}.png` });
    await context.close();
  }
}
await browser.close();
console.log("shots in", out);
