// Reads real public data for the preview: each wallet's seats, their standings and records, rewards, faces,
// and the swarm. The first wallet is the one the panel is about, and holds a seat or two; any after it are watched.
// node scripts/preview/fixtures.mjs <wallet> [<wallet>…]  →  scripts/preview/fixtures.json (git-ignored)
import { writeFileSync } from "node:fs";
const API = "https://api.imd.fun";
const wallets = process.argv.slice(2).map((w) => w.toLowerCase());
const odd = wallets.find((w) => !/^0x[0-9a-f]{40}$/.test(w));
if (!wallets.length || odd) {
  console.error(odd ? `${odd} isn't a wallet address: pass its 0x address.` : "node scripts/preview/fixtures.mjs <wallet> [<wallet>…]");
  process.exit(1);
}
const get = async (path) => {
  for (let i = 0; i < 4; i++) {
    const r = await fetch(API + path);
    if (r.status === 429) { await new Promise((ok) => setTimeout(ok, 15_000)); continue; }
    return { status: r.status, body: r.ok ? await r.json() : null };
  }
  return { status: 429, body: null };
};
// two weeks of work rows are only counted: their times are all that is kept of them
const slim = (answer) => (answer.body?.work ? { ...answer, body: { ...answer.body, work: answer.body.work.map((row) => ({ submittedAt: row.submittedAt, acceptedAt: row.acceptedAt })) } } : answer);
// the moment it was read, which the panel's clock reads as now, so "today" and "ago" stay true however old the file
const out = { readAt: new Date().toISOString(), wallet: wallets[0], wallets, api: {}, svg: {}, explorer: {} };
for (const wallet of wallets) {
  const pair = await get(`/pair/wallet/${wallet}`);
  out.api[`/pair/wallet/${wallet}`] = pair;
  for (const seat of pair.body?.tokens ?? []) {
    out.api[`/seats/${seat.tokenId}/standing?queue=0`] = await get(`/seats/${seat.tokenId}/standing?queue=0`);
    for (const rows of [0, 100, 500]) {
      const path = `/seats/${seat.tokenId}?work=${rows}&reviews=0&collaborators=0`;
      const answer = await get(path);
      out.api[path] = rows === 500 ? slim(answer) : answer;
    }
    out.svg[seat.tokenId] = await (await fetch(`${API}/agents/by-token/${seat.tokenId}.svg`)).text();
  }
  out.api[`/wallets/${wallet}/earnings?limit=50`] = await get(`/wallets/${wallet}/earnings?limit=50`);
  // what is ready to claim and its worth: the explorer's to say
  for (const path of [`/api/earned?wallet=${wallet}`, `/api/earned/value?wallet=${wallet}`]) {
    const r = await fetch(`https://explorer.imd.fun${path}`);
    out.explorer[path] = { status: r.status, body: r.ok ? await r.json() : null };
  }
  console.log(wallet, "seats", (pair.body?.tokens ?? []).map((t) => t.tokenId).join(","), "earnings", out.api[`/wallets/${wallet}/earnings?limit=50`].body?.earnings?.length);
  if (wallet === out.wallet && !pair.body?.tokens?.length) {
    console.error(`${wallet} holds no seats, and the panel's states need one: read a wallet that holds a seat first.`);
    process.exit(1);
  }
}
// the worker's releases, which say which agents run an older one
const releases = await (await fetch("https://api.github.com/repos/Identity-md/worker/releases?per_page=10", { headers: { accept: "application/vnd.github+json" } })).json().catch(() => []);
out.releases = Array.isArray(releases) ? releases.map((r) => ({ tag_name: r.tag_name, published_at: r.published_at, draft: r.draft, prerelease: r.prerelease })) : [];
const swarm = await get("/swarm");
// the counts and what just happened; the seats' standings are more than the preview needs
const clip = (text) => (typeof text === "string" && text.length > 160 ? text.slice(0, 160) : text);
out.api["/swarm"] = { status: swarm.status, body: swarm.body ? { health: swarm.body.health, events: (swarm.body.events ?? []).map((e) => ({ ...e, objective: clip(e.objective), reason: undefined })) } : null };
writeFileSync(new URL("./fixtures.json", import.meta.url), JSON.stringify(out));
console.log("swarm", JSON.stringify(out.api["/swarm"].body?.health ?? null));
