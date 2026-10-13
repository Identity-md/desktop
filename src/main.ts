import "./style.css";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { disable as autostartOff, enable as autostartOn, isEnabled as autostartIsOn } from "@tauri-apps/plugin-autostart";
import * as api from "./api";
import { faceFor, loadFace } from "./masks";
import { amountWords, shortAgo, countToday, dotOf, localPhase, phaseOf, statusLine, trayState, type Agent, type Box, type Earning, type Phase } from "./model";

// ---------------------------------------------------------------------------------------------
// What the app remembers between runs: wallets, the network it signs for, names. Nothing secret:
// the key lives in the OS credential store, on the Rust side.
// ---------------------------------------------------------------------------------------------

type Settings = {
  /** Wallets that connected this computer: their agents get a switch. */
  wallets: string[];
  /** A wallet only watched: its agents show, without switches. */
  watch: string | null;
  /** The control plane's origin the link was made with, which every signed action names. */
  relayOrigin: string | null;
  names: Record<string, string>;
  /** What this computer's box runs on. */
  runtime: string;
  /** This computer's agent, once learned from the box: it stays this computer's while the box is off. */
  localToken: string | null;
};

const STORE = "imd-agents:settings";
const settings: Settings = Object.assign(
  { wallets: [], watch: null, relayOrigin: null, names: {}, runtime: "claude", localToken: null },
  (() => { try { return JSON.parse(localStorage.getItem(STORE) ?? "{}"); } catch { return {}; } })(),
);
const save = () => { try { localStorage.setItem(STORE, JSON.stringify(settings)); } catch { /* kept for this run */ } };

const state = {
  view: "home" as "home" | "settings",
  box: null as Box | null,
  /** This computer's own agent, found from the box's device key. */
  localToken: settings.localToken as string | null,
  /** The wallet that holds this computer's agent: watched without asking. */
  localOwner: null as string | null,
  agents: [] as Agent[],
  rewards: [] as Array<Earning & { wallet: string }>,
  linking: null as { code: string; until: number } | null,
  note: null as { text: string; bad: boolean } | null,
  sending: new Set<string>(),
  openAtLogin: false,
  loaded: false,
};

const watched = () => [...new Set([...settings.wallets, settings.watch, state.localOwner].filter((w): w is string => Boolean(w)))];
const linked = (wallet: string | undefined) => Boolean(wallet && settings.wallets.includes(wallet));
const nameOf = (tokenId: string) => settings.names[tokenId] || (tokenId === state.localToken ? "This computer" : `Agent ${tokenId}`);
const short = (wallet: string) => `${wallet.slice(0, 6)}…${wallet.slice(-4)}`;
const esc = (text: unknown) => String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

// ---------------------------------------------------------------------------------------------
// Reading: the box from Docker, everything else from the public API. Quick while the panel is
// open, slow while it is not, so the menu bar icon stays true without costing anything.
// ---------------------------------------------------------------------------------------------

let records = new Map<string, { today: number; accepted: number }>();
let lastRecords = 0;
let lastRewards = 0;
let reading = false;

async function refresh(full = false): Promise<void> {
  if (reading) return;
  reading = true;
  try {
    const box = await api.boxState().catch(() => null);
    if (box && !(state.box?.state === "starting" || state.box?.state === "stopping") ) state.box = box;
    if (box?.deviceKey) {
      const token = await api.deviceSeat(box.deviceKey);
      if (token && token !== state.localToken) { state.localToken = token; settings.localToken = token; save(); }
    }
    // Without a box there is no computer's own agent to show apart.
    if (box && !box.installed) state.localToken = null;
    if (state.localToken && !state.localOwner) state.localOwner = (await api.seatRecord(state.localToken))?.owner?.toLowerCase() ?? null;

    const seats: Array<{ tokenId: string; wallet: string; online: boolean }> = [];
    for (const wallet of watched()) {
      for (const seat of await api.walletSeats(wallet)) {
        if (!seats.some((s) => s.tokenId === seat.tokenId)) seats.push({ tokenId: seat.tokenId, wallet, online: seat.device?.online ?? false });
      }
    }
    if (state.localToken && !seats.some((s) => s.tokenId === state.localToken)) {
      seats.unshift({ tokenId: state.localToken, wallet: state.localOwner ?? "", online: state.box?.state === "running" });
    }
    const standings = await Promise.all(seats.map((seat) => api.seatStanding(seat.tokenId)));
    if (full || Date.now() - lastRecords > 60_000) {
      lastRecords = Date.now();
      const read = await Promise.all(seats.map((seat) => api.seatRecord(seat.tokenId)));
      records = new Map(seats.flatMap((seat, i) => (read[i] ? [[seat.tokenId, { today: countToday(read[i]!.work ?? []), accepted: read[i]!.accepted ?? 0 }] as const] : [])));
    }
    state.agents = seats
      .map((seat, i) => ({ ...seat, standing: standings[i] ?? null, today: records.get(seat.tokenId)?.today ?? null, accepted: records.get(seat.tokenId)?.accepted ?? null }))
      .sort((a, b) => (a.tokenId === state.localToken ? -1 : b.tokenId === state.localToken ? 1 : Number(a.tokenId) - Number(b.tokenId)));

    if (full || Date.now() - lastRewards > 120_000) {
      lastRewards = Date.now();
      const all = await Promise.all(watched().map(async (wallet) => (await api.earnings(wallet)).map((e) => ({ ...e, wallet }))));
      state.rewards = all.flat().sort((a, b) => b.at.localeCompare(a.at));
    }
    state.loaded = true;
    for (const agent of state.agents) void loadFace(agent.tokenId, render);
  } finally {
    reading = false;
  }
  render();
}

