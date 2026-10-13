// Reads real public data for the preview: one wallet's seats, their standings and records, its rewards, and faces.
// node scripts/preview/fixtures.mjs <wallet>  →  scripts/preview/fixtures.json (git-ignored)
import { writeFileSync } from "node:fs";
const API = "https://api.imd.fun";
const wallet = (process.argv[2] ?? "").toLowerCase();
const get = async (path) => {
  for (let i = 0; i < 4; i++) {
    const r = await fetch(API + path);
    if (r.status === 429) { await new Promise((ok) => setTimeout(ok, 15_000)); continue; }
    return { status: r.status, body: r.ok ? await r.json() : null };
  }
  return { status: 429, body: null };
};
const out = { wallet, api: {}, svg: {} };
const pair = await get(`/pair/wallet/${wallet}`);
out.api[`/pair/wallet/${wallet}`] = pair;
for (const seat of pair.body?.tokens ?? []) {
  for (const path of [`/seats/${seat.tokenId}/standing?queue=0`, `/seats/${seat.tokenId}?work=200&reviews=0&collaborators=0`]) out.api[path] = await get(path);
  out.svg[seat.tokenId] = await (await fetch(`${API}/agents/by-token/${seat.tokenId}.svg`)).text();
}
out.api[`/wallets/${wallet}/earnings?limit=50`] = await get(`/wallets/${wallet}/earnings?limit=50`);
writeFileSync(new URL("./fixtures.json", import.meta.url), JSON.stringify(out));
console.log("seats", (pair.body?.tokens ?? []).map((t) => t.tokenId).join(","), "earnings", out.api[`/wallets/${wallet}/earnings?limit=50`].body?.earnings?.length);
