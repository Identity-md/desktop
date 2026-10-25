// A short film of the panel's motion, in the browser: it opens and its numbers roll from the last look, the
// chart is scrubbed, a job flies in from the agent that did it, an agent starts work and opens into its tray.
// pnpm dev (port 1430) first, then: node scripts/preview/film.mjs [light|dark]  →  scripts/preview/shots/motion-<scheme>.webm
// PREVIEW_URL names another dev server.
import { readFileSync, mkdirSync, renameSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { mockApp } from "./mock.mjs";
import { seatsOf } from "./panel-states.js";
const fixtures = JSON.parse(readFileSync(new URL("./fixtures.json", import.meta.url), "utf8"));
const out = fileURLToPath(new URL("./shots/", import.meta.url));
mkdirSync(out, { recursive: true });
const scheme = process.argv[2] ?? "light";
const owner = fixtures.wallet;
// this computer's agent and the other one, which does the work here
const [here, there = here] = seatsOf(fixtures);

const browser = await chromium.launch({ channel: "chrome", headless: true });
// video is recorded at one pixel per point, so the page is drawn at twice its size instead
const context = await browser.newContext({ viewport: { width: 808, height: 1440 }, colorScheme: scheme, recordVideo: { dir: out, size: { width: 808, height: 1440 } } });
// the panel last closed two accepted jobs and some rewards ago, and the other agent is at work
const totals = (() => {
  const record = (id) => fixtures.api[`/seats/${id}?work=100&reviews=0&collaborators=0`]?.body;
  // the day before the fixtures were read, as the panel's clock has it
  const day = (Date.parse(fixtures.readAt ?? "") || Date.now()) - 86_400_000;
  const records = [...new Set([here, there])].map(record).filter(Boolean);
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
await mockApp(context, { fixtures, scenario });
// a desktop behind the panel, so its shadow shows, and all of it twice the size
await context.addInitScript((scheme) => {
  document.addEventListener("DOMContentLoaded", () => {
    document.documentElement.style.background = scheme === "dark" ? "#0e0e10" : "#e6e6eb";
    Object.assign(document.body.style, { transform: "scale(2)", transformOrigin: "0 0" });
  });
}, scheme);
const page = await context.newPage();
const wait = (ms) => page.waitForTimeout(ms);
await page.goto(`${process.env.PREVIEW_URL ?? "http://localhost:1430"}/`, { waitUntil: "load" });
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

// the other agent has a job accepted while the panel is open: a +1 flies from its face into the count
await page.evaluate((there) => {
  const at = new Date().toISOString();
  for (const rows of [100, 500]) {
    const record = window.__fixtures.api[`/seats/${there}?work=${rows}&reviews=0&collaborators=0`].body;
    record.work.unshift({ jobId: "film", nodeKey: "design_critic", status: "accepted", submittedAt: at, acceptedAt: at, objective: "Review the launch page for the new swarm token: hierarchy, contrast and the mobile layout." });
    record.accepted += 1;
  }
}, there);
await page.keyboard.press("r");
await wait(2600);

// it takes its next job: its face squashes and settles, its status starts to shimmer, the header says so
await page.evaluate((there) => { window.__working = { tokenId: there, nodeKey: "adversarial_review", objective: "Break the swap router: find any path that leaves the pool short.", minutes: 0 }; }, there);
await page.keyboard.press("r");
await wait(2600);

// what it is on, in its tray
await page.click(`#agent-${there} .lines`);
await wait(2300);
await page.click(`#agent-${there} .lines`);
await wait(1500);

const video = page.video();
await context.close();
await browser.close();
const file = `${out}motion-${scheme}.webm`;
renameSync(await video.path(), file);
console.log(file);