// ---------------------------------------------------------------------------------------------
// Acting.
// ---------------------------------------------------------------------------------------------

function phaseFor(agent: Agent): Phase {
  if (agent.tokenId === state.localToken && state.box) return localPhase(state.box, agent);
  return phaseOf(agent);
}

/** A switch: this computer's box on and off, or another agent paused and resumed by its wallet. */
async function toggle(agent: Agent): Promise<void> {
  if (state.sending.has(agent.tokenId)) return;
  state.note = null;
  if (agent.tokenId === state.localToken && state.box?.installed) {
    const on = state.box.state === "running";
    state.box = { ...state.box, state: on ? "stopping" : "starting" };
    render();
    try {
      if (on) await api.boxStop(); else await api.boxStart(settings.runtime);
    } catch (error) {
      state.note = { text: String(error), bad: true };
    }
    state.box = await api.boxState();
    if (!on) state.localToken = state.localToken ?? null;
    await refresh();
    return;
  }
  if (!linked(agent.wallet) || !settings.relayOrigin) return;
  const pausing = !agent.standing?.standing.pausedByOwnerAt;
  state.sending.add(agent.tokenId);
  // shown at once, put back if the network says no
  if (agent.standing) agent.standing.standing.pausedByOwnerAt = pausing ? new Date().toISOString() : null;
  render();
  const answer = await api.seatPause(agent.tokenId, pausing, settings.relayOrigin);
  state.sending.delete(agent.tokenId);
  if (answer.status !== 200) {
    if (agent.standing) agent.standing.standing.pausedByOwnerAt = pausing ? null : new Date().toISOString();
    const error = answer.body?.error;
    if (error === "app_not_linked") {
      settings.wallets = [];
      save();
      state.note = { text: "This computer was disconnected. Connect again to switch agents.", bad: true };
    } else {
      state.note = {
        text: error === "not_token_owner" ? `That wallet no longer holds ${nameOf(agent.tokenId)}.`
          : error === "issued_in_future" ? "This computer's clock is ahead. Set it automatically and try again."
          : answer.status === 0 ? "The network did not answer." : `Could not switch ${nameOf(agent.tokenId)} (${answer.status}).`,
        bad: true,
      };
    }
  }
  render();
}

/** Connecting: a code, the approval page in the browser, and this panel watching the code. */
async function connect(): Promise<void> {
  if (state.linking) return void api.linkReopen(state.linking.code);
  state.note = null;
  try {
    const start = await api.linkStart();
    settings.relayOrigin = start.relayOrigin;
    save();
    state.linking = { code: start.code, until: Date.now() + 10 * 60_000 };
    render();
    while (state.linking && Date.now() < state.linking.until) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const answer = await api.linkPoll(start.code);
      if (answer.body?.status === "linked" && answer.body.wallet) {
        const wallet = answer.body.wallet.toLowerCase();
        if (!settings.wallets.includes(wallet)) settings.wallets.push(wallet);
        save();
        state.linking = null;
        state.note = { text: `Connected to ${short(wallet)}.`, bad: false };
        await refresh(true);
        return;
      }
      if (answer.body?.status === "expired") break;
    }
    if (state.linking) state.note = { text: "The code expired before it was approved.", bad: true };
  } catch (error) {
    state.note = { text: String(error), bad: true };
  }
  state.linking = null;
  render();
}

