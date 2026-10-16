// The disk image's window: imd.fun's own wall, drawn by the site's renderer around a monitor in its
// middle, the monitor's glass lit with the app, an arrow and Applications on it. `pnpm release` lays the
// icons over it where window.mjs says.
//
// node scripts/installer/background.mjs  →  src-tauri/installer/dmg-background.tiff (1x and 2x)
//
// Needs the website checked out beside this repository (or IMD_WEBSITE pointing at it). The site keeps its
// monitor at the foot of the wall and sizes it for its status line; this one picture centres it and sizes
// it for two icons, a single line changed as the renderer is bundled, nothing changed in the site.
// The glass is a mid-tone green on purpose: Finder writes icon names black in light mode and white in
// dark, and both read on it at about 4.6:1.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import * as esbuild from "esbuild";
import { chromium } from "playwright-core";
import { ICONS, WINDOW } from "./window.mjs";

const ROOT = new URL("../..", import.meta.url).pathname;
const SITE = resolve(process.env.IMD_WEBSITE ?? join(ROOT, "../imd-website"));
const OUT = join(ROOT, "src-tauri/installer/dmg-background.tiff");
// The wall at about 23 points a cell, shown at 0.87: twice the size the window first had, a little
// larger than the homepage's. The monitor 22 by 11 cells, room for two 128-point icons and their names.
const WALL = { width: 1460, height: 912 }, MONITOR = { w: 22, h: 11 }, SCALE = 0.87;

