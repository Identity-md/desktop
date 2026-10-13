// A short film of the panel's motion, in the browser: it opens and its numbers roll from the last look, the
// chart is scrubbed, a job flies in from the agent that did it, an agent starts work and opens into its tray.
// pnpm dev (port 1430) first, then: node scripts/preview/film.mjs [light|dark]  →  scripts/preview/shots/motion-<scheme>.webm
import { readFileSync, mkdirSync, renameSync } from "node:fs";
import { chromium } from "/Users/gtm/Documents/GitHub/node_modules/playwright-core/index.mjs";
import { mockApp } from "./mock.mjs";
const fixtures = JSON.parse(readFileSync(new URL("./fixtures.json", import.meta.url), "utf8"));
const out = new URL("./shots/", import.meta.url).pathname;
mkdirSync(out, { recursive: true });
const scheme = process.argv[2] ?? "light";
const owner = fixtures.wallet;

const browser = await chromium.launch({ channel: "chrome", headless: true });
// video is recorded at one pixel per point, so the page is drawn at twice its size instead
const context = await browser.newContext({ viewport: { width: 808, height: 1440 }, colorScheme: scheme, recordVideo: { dir: out, size: { width: 808, height: 1440 } } });
// the panel last closed two accepted jobs and some rewards ago, and the Mac mini is at work
const totals = (() => {
  const record = (id) => fixtures.api[`/seats/${id}?work=100&reviews=0&collaborators=0`]?.body;
  const day = Date.now() - 86_400_000;
  const records = [record(12), record(22)].filter(Boolean);
  return {
    today: records.reduce((n, r) => n + r.work.filter((w) => Date.parse(w.acceptedAt ?? "") > day).length, 0),
    accepted: records.reduce((n, r) => n + r.accepted, 0),
  };
})();
const rewards = fixtures.api[`/wallets/${owner}/earnings?limit=50`]?.body?.earnings ?? [];
const scenario = {
  box: "running", linked: [owner], watching: [],
  // the panel last closed two jobs, some dollars and two coins ago
  seen: { today: Math.max(0, totals.today - 2), accepted: totals.accepted - 2, usd: 471.18, coins: rewards.slice(2).map((r) => r.launchId) },
};
await mockApp(context, { fixtures, scenario, owner, scheme, zoom: 2 });
const page = await context.newPage();
const wait = (ms) => page.waitForTimeout(ms);
await page.goto("http://localhost:1430/", { waitUntil: "load" });
// closed, as the panel is until its icon is clicked
await page.evaluate(() => { document.getElementById("panel").style.visibility = "hidden"; });
await wait(2600);

// it opens: the numbers roll from where they stood, a +2 on what came in, new coins drop into the stack
await page.evaluate(() => { document.getElementById("panel").style.visibility = ""; window.__emit("panel-shown", false); });
await wait(3000);

// scrubbing the chart: the first number follows the day under the pointer
const spark = await page.locator(".spark").boundingBox();
for (let i = 0; i <= 13; i++) {
  await page.mouse.move(spark.x + ((i + 0.5) / 14) * spark.width, spark.y + spark.height / 2);
  await wait(170);
}
await page.mouse.move(spark.x + (4.5 / 14) * spark.width, spark.y + spark.height / 2);
await wait(1100);
await page.mouse.move(20, 1400);
await wait(900);

// #22 has a job accepted while the panel is open: a +1 flies from its face into the count
await page.evaluate(() => {
  const at = new Date().toISOString();
  for (const rows of [100, 500]) {
    const record = window.__fixtures.api[`/seats/22?work=${rows}&reviews=0&collaborators=0`].body;
    record.work.unshift({ jobId: "film", nodeKey: "design_critic", status: "accepted", submittedAt: at, acceptedAt: at, objective: "Review the launch page for the new swarm token: hierarchy, contrast and the mobile layout." });
    record.accepted += 1;
  }
});
await page.keyboard.press("r");
await wait(2600);

// #22 takes its next job: its face squashes and settles, its status starts to shimmer, the header says so
await page.evaluate(() => { window.__working = { tokenId: "22", nodeKey: "adversarial_review", objective: "Break the swap router: find any path that leaves the pool short.", minutes: 0 }; });
await page.keyboard.press("r");
await wait(2600);

// what it is on, in its tray
await page.click("#agent-22 .lines");
await wait(2300);
await page.click("#agent-22 .lines");
await wait(1500);

const video = page.video();
await context.close();
await browser.close();
const file = `${out}motion-${scheme}.webm`;
renameSync(await video.path(), file);
console.log(file);