async function disconnect(): Promise<void> {
  try {
    await api.unlink(settings.relayOrigin ?? "https://api.imd.fun");
    settings.wallets = [];
    save();
    state.note = { text: "Disconnected. This computer's key is gone.", bad: false };
  } catch (error) {
    state.note = { text: String(error), bad: true };
  }
  render();
}

// ---------------------------------------------------------------------------------------------
// Drawing.
// ---------------------------------------------------------------------------------------------

const app = document.querySelector<HTMLDivElement>("#app")!;

function maskHtml(agent: Agent, phase: Phase): string {
  const face = faceFor(agent.tokenId);
  const dot = dotOf(phase);
  const away = phase.kind === "offline" || phase.kind === "off" || phase.kind === "docker-down";
  return `<span class="mask${away ? " away" : ""}">${face ? `<img src="${esc(face)}" alt="" draggable="false">` : `<span class="mask-blank"></span>`}<span class="dot ${dot}${phase.kind === "working" ? " live" : ""}"></span></span>`;
}

function switchHtml(agent: Agent, phase: Phase, index: number): string {
  const local = agent.tokenId === state.localToken && state.box?.installed;
  const canSwitch = local || linked(agent.wallet);
  if (!canSwitch) return `<span class="chevron" aria-hidden="true">›</span>`;
  const on = local ? state.box?.state === "running" || state.box?.state === "starting" : !agent.standing?.standing.pausedByOwnerAt;
  const busy = state.sending.has(agent.tokenId) || phase.kind === "changing";
  const label = local ? (on ? "Turn off this computer's agent" : "Turn on this computer's agent") : on ? `Pause ${nameOf(agent.tokenId)}` : `Resume ${nameOf(agent.tokenId)}`;
  return `<button class="switch${on ? " on" : ""}" role="switch" aria-checked="${on}" data-switch="${esc(agent.tokenId)}" ${busy ? "disabled" : ""} title="${esc(label)}${index < 9 ? ` (${index + 1})` : ""}"><span></span></button>`;
}

function agentsHtml(): string {
  if (!state.agents.length) {
    return state.loaded ? "" : `<div class="rows"><div class="row skeleton"><span class="mask"><span class="mask-blank"></span></span><span class="lines"><span class="bar"></span><span class="bar short"></span></span></div></div>`;
  }
  return `<div class="rows">${state.agents.map((agent, i) => {
    const phase = phaseFor(agent);
    const job = phase.kind === "working" ? agent.standing?.standing.running[0]?.objective : null;
    return `<div class="row" data-agent="${esc(agent.tokenId)}" tabindex="0" title="Open ${esc(nameOf(agent.tokenId))} on the explorer">
      ${maskHtml(agent, phase)}
      <span class="lines">
        <span class="name">${esc(nameOf(agent.tokenId))}</span>
        <span class="status">${esc(state.sending.has(agent.tokenId) ? (agent.standing?.standing.pausedByOwnerAt ? "Pausing…" : "Resuming…") : statusLine(phase, agent))}</span>
        ${job ? `<span class="job">${esc(job)}</span>` : ""}
      </span>
      ${switchHtml(agent, phase, i)}
    </div>`;
  }).join("")}</div>`;
}

function numbersHtml(): string {
  const known = state.agents.filter((a) => a.accepted !== null);
  if (!known.length) return "";
  const today = known.reduce((n, a) => n + (a.today ?? 0), 0);
  const accepted = known.reduce((n, a) => n + (a.accepted ?? 0), 0);
  return `<div class="numbers"><div><b>${today.toLocaleString()}</b><span>Today</span></div><div><b>${accepted.toLocaleString()}</b><span>Accepted</span></div></div>`;
}

