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
  localStorage.setItem("imd-agents:settings", JSON.stringify({ watching: scenario.watching, seats: scenario.seats ?? [], wallets: scenario.linked, relayOrigin: "https://api.imd.fun", names: scenario.names ?? {}, runtime: "claude", localToken: scenario.box === "no-docker" || scenario.fresh ? null : local, localOwner: scenario.localOwner ?? null, shown: scenario.shown ?? 0, held: scenario.remembered ?? {} }));
  // where setup was told the seat came from, as `seat: "lend"`; unset, nothing a setup state left behind carries over
  if (scenario.seat) localStorage.setItem("imd-agents:seat", scenario.seat); else if (!scenario.setup) localStorage.removeItem("imd-agents:seat");
  // what the panel showed when it last closed: `seen: { today, accepted, usd }`
  if (scenario.seen) localStorage.setItem("imd-agents:seen", JSON.stringify(scenario.seen)); else localStorage.removeItem("imd-agents:seen");
  window.__fixtures = fixtures;
  // the job lands 2.5 s in, and the page reads again as R does
  if (scenario.lands) setTimeout(() => { window.__landed = true; window.dispatchEvent(new KeyboardEvent("keydown", { key: "r" })); }, 2500);
  const deviceKey = "d5e40d01".padEnd(64, "0");
  // a seat in an imdLend vault: `lending: { tokenId, vault, owner, operator, owner_bps, endsIn }`, endsIn in seconds, past its end when below 0;
  // `window.__withdrawn = true` puts it back in its owner's wallet
  const vaulted = () => (window.__withdrawn ? null : scenario.lending);
  const lending = scenario.lending;
  const answer = (path) => {
    // the seat's holder is its vault, and its lender's wallet no longer holds it
    if (vaulted() && path === `/seats/${lending.tokenId}?work=0&reviews=0&collaborators=0`) {
      const base = window.__fixtures.api[path]?.body ?? window.__fixtures.api[`/seats/${lending.tokenId}?work=100&reviews=0&collaborators=0`]?.body ?? {};
      return { status: 200, body: { ...structuredClone(base), owner: lending.vault, online: true } };
    }
    // the box's pairing, retired when its seat moved on: `unpaired: true`, or `window.__unpaired = true` once open
    if (path === `/workers/${deviceKey}/standing?queue=0`) return { status: 200, body: { enrollment: { status: scenario.unpaired || window.__unpaired ? "stale" : "active", tokenId: local } } };
    // the plane's one outside desk, as GET /github/desks listed it on 2026-11-25
    // `window.__desksDown = true`: the plane didn't answer for them
    if (path === "/github/desks" && window.__desksDown) return { status: 503, body: null };
    if (path === "/github/desks") return { status: 200, body: { desks: [{ name: "pequalnp", kind: "pequalnp-v1", repo: "open-goat/pequalnp-proofs", path: "lean/PEqualNP/Outside/L_<gap>.lean" }] } };
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
    // agents whose workers turn work away themselves, the network pausing nothing: `holding: ["12"]`; why, for this
    // computer's, is `hold`, the line its box's log ends its self-test on
    // every other agent takes work, whatever it was doing when the fixtures were read
    if (path.endsWith("/standing?queue=0") && body?.standing) {
      const holds = scenario.holding?.some((t) => path === `/seats/${t}/standing?queue=0`) ?? false;
      if (holds) {
        body.presence = { lastHeartbeatAt: new Date().toISOString(), runtimes: [{ id: "claude" }], ...body.presence, connected: true, stale: false, acceptingWork: false };
        Object.assign(body.standing, { working: 0, running: [], pausedUntil: null, pausedByOwnerAt: null });
      } else if (body.presence) body.presence.acceptingWork = true;
    }
    // an agent at work: `working: { tokenId, nodeKey, objective, minutes }`
    const w = window.__working ?? scenario.working;
    if (w && path === `/seats/${w.tokenId}/standing?queue=0` && body?.standing) {
      body.standing.working = 1;
      body.standing.running = [{ jobId: "film-job", objective: w.objective, nodeKey: w.nodeKey, since: new Date(Date.now() - w.minutes * 60_000).toISOString() }];
    }
    if (vaulted() && path === `/pair/wallet/${lending.owner}` && body?.tokens) body.tokens = body.tokens.filter((t) => t.tokenId !== lending.tokenId);
    // a job accepted a moment after opening: `lands: { tokenId: "22", by: 1 }`, counted once the page asks again
    if (window.__landed && path === `/seats/${scenario.lands.tokenId}?work=100&reviews=0&collaborators=0` && body) body.accepted = (body.accepted ?? 0) + (scenario.lands.by ?? 1);
    // without a box, a wallet has seats only when it is watched or linked: the welcome stays empty
    const asked = [...(scenario.watching ?? []), ...(scenario.linked ?? [])].map((w) => `/pair/wallet/${w}`);
    if (scenario.box !== "running" && scenario.box !== "stopped" && path.startsWith("/pair/wallet/") && !asked.includes(path)) return { status: 200, body: { tokens: [] } };
    return { status: hit.status, body };
  };
  // what the running box thinks with: Claude, unless the scenario says (`boxRuntime`)
  const box = { state: scenario.box, installed: scenario.box !== "no-docker", device_key: scenario.box === "running" ? deviceKey : null, runtime: scenario.box === "running" ? scenario.boxRuntime ?? "claude" : null };
  const handlers = {};
  /** Claude's sign-in under way, to end when a code is pasted or it's cancelled. */
  let signingIn = null;
  /** A jury join waiting for its signature, to end when it's cancelled. */
  let joining = null;
  /** This computer's RPC and jury seat: none and not joined, unless the scenario says (`rpc`, `jury`). */
  let rpc = scenario.rpc ?? { chains: [], goals: false };
  const jury = { able: true, boxed: true, joined: false, key: null, seat: null, said_secs: null, chains: [], link: null, ...scenario.jury };
  /** This computer's box's memory: off, its box at 6 GB, Docker given 16 GB, unless the scenario says (`memory`). */
  const GIB = 2 ** 30;
  let memory = { on: false, docker_bytes: Math.round(15.6 * GIB), box_bytes: 6 * GIB, ...scenario.memory };
  /** This computer's agent on GitHub: no line unless the scenario says (`github`), as for an Arm Mac's box today. An x64
   * box with gh, signed out and not linked, unless it says otherwise. */
  let github = scenario.github ? { arch: "x86_64", gh: true, signed_in: null, linked: null, repos: [], mode: null, network: [], denied: [], device: null, ...scenario.github } : null;
  /** A GitHub sign-in waiting for its code, to end when it's cancelled. */
  let signingGithub = null;
  /** What `imd github link` (worker 0.1.47) says before it asks, from its own linkNotice and desksNotice, for "octocat"
   * (src/github-link.fixture.txt, which the tests read). Here, as Playwright runs this function alone. */
  const githubSays = "This links this machine to the GitHub account octocat for outside proof desks: public proof efforts whose steps the\nnetwork works and submits as pull requests.\n\nWhat it means:\n  - The network takes a desk's steps under your handle, octocat, at most five at a time, and works them on this machine.\n  - It runs on this machine and uses your own Claude Code or Codex usage, as any task here does.\n  - The network may add the public contest repositories it runs, the ones listed below and any it runs later, each checked\n    here to be public. Each pull request is one proof file, under your GitHub name. imd github deny <owner/repo> blocks\n    one; imd github desks mine lets you choose them yourself (imd github allow <owner/repo>).\n\nWhat becomes public, for each proof this machine writes that passes its checks:\n  - a pull request opened by octocat on one of those public repositories, showing your handle and avatar, and a\n    fork of that repository in your account if you have none;\n  - one commit on it, authored and committed as octocat <583231+octocat@users.noreply.github.com>, GitHub's noreply address for you.\n\nTo prove the account is yours, a short-lived secret gist is made in it and deleted as soon as the network has read it.\n\nWhile linked, every task on this machine runs jailed, whatever it is: away from your home folder, where gh keeps your token\n(in plain text on a server, ~/.config/gh/hosts.yml), a task reads only its own workspace and the tools it runs. Where the jail\nstops holding, this machine takes no task until it holds again or you unlink (imd doctor says which).\n\nIt is opened by this worker through your own gh, which keeps your token; the worker never reads it, and no task is told your login.\nThe worker opens only a file one of its own tasks on this machine wrote, at a path the desk's kind allows, in a repository\nworked here. Nothing is ever opened under anyone else's account. imd github unlink stops it at any time.\nThe desks this plane works now, each allowed here only if you say yes to it:\n  - open-goat/pequalnp-proofs (desk pequalnp, kind pequalnp-v1): Lean 4 proofs against Mathlib, one file a step, held to pequalnp.com's contributing rules.\n    Each proof goes at lean/PEqualNP/Outside/L_<gap>.lean, <gap> being the step. Lean and Mathlib take about 10 GB of disk here, fetched once and kept.\n\n\nnot linked.\n";
  const githubNotice = (login) => githubSays.trimEnd().replace(/\nnot linked\.$/, "").replaceAll("octocat", login);
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
        case "box_hold": return scenario.hold ?? null;
        case "link_start": return { code: "K7QM4XJ2", expiresAt: new Date(Date.now() + 600000).toISOString(), relayOrigin: "https://api.imd.fun" };
        case "link_poll": return { status: 200, body: { status: "pending", wallet: null } };
        case "plugin:autostart|is_enabled": return true;
        case "plugin:app|version": return "0.1.0";
        case "plugin:event|listen": handlers[args.event] = args.handler; return 1;
        case "seat_pause": return { status: 200, body: { paused: args.paused } };
        case "worker_releases": return { status: 200, body: window.__fixtures.releases ?? [] };
        // setting a box up: how far it has got (`setup` in the scenario), and steps that take their time
        case "box_setup_state": return scenario.setup ?? { docker: "running", image: true, worker: true, claude: true, device_key: deviceKey };
        // a pairing code already out, setup's window closed on it: `pending: true`
        case "pairing_pending": return scenario.pending ? { code: "QX7M4KD2", url: "https://api.imd.fun/pair?code=QX7M4KD2" } : null;
        // taken off its seat: the box gone, its pairing revoked
        case "box_unlink": return new Promise((done) => setTimeout(() => { scenario.unpaired = true; box.state = "stopped"; done(); }, 1500));
        case "lend_owned": return scenario.lendOwned ?? [];
        case "lend_vault":
          return lending && args.holder.toLowerCase() === lending.vault ? { owner: lending.owner, operator: lending.operator, owner_bps: lending.owner_bps } : null;
        case "lend_span": {
          if (!lending || args.vault.toLowerCase() !== lending.vault || args.seat !== lending.tokenId) return null;
          const now = Math.floor(Date.now() / 1000);
          return { started_at: now - 7 * 86400 + lending.endsIn, ends_at: now + lending.endsIn };
        }
        case "docker_open": case "open_pairing": return null;
        // a box started with Docker closed waits on Docker
        case "box_start": return box.state === "docker-down" ? new Promise(() => {}) : null;
        // Claude's sign-in: its page opens a moment on, then it waits for the code pasted from it
        case "box_sign_in":
          setTimeout(() => window.__emit("box-signin-page", null), 300);
          return new Promise((done, failed) => { signingIn = { done, failed }; });
        // Codex's sign-in: OpenAI's page and its one-time code a moment on, then it waits for the code to be entered there
        case "box_sign_in_codex":
          setTimeout(() => window.__emit("box-signin-device", { url: "https://auth.openai.com/codex/device", code: "K7QD-3WMPX" }), 300);
          return new Promise((done, failed) => { signingIn = { done, failed }; });
        case "box_sign_in_code":
          setTimeout(() => { if (scenario.setup) scenario.setup = { ...scenario.setup, claude: true }; signingIn?.done(null); }, 1500);
          return null;
        case "box_sign_in_cancel": signingIn?.failed("Input ended before a code was pasted. Sign in again and paste the code shown."); return null;
        // setup's download takes its minute; the jury's Update counts a few megabytes, then is done
        case "box_pull":
          if (scenario.jury?.boxed === false) {
            setTimeout(() => window.__emit("setup-step-progress", { step: "pull", words: "Downloading 212 of 385 MB…" }), 300);
            return new Promise((done) => setTimeout(() => { jury.boxed = true; jury.able = true; done(); }, 3000));
          }
          return new Promise((done) => setTimeout(done, 60_000));
        case "box_install": return new Promise((done) => setTimeout(done, 60_000));
        case "box_restart": return null;
        case "box_pair":
          setTimeout(() => window.__emit("box-pairing", { code: "QX7M4KD2", url: "https://api.imd.fun/pair?code=QX7M4KD2" }), 300);
          return new Promise(() => {});
        case "explorer_get":
          // an ENS name: the explorer's search answers with the wallet, `ens: { "name.eth": "0x…" }`
          if (args.path.startsWith("/api/search?q=")) { const w = scenario.ens?.[args.path.slice(14)]; return { status: 200, body: { groups: w ? [{ key: "go", hits: [{ meta: "wallet", href: `/wallet/${w}` }] }] : [] } }; }
          return window.__fixtures.explorer?.[args.path] ?? { status: 404, body: null };
        case "update_check": return scenario.update ?? null;
        case "rpc_state": return rpc;
        // a key checked chain by chain in the box: `rpcSays` for what it comes to, all three by default
        case "rpc_setup": return new Promise((done) => setTimeout(() => {
          const said = scenario.rpcSays ?? { chains: [["Ethereum", "ok"], ["Base", "ok"], ["Robinhood Chain", "ok"]].map(([name, state]) => ({ name, state, said: "full history" })), refused: false };
          rpc = { chains: ["1", "8453", "4663"].filter((_, i) => said.chains[i]?.state !== "none"), goals: true };
          done(said);
        }, 1200));
        case "jury_state": return jury;
        // the key made, then its link, then a wait for the holder's signature that only Cancel ends
        case "jury_join":
          setTimeout(() => window.__emit("jury-link", { url: "https://explorer.imd.fun/jury/register/kr7Qx9aZ", until: Date.now() + 600_000, key: "0xb601720c7ca68fbbaace13b5384c3f91403e9f5a" }), 700);
          return new Promise((done, failed) => { joining = { done, failed }; });
        case "jury_cancel": window.__emit("jury-link", null); joining?.failed("stopped"); return null;
        case "jury_open": case "open_alchemy": return null;
        case "github_state": return github;
        // gh prints GitHub's page and a code, then waits for it to be entered there: only Cancel ends it here
        case "github_sign_in":
          setTimeout(() => window.__emit("github-device", { url: "https://github.com/login/device", code: "4F2A-9C1D" }), 700);
          return new Promise((done, failed) => { signingGithub = { done, failed }; });
        case "github_sign_in_cancel": window.__emit("github-device", null); signingGithub?.failed("stopped"); return null;
        case "github_open": return null;
        case "github_preview": return { login: github?.signed_in ?? "octocat", text: githubNotice(github?.signed_in ?? "octocat") };
        // worker 0.1.46: a link follows the network's desks, which it reads at once
        case "github_link": return new Promise((done) => setTimeout(() => { github = { ...github, linked: github.signed_in, repos: [], mode: "network", network: ["open-goat/pequalnp-proofs"] }; done(null); }, 1500));
        case "github_unlink": github = { ...github, linked: null, signed_in: null, repos: [], mode: null, network: [], denied: [] }; return null;
        case "github_jobs": return new Promise((done) => setTimeout(() => {
          github = args.on
            ? { ...github, mode: "network", network: ["open-goat/pequalnp-proofs"], denied: github.denied.filter((r) => !args.repos.includes(r)) }
            : { ...github, mode: "mine", network: [], repos: [], denied: [...github.denied, ...args.repos] };
          done(null);
        }, 600));
        case "memory_state": return memory;
        case "memory_set": memory = { ...memory, on: args.on }; return null;
        case "docker_install": return new Promise(() => {});
        case "update_install": return new Promise(() => {});
        default: return null;
      }
    },
  };
}