const dir = mkdtempSync(join(tmpdir(), "imd-dmg-"));
try {
  writeFileSync(join(dir, "entry.ts"), `
import { WallRenderer } from ${JSON.stringify(join(SITE, "lib/machine/renderer"))};
import { fetchSwarm } from ${JSON.stringify(join(SITE, "lib/swarm"))};
const w = window as any;
(async () => {
  try {
    const snapshot = await fetchSwarm(new AbortController().signal);
    if (!snapshot) throw new Error("the swarm did not answer");
    const cv = document.getElementById("wall") as HTMLCanvasElement;
    const r: any = new WallRenderer(cv, { fontFamily: getComputedStyle(cv).fontFamily, onTip: () => {}, onOpen: () => {}, still: true, forget: true });
    r.setTheme("steel");
    // the room's two controls as blank plates: an installer has neither
    const blank = function (this: any, bk: any) {
      const c = this.layout.cell, x = bk.c * c + 1, y = bk.r * c + 1, bw = bk.w * c - 2, bh = bk.h * c - 2;
      this.ctx.fillStyle = this.pal.face; this.ctx.fillRect(x, y, bw, bh);
      this.ctx.strokeStyle = this.edge; this.ctx.lineWidth = 1; this.ctx.strokeRect(x + 0.5, y + 0.5, bw - 1, bh - 1);
    };
    r.drawPlay = blank; r.drawCog = blank;
    r.monitorSize = function (this: any, cell: number) { this.setMetrics(cell); return ${JSON.stringify(MONITOR)}; };
    r.update(snapshot, ${WALL.width}, ${WALL.height});
    const L = r.layout, m = L.blocks.find((b: any) => b.kind === "monitor");
    cv.style.width = "${WALL.width}px"; cv.style.height = (L.rows * L.cell) + "px";
    w.__info = { height: L.rows * L.cell, bez: r.BEZ, monitor: { x: m.c * L.cell + 1, y: m.r * L.cell + 1, w: m.w * L.cell - 2, h: m.h * L.cell - 2 } };
  } catch (e) { w.__error = String(e); }
})();`);
  await esbuild.build({
    entryPoints: [join(dir, "entry.ts")], bundle: true, format: "esm", platform: "browser", target: "es2022",
    outfile: join(dir, "wall.js"), tsconfig: join(SITE, "tsconfig.json"), logLevel: "error",
    plugins: [{ name: "centre-monitor", setup(build) {
      build.onLoad({ filter: /lib\/machine\/layout\.ts$/ }, (args) => {
        const source = readFileSync(args.path, "utf8"), foot = "block.r = Math.max(1, rows - block.h - 1);";
        if (!source.includes(foot)) throw new Error("the site's layout no longer places its monitor with the line this script changes");
        return { contents: source.replace(foot, "block.r = Math.max(1, Math.round((rows - block.h) / 2));"), loader: "ts" };
      });
    } }],
  });
  writeFileSync(join(dir, "wall.html"), `<!doctype html><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600&display=block" rel="stylesheet">
<style>html,body{margin:0;background:#000} canvas{display:block;font-family:"IBM Plex Mono",ui-monospace,monospace}</style>
<canvas id="wall"></canvas><script>window.process = { env: { NODE_ENV: "production" } };</script><script type="module" src="wall.js"></script>`);

  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    // the wall, served as a page so its module loads, and read from the live swarm
    const site = await browser.newPage({ viewport: { width: WALL.width + 40, height: WALL.height + 400 }, deviceScaleFactor: 2 });
    await site.route("http://wall.local/**", (route) => {
      const name = new URL(route.request().url()).pathname.slice(1);
      route.fulfill({ contentType: name.endsWith(".js") ? "text/javascript" : "text/html", body: readFileSync(join(dir, name)) });
    });
    await site.goto("http://wall.local/wall.html");
    await site.waitForFunction(() => window.__info || window.__error, null, { timeout: 60_000 });
    const info = await site.evaluate(() => window.__info ?? { error: window.__error });
    if (info.error) throw new Error(info.error);
    await site.waitForTimeout(800);
    await site.locator("#wall").screenshot({ path: join(dir, "wall.png") });

    // the window, framed on the monitor
    const m = info.monitor, s = SCALE;
    const ox = m.x + m.w / 2 - WINDOW.width / s / 2, oy = m.y + m.h / 2 - WINDOW.height / s / 2;
    const glass = { x: (m.x + info.bez - ox) * s, y: (m.y + info.bez - oy) * s, w: (m.w - 2 * info.bez) * s, h: (m.h - 2 * info.bez) * s };
    const mid = { x: Math.round(glass.x + glass.w / 2), y: Math.round(glass.y + (glass.h - 150) / 2 + 64) };
    if (mid.x !== (ICONS.app[0] + ICONS.applications[0]) / 2 || mid.y !== ICONS.app[1]) {
      throw new Error(`the glass's middle is (${mid.x}, ${mid.y}); ICONS and pnpm release must move with it`);
    }
    writeFileSync(join(dir, "background.html"), `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;background:#000}
.frame{position:relative;width:${WINDOW.width}px;height:${WINDOW.height}px;overflow:hidden;background:#000}
.wall{position:absolute;left:${-ox * s}px;top:${-oy * s}px;width:${WALL.width * s}px;height:${info.height * s}px}
.glass{position:absolute;left:${glass.x}px;top:${glass.y}px;width:${glass.w}px;height:${glass.h}px;background:#4a8160;
  background-image:repeating-linear-gradient(0deg,rgba(0,0,0,.12) 0 1px,transparent 1px 3px),radial-gradient(130% 150% at 50% 45%,rgba(255,255,255,.07),rgba(0,0,0,.16));
  box-shadow:inset 0 0 0 1px rgba(57,211,83,.35),inset 0 0 18px rgba(0,0,0,.28)}
.arrow{position:absolute;left:${mid.x - 26}px;top:${mid.y - 14}px;width:52px;height:28px}
</style><div class="frame"><img class="wall" src="wall.png"><div class="glass"></div>
<svg class="arrow" viewBox="0 0 52 28"><path d="M3 14 H44 M32 3.5 L45.5 14 L32 24.5" fill="none" stroke="#0b1f12" stroke-width="5" stroke-linecap="square"/></svg></div>`);
    for (const [name, scale] of [["background.png", 1], ["background@2x.png", 2]]) {
      const page = await browser.newPage({ viewport: WINDOW, deviceScaleFactor: scale });
      await page.goto(`file://${join(dir, "background.html")}`);
      await page.waitForTimeout(400);
      await page.screenshot({ path: join(dir, name), clip: { x: 0, y: 0, ...WINDOW } });
      await page.close();
    }
  } finally {
    await browser.close();
  }
  // one file Finder reads at either scale
  execFileSync("tiffutil", ["-cathidpicheck", join(dir, "background.png"), join(dir, "background@2x.png"), "-out", OUT]);
  console.log(`wrote ${OUT}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