function rewardsHtml(): string {
  if (!state.rewards.length) return "";
  const wallet = state.rewards[0]!.wallet;
  const shown = state.rewards.slice(0, 4);
  return `<section class="rewards">
    <div class="head"><span>Rewards</span><button class="claim" data-claim="${esc(wallet)}" title="Claim on the explorer, with your wallet">Claim</button></div>
    ${shown.map((r) => {
      const logo = r.launch?.logo ? `https://api.imd.fun/artifacts/${encodeURIComponent(r.launch.logo)}` : null;
      return `<button class="reward" data-token="${esc(r.token.address)}" title="${esc(r.token.name)}">
        <span class="logo">${logo ? `<img src="${esc(logo)}" alt="" draggable="false">` : esc(r.token.symbol.slice(0, 1))}</span>
        <span class="symbol">${esc(r.token.symbol)}</span>
        <span class="amount">${esc(amountWords(r.amount, r.token.decimals))}</span>
        <span class="when">${esc(shortAgo(new Date(r.at)))}</span>
      </button>`;
    }).join("")}
    ${state.rewards.length > shown.length ? `<button class="more" data-claim="${esc(wallet)}">${state.rewards.length - shown.length} more</button>` : ""}
  </section>`;
}

function footerHtml(): string {
  if (state.linking) {
    const code = state.linking.code;
    return `<section class="linking">
      <div class="linking-head"><span class="spinner"></span>Approve in your browser</div>
      <div class="code">${esc(code.slice(0, 4))} ${esc(code.slice(4))}</div>
      <div class="actions"><button class="ghost" data-action="cancel">Cancel</button><button class="primary" data-action="reopen">Open page</button></div>
    </section>`;
  }
  const unswitchable = state.agents.some((a) => !(a.tokenId === state.localToken && state.box?.installed) && !linked(a.wallet));
  if (!watched().length && !state.box?.installed) {
    return `<section class="welcome">
      <div class="welcome-title">See your agents</div>
      <p>Connect the wallet that holds your IMD agents. You approve it once in your browser; this computer can then pause and resume them.</p>
      <button class="primary wide" data-action="connect">Connect wallet</button>
    </section>`;
  }
  return unswitchable ? `<button class="connect" data-action="connect" title="Connect (C)">Connect wallet to switch agents</button>` : "";
}

function homeHtml(): string {
  const working = state.agents.filter((a) => phaseFor(a).kind === "working").length;
  const summary = state.agents.length
    ? [`${state.agents.length} agent${state.agents.length === 1 ? "" : "s"}`, working ? `${working} working` : null].filter(Boolean).join(" · ")
    : state.loaded ? "No agents yet" : "Reading…";
  return `<header>
      <div><div class="title">IMD Agents</div><div class="summary">${esc(summary)}</div></div>
      <button class="icon" data-action="settings" title="Settings (,)" aria-label="Settings">${GEAR}</button>
    </header>
    ${agentsHtml()}
    ${numbersHtml()}
    ${rewardsHtml()}
    ${footerHtml()}
    ${state.note ? `<div class="note${state.note.bad ? " bad" : ""}" role="status">${esc(state.note.text)}</div>` : ""}`;
}

function settingsHtml(): string {
  return `<header>
      <button class="back" data-action="home" title="Back (Esc)">‹ Back</button>
      <div class="title">Settings</div>
      <span></span>
    </header>
    <section class="group">
      <div class="label">Wallets</div>
      ${settings.wallets.map((w) => `<div class="item"><span>${esc(short(w))}</span><span class="muted">Can pause and resume</span></div>`).join("")}
      ${state.localOwner && !settings.wallets.includes(state.localOwner) ? `<div class="item"><span>${esc(short(state.localOwner))}</span><span class="muted">This computer's agent</span></div>` : ""}
      <label class="item field"><span>Watch</span><input data-field="watch" placeholder="0x…" spellcheck="false" value="${esc(settings.watch ?? "")}"></label>
      <div class="item actions">
        <button class="ghost" data-action="connect">${state.linking ? "Waiting for approval…" : "Connect wallet"}</button>
        ${settings.wallets.length ? `<button class="ghost danger" data-action="disconnect">Disconnect</button>` : ""}
      </div>
      <p class="hint">A connected wallet lets this computer pause and resume the agents it holds, with a key kept in this computer's keychain. It does not expire; disconnect any time. A watched wallet only shows its agents.</p>
    </section>
    ${state.agents.length ? `<section class="group">
      <div class="label">Names</div>
      ${state.agents.map((a) => `<label class="item field"><span class="muted">Agent ${esc(a.tokenId)}</span><input data-name="${esc(a.tokenId)}" placeholder="${esc(a.tokenId === state.localToken ? "This computer" : `Agent ${a.tokenId}`)}" value="${esc(settings.names[a.tokenId] ?? "")}"></label>`).join("")}
    </section>` : ""}
    <section class="group">
      <label class="item"><span>Open at login</span><button class="switch${state.openAtLogin ? " on" : ""}" role="switch" aria-checked="${state.openAtLogin}" data-action="login"><span></span></button></label>
      <div class="item"><span>Quit IMD Agents</span><button class="ghost" data-action="quit">Quit</button></div>
    </section>`;
}

const GEAR = `<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M11.3 1.7l.4 2a6.3 6.3 0 0 1 1.6.9l1.9-.7 1.3 2.2-1.5 1.4a6.4 6.4 0 0 1 0 1.9l1.5 1.4-1.3 2.2-1.9-.7a6.3 6.3 0 0 1-1.6.9l-.4 2H8.7l-.4-2a6.3 6.3 0 0 1-1.6-.9l-1.9.7-1.3-2.2L5 9.4a6.4 6.4 0 0 1 0-1.9L3.5 6.1l1.3-2.2 1.9.7a6.3 6.3 0 0 1 1.6-.9l.4-2zM10 7a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"/></svg>`;

