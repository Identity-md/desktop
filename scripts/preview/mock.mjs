// The app's Rust side, stood in for in the browser: real public data from fixtures.json, a box in a given
// state, and events the page listens for, which a script can send with window.__emit(name, payload).
export async function mockApp(context, { fixtures, scenario }) {
  await context.addInitScript(installMock, { fixtures, scenario });
}

/** The stand-in itself, run before the page's own scripts: by Playwright through mockApp, or by a page that imports it. */
export function installMock({ fixtures, scenario }) {
  // the clock reads as it did when the fixtures were read, so every "today", "ago" and fortnight is as it was then
  if (fixtures.readAt) {
    const shift = Date.parse(fixtures.readAt) - Date.now();
    const Real = Date;
    globalThis.Date = class extends Real {
      constructor(...args) { super(...(args.length ? args : [Real.now() + shift])); }
      static now() { return Real.now() + shift; }
    };
  }
  // this computer's agent: the first seat the wallet holds, as in panel-states.js, or with no wallet read, #12
  const local = fixtures.api[`/pair/wallet/${fixtures.wallet}`]?.body?.tokens?.[0]?.tokenId ?? "12";
  // seats watched by number, names given, and what the last run learned: `seats: ["22"]`, `names: { "22": "Mac mini" }`, `localOwner`, `shown`
  localStorage.setItem("imd-agents:settings", JSON.stringify({ watching: scenario.watching, seats: scenario.seats ?? [], wallets: scenario.linked, relayOrigin: "https://api.imd.fun", names: scenario.names ?? {}, runtime: "claude", localToken: scenario.box === "no-docker" ? null : local, localOwner: scenario.localOwner ?? null, shown: scenario.shown ?? 0 }));
  // what the panel showed when it last closed: `seen: { today, accepted, usd }`
  if (scenario.seen) localStorage.setItem("imd-agents:seen", JSON.stringify(scenario.seen)); else localStorage.removeItem("imd-agents:seen");
  window.__fixtures = fixtures;
  // the job lands 2.5 s in, and the page reads again as R does
  if (scenario.lands) setTimeout(() => { window.__landed = true; window.dispatchEvent(new KeyboardEvent("keydown", { key: "r" })); }, 2500);
  const deviceKey = "d5e40d01".padEnd(64, "0");
  const answer = (path) => {
    if (path === `/workers/${deviceKey}/standing?queue=0`) return { status: 200, body: { enrollment: { status: "active", tokenId: local } } };
    const hit = window.__fixtures.api[path];
    if (!hit) return { status: 404, body: null };
    const body = structuredClone(hit.body);
    // two weeks' rows keep only their times: the newest hundred get theirs back, as the plane sends them
    if (path.includes("?work=500&") && body?.work) {
      const full = new Map((window.__fixtures.api[path.replace("work=500", "work=100")]?.body?.work ?? []).map((row) => [row.submittedAt, row]));
      body.work = body.work.map((row) => full.get(row.submittedAt) ?? row);
    }
    if (scenario.held && path === `/seats/${scenario.held}/standing?queue=0` && body?.standing) { body.standing.pausedByOwnerAt = new Date().toISOString(); body.standing.working = 0; body.standing.running = []; }
    // an agent on an older worker: `outdated: "22"`
    if (scenario.outdated && path === `/seats/${scenario.outdated}/standing?queue=0` && body?.presence) body.presence.daemonVersion = "0.1.0+aca0ff06";
    // agents whose read jail does not hold: `jailed: ["12"]`
    if (scenario.jailed && body?.presence && scenario.jailed.some((t) => path === `/seats/${t}/standing?queue=0`)) body.presence.jail = { ok: false, detail: scenario.jailDetail ?? "Claude's sandbox needs bwrap and socat: run sudo imd sandbox once (it installs bubblewrap and socat), or install them yourself" };
    // an agent at work: `working: { tokenId, nodeKey, objective, minutes }`
    const w = window.__working ?? scenario.working;
    if (w && path === `/seats/${w.tokenId}/standing?queue=0` && body?.standing) {
      body.standing.working = 1;
      body.standing.running = [{ jobId: "film-job", objective: w.objective, nodeKey: w.nodeKey, since: new Date(Date.now() - w.minutes * 60_000).toISOString() }];
    }
    // a job accepted a moment after opening: `lands: { tokenId: "22", by: 1 }`, counted once the page asks again
    if (window.__landed && path === `/seats/${scenario.lands.tokenId}?work=100&reviews=0&collaborators=0` && body) body.accepted = (body.accepted ?? 0) + (scenario.lands.by ?? 1);
    // without a box, a wallet has seats only when it is watched or linked: the welcome stays empty
    const asked = [...(scenario.watching ?? []), ...(scenario.linked ?? [])].map((w) => `/pair/wallet/${w}`);
    if (scenario.box !== "running" && scenario.box !== "stopped" && path.startsWith("/pair/wallet/") && !asked.includes(path)) return { status: 200, body: { tokens: [] } };
    return { status: hit.status, body };
  };
  const box = { state: scenario.box, installed: scenario.box !== "no-docker", device_key: scenario.box === "running" ? deviceKey : null };
  const handlers = {};
  window.__emit = (event, payload) => { const id = handlers[event]; if (id) window[`_${id}`]({ event, id: 1, payload }); };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "panel" }, currentWebview: { windowLabel: "panel", label: "panel" } },
    transformCallback: (cb) => { const id = Math.floor(Math.random() * 1e9); window[`_${id}`] = cb; return id; },
    invoke: async (cmd, args) => {
      // a step that fails as Docker would: `fail: { box_pull: "what Docker said" }`
      if (scenario.fail?.[cmd]) throw scenario.fail[cmd];
      // a slow first read, to see what the panel shows while it is out: `slow: 60000`
      if (scenario.slow && (cmd === "box_state" || cmd === "api_get")) await new Promise((done) => setTimeout(done, scenario.slow));
      switch (cmd) {
        case "api_get": return answer(args.path);
        case "agent_svg": return fixtures.svg[args.tokenId] ?? null;
        case "box_state": return box;
        case "link_start": return { code: "K7QM4XJ2", expiresAt: new Date(Date.now() + 600000).toISOString(), relayOrigin: "https://api.imd.fun" };
        case "link_poll": return { status: 200, body: { status: "pending", wallet: null } };
        case "plugin:autostart|is_enabled": return true;
        case "plugin:app|version": return "0.1.0";
        case "plugin:event|listen": handlers[args.event] = args.handler; return 1;
        case "seat_pause": return { status: 200, body: { paused: args.paused } };
        case "worker_releases": return { status: 200, body: window.__fixtures.releases ?? [] };
        // setting a box up: how far it has got (`setup` in the scenario), and steps that take their time
        case "box_setup_state": return scenario.setup ?? { docker: "running", image: true, worker: true, claude: true, device_key: deviceKey };
        case "docker_open": case "box_sign_in": case "open_pairing": return null;
        case "box_pull": case "box_install": return new Promise((done) => setTimeout(done, 60_000));
        case "box_pair":
          setTimeout(() => window.__emit("box-pairing", { code: "QX7M4KD2", url: "https://api.imd.fun/pair?code=QX7M4KD2" }), 300);
          return new Promise(() => {});
        case "explorer_get":
          // an ENS name: the explorer's search answers with the wallet, `ens: { "name.eth": "0x…" }`
          if (args.path.startsWith("/api/search?q=")) { const w = scenario.ens?.[args.path.slice(14)]; return { status: 200, body: { groups: w ? [{ key: "go", hits: [{ meta: "wallet", href: `/wallet/${w}` }] }] : [] } }; }
          return window.__fixtures.explorer?.[args.path] ?? { status: 404, body: null };
        case "update_check": return scenario.update ?? null;
        case "docker_install": return new Promise(() => {});
        case "update_install": return new Promise(() => {});
        default: return null;
      }
    },
  };
}