let lastHeight = 0;
let lastTray = "";
function render(): void {
  app.innerHTML = state.view === "settings" ? settingsHtml() : homeHtml();
  const tray = trayState(state.agents.map(phaseFor));
  if (tray !== lastTray) {
    lastTray = tray;
    void api.setTrayState(tray).catch(() => undefined);
  }
  // the window is as tall as what it shows
  const height = Math.min(Math.ceil(app.getBoundingClientRect().height), 720);
  if (height !== lastHeight) {
    lastHeight = height;
    void getCurrentWindow().setSize(new LogicalSize(360, height)).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------------------------
// Input: every action has a key.
// ---------------------------------------------------------------------------------------------

app.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  const switchEl = target.closest<HTMLElement>("[data-switch]");
  if (switchEl) {
    event.stopPropagation();
    const agent = state.agents.find((a) => a.tokenId === switchEl.dataset.switch);
    if (agent) void toggle(agent);
    return;
  }
  const action = target.closest<HTMLElement>("[data-action]")?.dataset.action;
  if (action === "settings") { state.view = "settings"; void autostartIsOn().then((on) => { state.openAtLogin = on; render(); }).catch(() => undefined); return render(); }
  if (action === "home") { state.view = "home"; return render(); }
  if (action === "connect") return void connect();
  if (action === "reopen" && state.linking) return void api.linkReopen(state.linking.code);
  if (action === "cancel") { state.linking = null; return render(); }
  if (action === "disconnect") return void disconnect();
  if (action === "quit") return void api.quit();
  if (action === "login") {
    const next = !state.openAtLogin;
    void (next ? autostartOn() : autostartOff()).then(() => { state.openAtLogin = next; render(); }).catch((e) => { state.note = { text: String(e), bad: true }; render(); });
    return;
  }
  const claim = target.closest<HTMLElement>("[data-claim]")?.dataset.claim;
  if (claim) return void api.openExplorer(`/wallet/${claim}/earned`);
  const token = target.closest<HTMLElement>("[data-token]")?.dataset.token;
  if (token) return void api.openExplorer(`/token/${token}`);
  const agent = target.closest<HTMLElement>("[data-agent]")?.dataset.agent;
  if (agent) return void api.openExplorer(`/agents/${agent}`);
});

app.addEventListener("change", (event) => {
  const input = event.target as HTMLInputElement;
  if (input.dataset.field === "watch") {
    const value = input.value.trim().toLowerCase();
    settings.watch = /^0x[0-9a-f]{40}$/.test(value) ? value : null;
    save();
    void refresh(true);
  }
  if (input.dataset.name) {
    settings.names[input.dataset.name] = input.value.trim().slice(0, 40);
    save();
  }
});

window.addEventListener("keydown", (event) => {
  if ((event.target as HTMLElement).tagName === "INPUT") {
    if (event.key === "Escape") (event.target as HTMLElement).blur();
    return;
  }
  if (event.key === "Escape") {
    if (state.view === "settings") { state.view = "home"; render(); } else void api.hidePanel();
    return;
  }
  if (event.metaKey || event.ctrlKey) {
    if (event.key === "q") void api.quit();
    if (event.key === ",") { state.view = "settings"; render(); }
    return;
  }
  if (event.key === ",") { state.view = state.view === "settings" ? "home" : "settings"; return render(); }
  if (event.key === "c") return void connect();
  if (event.key === "r") return void refresh(true);
  if (event.key === "Enter") {
    const row = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("[data-agent]");
    if (row?.dataset.agent) void api.openExplorer(`/agents/${row.dataset.agent}`);
    return;
  }
  const number = Number(event.key);
  if (state.view === "home" && number >= 1 && number <= 9) {
    const agent = state.agents[number - 1];
    if (agent) void toggle(agent);
  }
});

// The panel hides when it loses focus, as a menu does, and reads again whenever it opens.
window.addEventListener("blur", () => { if (!state.linking) void api.hidePanel(); });
window.addEventListener("focus", () => void refresh());

render();
void refresh(true);
// every 8 seconds while the panel is open, every minute while it is not: the icon stays true either way
const tick = () => { void refresh(); setTimeout(tick, document.hasFocus() ? 8_000 : 60_000); };
setTimeout(tick, 8_000);
