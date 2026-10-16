import "./style.css";
import { listen } from "@tauri-apps/api/event";
import { disable as autostartOff, enable as autostartOn, isEnabled as autostartIsOn } from "@tauri-apps/plugin-autostart";
import morphdom from "morphdom";
import * as api from "./api";
import { faceFor, loadFace } from "./masks";
import { acceptedPerDay, acceptedToday, addDays, amountWords, behindWords, currentWorker, dayStart, dotOf, elapsed, failureWords, jailWords, judgedRate, localPhase, modelName, newerRelease, phaseOf, runLength, shortAgo, statusLine, stepTitle, trayState, upSince, usdText, type Agent, type Box, type Earning, type Phase, type WorkRow } from "./model";

// ---------------------------------------------------------------------------------------------
// What the app remembers between runs: wallets, the network it signs for, names. Nothing secret:
// the key lives in the OS credential store, on the Rust side.
// ---------------------------------------------------------------------------------------------

type Settings = {
  /** Wallets whose agents show, added by address. Watching needs no signature. */
  watching: string[];
  /** Wallets that let this computer pause and resume their agents, approved once in the browser. */
  wallets: string[];
  /** The control plane's origin the link was made with, which every signed action names. */
  relayOrigin: string | null;
  names: Record<string, string>;
  /** What this computer's box runs on. */
  runtime: string;
  /** This computer's agent, once learned from the box: it stays this computer's while the box is off. */
  localToken: string | null;
};

const STORE = "imd-agents:settings";
const stored = (() => { try { return JSON.parse(localStorage.getItem(STORE) ?? "{}"); } catch { return {}; } })();
const settings: Settings = Object.assign({ watching: [], wallets: [], relayOrigin: null, names: {}, runtime: "claude", localToken: null }, stored);
// Watching used to take one wallet.
if (typeof stored.watch === "string" && !settings.watching.includes(stored.watch)) settings.watching.push(stored.watch);
delete (settings as { watch?: unknown }).watch;
const save = () => { try { localStorage.setItem(STORE, JSON.stringify(settings)); } catch { /* kept for this run */ } };

const state = {
  view: "home" as "home" | "settings" | "setup",
  /** Where Back goes from setting a box up: the view it was opened from. */
  setupFrom: "home" as "home" | "settings",
  /** Setting this computer's box up: how far it has got, the step under way, and what went wrong. */
  setup: {
    at: null as api.Setup | null,
    /** The agent the box is paired to, as the network has it. */
    token: null as string | null,
    busy: null as null | "docker" | "pull" | "install" | "signin" | "pair" | "start",
    pairing: null as { code: string; url: string } | null,
    /** The page to register the agent at, when its token is not an ERC-8004 agent yet. */
    register: null as string | null,
    error: null as string | null,
  },
  box: null as Box | null,
  /** This computer's own agent, found from the box's device key. */
  localToken: settings.localToken as string | null,
  /** The wallet that holds this computer's agent: watched without asking. */
  localOwner: null as string | null,
  agents: [] as Agent[],
  /** How many agents each watched wallet holds. */
  holdings: new Map<string, number>(),
  rewards: [] as Array<Earning & { wallet: string }>,
  swarm: null as { online: number; working: number; events: api.SwarmEvent[] } | null,
  /** Whether the rewards tray is open. */
  rewardsOpen: false,
  /** The day under the pointer on the chart, whose count the first number shows while it is there. */
  scrub: null as number | null,
  /** The worker's current release and every version that does not count as behind. */
  release: null as { newest: string; accepted: string[]; order: string[] } | null,
  /** This computer's agent is to restart as soon as its job is done. */
  restartWhenIdle: false,
  /** The agent whose tray is open, showing what it is doing and has done. */
  openAgent: null as string | null,
  /** What each wallet has ready to claim, and its worth in dollars once every reward has a price. */
  worth: new Map<string, { count: number; usd: number | null }>(),
  linking: null as { code: string; until: number } | null,
  note: null as { text: string; bad: boolean } | null,
  sending: new Set<string>(),
  openAtLogin: false,
  loaded: false,
};

const watched = () => [...new Set([...settings.watching, ...settings.wallets, state.localOwner].filter((w): w is string => Boolean(w)))];
const linked = (wallet: string | undefined) => Boolean(wallet && settings.wallets.includes(wallet));
/** What its holder has called an agent in Settings, if anything: the name of a VPS, of a Mac mini. */
const labelOf = (tokenId: string) => settings.names[tokenId]?.trim() ?? "";
/** An agent in a sentence: its name and number, or "Agent #12". */
const nameOf = (tokenId: string) => (labelOf(tokenId) ? `${labelOf(tokenId)} (#${tokenId})` : `Agent #${tokenId}`);
const short = (wallet: string) => `${wallet.slice(0, 6)}…${wallet.slice(-4)}`;
const esc = (text: unknown) => String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

// ---------------------------------------------------------------------------------------------
// Reading: the box from Docker, everything else from the public API. Quick while the panel is
// open, slow while it is not, so the menu bar icon stays true without costing anything.
// ---------------------------------------------------------------------------------------------

/** The sparkline's reach, and the rows read to cover it: five hundred is two weeks of the busiest agent. */
const DAYS = 14;
const HISTORY_ROWS = 500;

/** Each agent's record: today's and all its accepted work, how it is judged, its model, its newest work. */
type AgentRecord = { today: number; accepted: number; rejected: number; failed: number; model: string | null; recent: WorkRow[] };
let records = new Map<string, AgentRecord>();
const history = new Map<string, { rows: WorkRow[]; capped: boolean }>();
let lastRecords = 0;
let lastHistory = 0;
let lastRewards = 0;
let lastSwarm = 0;
let lastRelease = 0;
let reading = false;
/** This app's own version, under Quit in Settings. It updates itself, so this says which it is on. */
let appVersion = "";
/** What each agent had accepted at the last read, and what it has accepted since, to fly in. */
const lastAccepted = new Map<string, number>();
const gains: Array<{ tokenId: string; by: number }> = [];
/** The plane holds each anonymous reader to 120 reads a minute; told to slow down, the panel waits a minute. */
let coolUntil = 0;

async function refresh(full = false): Promise<void> {
  if (reading || Date.now() < coolUntil) return;
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
    if (state.localToken && !state.localOwner) state.localOwner = (await api.seatRecord(state.localToken, 0))?.owner?.toLowerCase() ?? null;

    const seats: Array<{ tokenId: string; wallet: string; online: boolean }> = [];
    for (const wallet of watched()) {
      for (const seat of await api.walletSeats(wallet)) {
        if (!seats.some((s) => s.tokenId === seat.tokenId)) seats.push({ tokenId: seat.tokenId, wallet, online: seat.device?.online ?? false });
      }
    }
    if (state.localToken && !seats.some((s) => s.tokenId === state.localToken)) {
      seats.unshift({ tokenId: state.localToken, wallet: state.localOwner ?? "", online: state.box?.state === "running" });
    }
    state.holdings = new Map(watched().map((wallet) => [wallet, seats.filter((s) => s.wallet === wallet).length]));
    // A read that fails keeps the last good one: a busy plane is not an agent gone offline.
    const before = new Map(state.agents.map((agent) => [agent.tokenId, agent.standing]));
    const reads = await Promise.all(seats.map((seat) => api.get<Agent["standing"]>(`/seats/${seat.tokenId}/standing?queue=0`)));
    if (reads.some((read) => read.status === 429)) coolUntil = Date.now() + 60_000;
    const standings = reads.map((read, i) => (read.status === 200 ? read.body : before.get(seats[i]!.tokenId) ?? null));
    if (full || Date.now() - lastRecords > 60_000) {
      lastRecords = Date.now();
      const read = await Promise.all(seats.map((seat) => api.seatRecord(seat.tokenId)));
      records = new Map(seats.flatMap((seat, i) => {
        const record = read[i];
        if (!record) return records.has(seat.tokenId) ? [[seat.tokenId, records.get(seat.tokenId)!] as const] : [];
        const premium = record.runtimes?.[0]?.premiumModel;
        return [[seat.tokenId, {
          today: acceptedToday(record.work ?? []),
          accepted: record.accepted ?? 0,
          rejected: record.rejected ?? 0,
          failed: record.failed ?? 0,
          model: premium ? [modelName(premium.model), premium.effort].filter(Boolean).join(" ") : null,
          recent: (record.work ?? []).slice(0, 3),
        }] as const];
      }));
    }
    // two weeks of work per agent, for the sparkline: the past does not change, so every ten minutes
    if (full || Date.now() - lastHistory > 10 * 60_000) {
      lastHistory = Date.now();
      const read = await Promise.all(seats.map((seat) => api.seatRecord(seat.tokenId, HISTORY_ROWS)));
      seats.forEach((seat, i) => {
        const work = read[i]?.work;
        if (work) history.set(seat.tokenId, { rows: work.map((row) => ({ submittedAt: row.submittedAt, acceptedAt: row.acceptedAt })), capped: work.length >= HISTORY_ROWS });
      });
    }
    state.agents = seats
      .map((seat, i) => ({ ...seat, standing: standings[i] ?? null, today: records.get(seat.tokenId)?.today ?? null, accepted: records.get(seat.tokenId)?.accepted ?? null }))
      .sort((a, b) => (a.tokenId === state.localToken ? -1 : b.tokenId === state.localToken ? 1 : Number(a.tokenId) - Number(b.tokenId)));

    if (full || Date.now() - lastRewards > 120_000) {
      lastRewards = Date.now();
      const all = await Promise.all(watched().map(async (wallet) => (await api.earnings(wallet)).map((e) => ({ ...e, wallet }))));
      state.rewards = all.flat().sort((a, b) => b.at.localeCompare(a.at));
      // what is ready to claim is the explorer's to say: it reads the launch chains, the plane does not
      const rewarded = [...new Set(state.rewards.map((r) => r.wallet))];
      const ready = await Promise.all(rewarded.map((wallet) => api.readyToClaim(wallet, state.rewards.filter((r) => r.wallet === wallet)).catch(() => null)));
      rewarded.forEach((wallet, i) => { if (ready[i]) state.worth.set(wallet, ready[i]!); });
    }
    // the worker's releases, to know an agent left behind: every half hour, well inside GitHub's limit
    if (Date.now() - lastRelease > 30 * 60_000) {
      lastRelease = Date.now();
      const answer = await api.workerReleases().catch(() => null);
      if (answer?.status === 200 && Array.isArray(answer.body)) state.release = currentWorker(answer.body) ?? state.release;
    }
    // the whole swarm, while someone is looking
    if (full || (document.hasFocus() && Date.now() - lastSwarm > 45_000)) {
      lastSwarm = Date.now();
      state.swarm = (await api.swarm()) ?? state.swarm;
    }
    state.loaded = true;
    for (const agent of state.agents) void loadFace(agent.tokenId, render);
    // work accepted since the last read, by whom: drawn flying in once the numbers are
    for (const [tokenId, record] of records) {
      const before = lastAccepted.get(tokenId);
      if (before !== undefined && record.accepted > before) gains.push({ tokenId, by: record.accepted - before });
      lastAccepted.set(tokenId, record.accepted);
    }
  } finally {
    reading = false;
  }
  render();
  const local = state.agents.find((a) => a.tokenId === state.localToken);
  if (state.restartWhenIdle && local && phaseFor(local).kind !== "working") void restartLocal();
  const landed = gains.splice(0);
  if (!document.hidden && !closing && state.view === "home") landed.forEach((gain, i) => setTimeout(() => fly(gain.tokenId, gain.by), i * 260));
}

/** Every agent's accepted work per day, the last two weeks, today's as fresh as the minute. */
function workDays(): Array<number | null> {
  const now = new Date();
  return addDays(state.agents.map((agent) => {
    const known = history.get(agent.tokenId);
    if (!known) return new Array(DAYS).fill(null);
    const days = acceptedPerDay(known.rows, DAYS, now, known.capped ? HISTORY_ROWS : Infinity);
    if (agent.today !== null) days[DAYS - 1] = agent.today;
    return days;
  }), DAYS);
}

// ---------------------------------------------------------------------------------------------
// Acting.
// ---------------------------------------------------------------------------------------------

/**
 * Whether an agent runs a worker behind the current release, past the grace a new one gets. One newer
 * than the release list knows is not: the list is read every half hour, and in the minutes after a
 * release the machines that already took it are ahead of it.
 */
function outdated(agent: Agent): boolean {
  const version = agent.standing?.presence?.daemonVersion;
  if (!version || !state.release || newerRelease(version, state.release.newest)) return false;
  return !state.release.accepted.includes(version);
}

/**
 * Restarts this computer's agent, which is also how it takes the newest worker. Working, it waits for
 * the job to finish, so nothing it is doing is thrown away.
 */
async function restartLocal(): Promise<void> {
  const agent = state.agents.find((a) => a.tokenId === state.localToken);
  if (!agent || !state.box?.installed || state.box.state !== "running") return;
  if (phaseFor(agent).kind === "working") {
    state.restartWhenIdle = true;
    return render();
  }
  state.restartWhenIdle = false;
  state.box = { ...state.box, state: "starting" };
  render();
  try {
    await api.boxRestart();
  } catch (error) {
    state.note = { text: String(error), bad: true };
  }
  state.box = await api.boxState().catch(() => state.box);
  await refresh(true);
}

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
      state.note = { text: "This computer can no longer pause and resume. Allow it again in Settings.", bad: true };
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

/** Watching a wallet: its address, nothing signed. */
function watch(value: string): void {
  const wallet = value.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(wallet)) {
    state.note = { text: "A wallet address starts with 0x and has 40 more letters and numbers.", bad: true };
    return render();
  }
  if (!settings.watching.includes(wallet)) settings.watching.push(wallet);
  save();
  state.note = null;
  render();
  void refresh(true);
}

function unwatch(wallet: string): void {
  settings.watching = settings.watching.filter((w) => w !== wallet);
  save();
  render();
  void refresh(true);
}

/** Allowing pause and resume: a code, the approval page in the browser, and this panel watching the code. */
async function connect(): Promise<void> {
  state.view = "settings";
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
        state.note = { text: `${short(wallet)} can now pause and resume from here.`, bad: false };
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
    state.note = { text: "Pause and resume is off, and this computer's key is deleted.", bad: false };
  } catch (error) {
    state.note = { text: String(error), bad: true };
  }
  render();
}

/** Claiming happens on the explorer, where the wallet signs: the one with the newest reward. */
function claim(): void {
  const wallet = state.rewards[0]?.wallet ?? watched()[0];
  if (wallet) void api.openExplorer(`/wallet/${wallet}/earned`);
}

// ---------------------------------------------------------------------------------------------
// Drawing. The page is redrawn from state each time and morphed onto what is there, so what stays
// stays: a switch slides, a digit rolls, a bar grows, instead of everything being made again.
// ---------------------------------------------------------------------------------------------

const panel = document.querySelector<HTMLDivElement>("#panel")!;
const app = document.querySelector<HTMLDivElement>("#app")!;
const reduced = matchMedia("(prefers-reduced-motion: reduce)");
/** Settles without passing its mark, as a critically damped spring does: most motion. */
const EASE = "cubic-bezier(0.2, 0.9, 0.25, 1)";
/** The room above and below the panel for its shadow: the app sizes the window to match. */
const INSET = 6 + 32;

const DIGITS = Array.from({ length: 10 }, (_, d) => `<span>${d}</span>`).join("");

/**
 * A number whose digits roll to their new value, as a counter's do. Each digit is a column of 0 to 9,
 * keyed from the right, so 99 becoming 100 adds a column on the left and rolls the other two.
 */
function roll(key: string, text: string): string {
  let place = 0;
  const cells = [...text].reverse().map((c) => {
    if (c < "0" || c > "9") return `<span>${esc(c)}</span>`;
    return `<span class="digit" id="${key}-${place++}"><span style="transform:translateY(-${Number(c) * 10}%)">${DIGITS}</span></span>`;
  });
  return `<span class="sr">${esc(text)}</span><span class="roll" aria-hidden="true">${cells.reverse().join("")}</span>`;
}

function maskHtml(agent: Agent, phase: Phase): string {
  const away = phase.kind === "offline" || phase.kind === "off" || phase.kind === "docker-down";
  const face = faceFor(agent.tokenId, away ? "away" : "on");
  const dot = dotOf(phase);
  return `<span class="mask${away ? " away" : ""}">${face ? `<img src="${esc(face)}" alt="" draggable="false">` : `<span class="mask-blank"></span>`}<span class="dot ${dot}${phase.kind === "working" ? " live" : ""}"></span></span>`;
}

function switchHtml(agent: Agent, phase: Phase, index: number): string {
  const local = agent.tokenId === state.localToken && state.box?.installed;
  const canSwitch = local || linked(agent.wallet);
  if (!canSwitch) return "";
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
    const open = state.openAgent === agent.tokenId;
    const label = labelOf(agent.tokenId);
    // two lines: who it is, then how it is and what it did last; the tray holds the rest
    const status = state.sending.has(agent.tokenId)
      ? (agent.standing?.standing.pausedByOwnerAt ? "Pausing…" : "Resuming…")
      : phase.kind === "ready" ? ["Ready", lastJob(agent)].filter(Boolean).join(" · ") : statusLine(phase, agent);
    return `<div class="row${open ? " open" : ""}" id="agent-${esc(agent.tokenId)}" data-agent="${esc(agent.tokenId)}" tabindex="0" aria-expanded="${open}" title="${open ? "Fold" : `What ${esc(nameOf(agent.tokenId))} is doing`}${i < 9 ? ` (⇧${i + 1})` : ""}">
      ${maskHtml(agent, phase)}
      <span class="lines">
        <span class="name"><b>${esc(label || `Agent #${agent.tokenId}`)}</b>${label ? `<span class="label">#${esc(agent.tokenId)}</span>` : ""}${outdated(agent) ? `<span class="tag warn" title="${esc(`Runs worker ${agent.standing?.presence?.daemonVersion ?? ""}; the newest is ${state.release?.newest ?? ""}`)}">Outdated</span>` : ""}${jailWords(agent.standing) ? `<span class="tag warn" title="No oracle, research or contract jobs">Fewer jobs</span>` : ""}</span>
        <span class="status${phase.kind === "working" ? " shimmer" : ""}">${esc(status)}</span>
      </span>
      <span class="row-end">${switchHtml(agent, phase, i)}<span class="chevron" aria-hidden="true">${CHEVRON}</span></span>
    </div>${open ? agentTrayHtml(agent) : ""}`;
  }).join("")}</div>`;
}

const firstLine = (text: string | undefined) => (text ?? "").split("\n")[0]!.trim();
const RESULT: Record<string, string> = { accepted: "Accepted", rejected: "Rejected", failed: "Failed", pending: "Being judged" };

/** What a resting agent did last: "Audit judging 2h ago", its result said only when it was not accepted. */
function lastJob(agent: Agent): string | null {
  const last = records.get(agent.tokenId)?.recent[0];
  if (!last) return null;
  const at = last.acceptedAt ?? last.submittedAt;
  const result = last.status === "accepted" ? "" : ` ${(RESULT[last.status ?? "pending"] ?? last.status ?? "").toLowerCase()}`;
  return `${stepTitle(last.nodeKey ?? null)}${result}${at ? ` ${shortAgo(new Date(at))} ago` : ""}`.replace(" now ago", " just now");
}

/** What an agent is doing and has done: its jobs now, its last three, and how its work is judged. */
function agentTrayHtml(agent: Agent): string {
  const record = records.get(agent.tokenId);
  const now = new Date();
  const doing = (agent.standing?.standing.running ?? []).map((job) => `<div class="job-now">
      <div class="job-head"><span class="pulse" aria-hidden="true"></span><b>${esc(stepTitle(job.nodeKey))}</b><span class="job-age">${esc(elapsed(new Date(job.since), now))}</span></div>
      <p class="objective">${esc(firstLine(job.objective))}</p>
    </div>`).join("");
  const done = (record?.recent ?? []).map((row) => {
    const result = row.status ?? "pending";
    const at = row.acceptedAt ?? row.submittedAt;
    return `<div class="done" title="${esc(firstLine(row.objective))}">
      <span class="mark ${esc(result)}" aria-hidden="true"></span>
      <span class="done-lines">
        <span class="done-head"><b>${esc(stepTitle(row.nodeKey ?? null))}</b><span class="done-age">${esc(RESULT[result] ?? result)}${at ? ` · ${esc(shortAgo(new Date(at), now))}` : ""}</span></span>
        <span class="done-objective">${esc(firstLine(row.objective))}</span>
      </span>
    </div>`;
  }).join("");
  const rate = record ? judgedRate(record.accepted, record.rejected, record.failed) : null;
  const facts = [rate !== null ? `${rate}% of judged` : null, record?.model].filter(Boolean).join(" · ");
  const local = agent.tokenId === state.localToken && state.box?.installed && state.box.state === "running";
  const failing = (agent.standing?.standing.consecutiveFailures ?? 0) > 0 ? failureWords(agent.standing?.standing.recentFailures?.[0]) : null;
  const behind = outdated(agent);
  const jailed = jailWords(agent.standing);
  // what wants doing comes first: an older worker, a failure, work it cannot take, or this computer's own Restart
  const restart = local
    ? `<button class="pill" data-action="restart" title="Restart this computer's agent (U)" ${state.restartWhenIdle ? "disabled" : ""}>${state.restartWhenIdle ? "Restarts after this job" : phaseFor(agent).kind === "working" ? "Restart after this job" : behind ? "Update" : "Restart"}</button>`
    : "";
  const behindText = behind ? `${behindWords(agent.standing!.presence!.daemonVersion!, state.release!.order)}.${local ? "" : " Restart it to update."}` : "";
  const care = [
    failing ? `<div class="care-row bad"><span class="care-text" title="${esc(failing)}">Its last job failed: ${esc(failing)}</span>${local && !behind ? restart : ""}</div>` : "",
    behind ? `<div class="care-row warn"><span class="care-text">${esc(behindText)}</span>${restart}</div>` : "",
    // the worker's own words say why and what fixes it; on this computer, a restart starts the box with its sandbox
    jailed ? `<div class="care-row warn"><span class="care-text" title="${esc(jailed)}">No oracle, research or contract jobs</span>${local && !behind && !failing ? restart : ""}</div>` : "",
    local && !behind && !failing && !jailed ? `<div class="care-row"><span class="care-text">Runs on this computer</span>${restart}</div>` : "",
  ].join("");
  return `<div class="agent-tray" id="tray-${esc(agent.tokenId)}">
    ${care ? `<div class="care">${care}</div>` : ""}
    ${doing ? `<div class="tray-label">Now</div>${doing}` : `<div class="tray-label">Now</div><p class="idle">${esc(phaseFor(agent).kind === "ready" ? "Waiting for its next job." : statusLine(phaseFor(agent), agent))}</p>`}
    ${done ? `<div class="tray-label">Lately</div>${done}` : ""}
    <div class="tray-foot"><span class="facts" title="${esc(record ? `${record.accepted} accepted, ${record.rejected} rejected, ${record.failed} failed` : "")}">${esc(facts)}</span><button class="link" data-explorer="/agents/${esc(agent.tokenId)}" title="Open on the explorer (O)">Explorer ›</button></div>
  </div>`;
}

/** A day on the chart in words: the last bar is today, the others their date. */
const dayWords = (i: number) => (i === DAYS - 1 ? "today" : dayStart(new Date(), DAYS - 1 - i).toLocaleDateString([], { month: "short", day: "numeric" }));

/** Fourteen bars, today's last and darkest. Scrubbed, the bar under the pointer lights and the rest step back. */
function sparkHtml(days: Array<number | null>): string {
  const max = Math.max(1, ...days.map((d) => d ?? 0));
  return `<div class="spark${state.scrub !== null ? " scrubbing" : ""}" tabindex="0" role="group" aria-label="Jobs per day, the last ${days.length} days: point at a day, or use the arrow keys">${days.map((count, i) => {
    const height = count ? Math.max(4, Math.round((count / max) * 34)) : 3;
    const kind = count === null ? "unknown" : count === 0 ? "none" : i === days.length - 1 ? "today" : "";
    return `<i class="${kind}${state.scrub === i ? " hot" : ""}" style="height:${height}px;--i:${i}"></i>`;
  }).join("")}</div>`;
}

/** Yours: three numbers, two weeks of work, and what it earned, in one card. */
function workHtml(): string {
  const known = state.agents.filter((a) => a.accepted !== null);
  const rewards = state.rewards.length ? rewardsHtml() : "";
  if (!known.length) return rewards ? `<section class="card">${rewards}</section>` : "";
  const now = totals()!;
  const shown = revealing && openedFrom ? openedFrom : now;
  const gain = openedFrom && !revealing ? now.accepted - openedFrom.accepted : 0;
  const since = upSince(state.agents, state.agents.map(phaseFor));
  const days = workDays();
  // scrubbing the chart, the first number is that day's, and says which day
  const day = state.scrub !== null && state.scrub < DAYS - 1 ? state.scrub : null;
  const first = day === null ? shown.today.toLocaleString() : days[day] === null ? "?" : days[day]!.toLocaleString();
  return `<section class="card${state.scrub !== null ? " scrubbing" : ""}"><div class="work">
    <div class="numbers">
      <div><b data-count="today">${roll("today", first)}</b><span class="cap">Jobs ${esc(day === null ? "today" : dayWords(day))}</span></div>
      <div><b>${roll("accepted", shown.accepted.toLocaleString())}${gain > 0 ? `<span class="gain" title="${gain} more since you last looked">+${gain}</span>` : ""}</b><span class="cap">All time</span></div>
      <div title="${esc(since ? `Every agent that is up has been up since ${since.toLocaleString()}` : "No agent is up")}"><b>${since ? roll("uptime", runLength(since)) : "Off"}</b><span class="cap">Uptime</span></div>
    </div>
    ${days.some((d) => d !== null) ? `${sparkHtml(days)}<div class="axis"><span>Last ${DAYS} days</span><span>Today</span></div>` : ""}
  </div>${rewards}</section>`;
}

/** A coin: its art, or, without any, colours of its own drawn from its address. */
function coinHtml(reward: Earning, depth = 0, fresh = false, named = true): string {
  const logo = reward.launch?.logo ? `https://api.imd.fun/artifacts/${encodeURIComponent(reward.launch.logo)}` : null;
  const hue = Number.parseInt(reward.token.address.slice(2, 8), 16) % 360;
  const fill = logo ? "" : `background:linear-gradient(135deg,hsl(${hue} 70% 62%),hsl(${(hue + 48) % 360} 68% 46%));`;
  return `<span class="coin${fresh ? " new" : ""}" style="z-index:${9 - depth};--d:${depth};${fill}"${named ? ` title="${esc(reward.token.name)}"` : ""}>${logo ? `<img src="${esc(logo)}" alt="" draggable="false">` : esc(reward.token.symbol.slice(0, 1))}</span>`;
}

/** Rewards: a stack of the newest coins that opens into a tray of them, and Claim. */
function rewardsHtml(): string {
  const newest = state.rewards[0]!;
  const coins = [...new Map(state.rewards.map((r) => [r.token.address, r] as const)).values()].slice(0, 4);
  const open = state.rewardsOpen;
  const shown = state.rewards.slice(0, 5);
  return `<div class="line rewards-head${open ? " open" : ""}">
      <button class="opener" data-action="rewards" aria-expanded="${open}" title="${open ? "Fold rewards" : "Show rewards"} (E)">
        ${worthLabel(newest.wallet)}
        <span class="opener-end"><span class="coins">${coins.map((r, i) => coinHtml(r, i, Boolean(openedFrom?.coins && !openedFrom.coins.includes(r.launchId)), false)).join("")}</span><span class="chev">${CHEVRON}</span></span>
      </button>
      ${claimHtml(newest.wallet)}
    </div>
    ${open ? `<div class="tray">
      ${shown.map((r) => `<button class="reward" data-token="${esc(r.token.address)}" title="${esc(r.token.name)} on the explorer">
        ${coinHtml(r)}<span class="symbol">${esc(r.token.symbol)}</span><span class="amount">${esc(amountWords(r.amount, r.token.decimals))}</span><span class="age">${esc(shortAgo(new Date(r.at)))}</span>
      </button>`).join("")}
      ${state.rewards.length > shown.length ? `<button class="more" data-claim="${esc(newest.wallet)}">All of them on the explorer</button>` : ""}
    </div>` : ""}`;
}

/** Claim, and what it gets: the dollars ready, once the explorer has priced every reward. Nothing ready, no button. */
function claimHtml(wallet: string): string {
  const worth = state.worth.get(wallet);
  if (worth && worth.count === 0) return "";
  return `<button class="claim" data-claim="${esc(wallet)}" title="${esc(worth ? `Claim the ${worth.count} ready, on the explorer, with your wallet (C)` : "Claim on the explorer, with your wallet (C)")}">Claim</button>`;
}

/**
 * The row's first words: what the tokens ready to claim sell for today, in whole dollars, as the explorer
 * prices them, so it reads as tokens' worth and not as cash. Unpriced yet, just Rewards.
 */
function worthLabel(wallet: string): string {
  const worth = state.worth.get(wallet);
  const usd = revealing && openedFrom?.usd != null ? openedFrom.usd : worth?.usd;
  if (!worth?.count || !usd) return `<span class="line-label">Rewards</span>`;
  const dollars = usd < 1 ? "<$1" : `$${Math.round(usd).toLocaleString("en-US")}`;
  return `<span class="worth" title="${esc(`${worth.count} rewards ready to claim, worth about ${usdText(usd)} at today's prices`)}"><b>${roll("claim", dollars)}</b> in tokens</span>`;
}

type Tick = { kind: "accepted" | "working" | "job" | "joined" | "site"; who: string; what: string; at: string; page: string };

/** What just happened in the swarm, newest first: a step accepted or started, a job posted, an agent joined, a site up. One line each, a job once. */
function tickerItems(): Tick[] {
  const items: Tick[] = [];
  const jobs = new Set<string>();
  for (const e of state.swarm?.events ?? []) {
    if (e.jobId && jobs.has(e.jobId)) continue;
    let tick: Tick | null = null;
    // each opens where it happened: a job's page, or a new agent's
    const job = e.jobId ? `/jobs/${e.jobId}` : "";
    if (e.kind === "node" && (e.state === "accepted" || e.state === "working") && e.tokenId && job) tick = { kind: e.state, who: `#${e.tokenId}`, what: firstLine(e.objective), at: e.at, page: job };
    else if (e.kind === "job" && job) tick = { kind: "job", who: "New job", what: firstLine(e.objective), at: e.at, page: job };
    else if (e.kind === "agent" && e.state === "joined" && e.tokenId) tick = { kind: "joined", who: `#${e.tokenId}`, what: "joined the swarm", at: e.at, page: `/agents/${e.tokenId}` };
    else if (e.kind === "site" && e.ensName && job) tick = { kind: "site", who: "Site", what: e.ensName, at: e.at, page: job };
    if (!tick || !tick.what) continue;
    if (e.jobId) jobs.add(e.jobId);
    items.push(tick);
    if (items.length === 12) break;
  }
  return items;
}

const TICK_WORDS: Record<Tick["kind"], string> = { accepted: "Accepted", working: "Started", job: "Posted", joined: "Joined", site: "Published" };

let tickAt = 0;
/** The next thing that happened slides up into the line and the last one slides out. */
function tick(): void {
  const box = document.getElementById("ticker");
  const items = tickerItems();
  if (!box || !items.length) return;
  const item = items[tickAt++ % items.length]!;
  const next = document.createElement("button");
  next.className = "tick";
  next.dataset.explorer = item.page;
  next.title = `${TICK_WORDS[item.kind]}: ${item.what}. Open on the explorer`;
  next.innerHTML = `<span class="tick-dot ${item.kind}" aria-hidden="true"></span><span class="tick-text"><b>${esc(item.who)}</b> ${esc(item.what)}</span><span class="tick-age">${esc(shortAgo(new Date(item.at)))}</span>`;
  const last = box.lastElementChild as HTMLElement | null;
  box.append(next);
  if (!last) return;
  if (reduced.matches) return last.remove();
  last.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(-12px)" }], { duration: 360, easing: EASE, fill: "forwards" }).onfinish = () => last.remove();
  next.animate([{ opacity: 0, transform: "translateY(12px)" }, { opacity: 1, transform: "none" }], { duration: 460, easing: EASE });
}

/** Everyone else: the swarm's counts, and what it just did. */
function networkHtml(): string {
  const lines: string[] = [];
  if (state.swarm) {
    lines.push(`<div class="line swarm"><span class="line-label">Swarm</span><span class="line-value"><span class="pulse" aria-hidden="true"></span><span>${roll("online", state.swarm.online.toLocaleString())} online · ${roll("working", state.swarm.working.toLocaleString())} working</span></span></div>`);
    if (tickerItems().length) lines.push(`<div class="ticker" id="ticker" title="What the swarm just did"></div>`);
  }
  return lines.length ? `<section class="card">${lines.join("")}</section>` : "";
}

function welcomeHtml(): string {
  return `<section class="welcome">
    <div class="welcome-title">Watch your agents</div>
    <p>Paste the wallet that holds them.</p>
    <form data-form="watch"><input data-field="add" placeholder="0x…" spellcheck="false" autocomplete="off" aria-label="Wallet address (W)"><button class="primary" type="submit">Watch</button></form>
    <button class="link-row" data-action="setup">Or run an agent on this computer ›</button>
  </section>`;
}

// ---------------------------------------------------------------------------------------------
// Running an agent here: the box set up one step at a time, each done or the one button that does it.
// ---------------------------------------------------------------------------------------------

type SetupStep = "docker" | "pull" | "install" | "signin" | "pair" | "start";

/** The step to take next, or none when the box is set up and running. */
function nextStep(): SetupStep | null {
  const at = state.setup.at;
  if (!at) return null;
  if (at.docker !== "running") return "docker";
  if (!at.image) return "pull";
  if (!at.worker) return "install";
  if (!at.claude) return "signin";
  if (!state.setup.token) return "pair";
  return state.box?.state === "running" ? null : "start";
}

let setupTimer: ReturnType<typeof setTimeout> | null = null;

/** Reads how far the box has got. Waiting on something outside the panel (Docker opening, a sign-in in the Terminal), it looks again every few seconds. */
async function checkSetup(): Promise<void> {
  if (setupTimer) clearTimeout(setupTimer);
  const s = state.setup;
  s.at = await api.boxSetupState().catch(() => s.at);
  s.token = s.at?.device_key ? await api.deviceSeat(s.at.device_key).catch(() => s.token) : null;
  if (s.busy === "docker" && s.at?.docker === "running") s.busy = null;
  if (s.busy === "signin" && s.at?.claude) s.busy = null;
  render();
  if (state.view === "setup" && (s.busy === "docker" || s.busy === "signin")) setupTimer = setTimeout(() => void checkSetup(), 3000);
}

function openSetup(): void {
  if (state.view !== "setup") state.setupFrom = state.view === "settings" ? "settings" : "home";
  state.view = "setup";
  state.setup.error = null;
  render();
  void checkSetup();
}

function leaveSetup(): void {
  if (state.setup.busy === "pair") void api.boxPairCancel();
  state.view = state.setupFrom;
  render();
}

/** Takes the next step: opens Docker or its download, downloads the box, installs the worker, opens Claude's sign-in, pairs, starts. */
async function setupStep(): Promise<void> {
  const s = state.setup;
  const step = nextStep();
  if (!step || (s.busy && s.busy !== "docker" && s.busy !== "signin")) return;
  s.error = null;
  s.busy = step;
  render();
  try {
    if (step === "docker" || step === "signin") {
      await (step === "docker" ? api.dockerOpen() : api.boxSignIn());
      return void checkSetup();
    }
    if (step === "pull") await api.boxPull();
    if (step === "install") await api.boxInstall();
    if (step === "pair") s.register = (await api.boxPair()).register;
    if (step === "start") {
      await api.boxStart(settings.runtime);
      state.box = await api.boxState();
      s.busy = null;
      state.view = "home";
      return void refresh(true);
    }
  } catch (error) {
    s.error = String(error).replace(/^Error: /, "");
  }
  s.busy = null;
  s.pairing = null;
  await checkSetup();
}

// the pairing code arrives while `imd pair` waits for the wallet: its page opens, as Connect's does
void listen<{ code: string; url: string }>("box-pairing", (event) => {
  state.setup.pairing = event.payload;
  void api.openPairing(event.payload.url).catch(() => undefined);
  render();
});

const CHECK = `<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 8.5 6.5 11.5 12.5 4.5"/></svg>`;

function setupHtml(): string {
  const s = state.setup;
  const at = s.at;
  const next = nextStep();
  const steps: Array<{ key: SetupStep; name: string; done: boolean; done_: string; todo: string; busy: string; act: string }> = [
    { key: "docker", name: "Docker", done: at?.docker === "running", done_: "Running", todo: at?.docker === "stopped" ? "Installed, not running." : "Install it, then open it.", busy: at?.docker === "missing" ? "Waiting for Docker…" : "Opening Docker…", act: at?.docker === "stopped" ? "Open Docker" : "Get Docker" },
    { key: "pull", name: "The box", done: Boolean(at?.image), done_: "Downloaded", todo: "A few hundred MB, once.", busy: "Downloading…", act: "Download" },
    { key: "install", name: "The worker", done: Boolean(at?.worker), done_: "Installed", todo: "IMD and Claude Code.", busy: "Installing…", act: "Install" },
    { key: "signin", name: "Claude", done: Boolean(at?.claude), done_: "Signed in", todo: "The account it works with.", busy: "In Terminal, type /login.", act: "Sign in" },
    { key: "pair", name: "Your agent", done: Boolean(s.token), done_: s.token ? `Agent #${s.token}` : "", todo: "Approve with your wallet.", busy: "Approve in your browser.", act: "Pair" },
  ];
  const rows = steps.map((step, i) => {
    const busy = s.busy === step.key;
    const words = step.done ? step.done_ : busy ? step.busy : step.todo;
    // numbered, in order; done, its number turns to a check
    const number = `<span class="step-num" aria-hidden="true">${step.done ? CHECK : `<b>${i + 1}</b>`}</span>`;
    const end = step.done ? ""
      : busy ? `<span class="spinner"></span>`
      : step.key === next ? `<button class="pill" data-action="step" title="${esc(step.act)} (Enter)">${esc(step.act)}</button>` : "";
    const pairing = step.key === "pair" && busy && s.pairing
      ? `<div class="pairing"><div class="code">${esc(s.pairing.code.slice(0, 4))} ${esc(s.pairing.code.slice(4))}</div><div class="actions"><button class="pill" data-action="pair-cancel">Cancel</button><button class="claim" data-action="pair-open">Open page</button></div></div>`
      : "";
    return `<div class="line step${step.done ? " done" : step.key === next ? " next" : ""}" id="step-${step.key}">
        ${number}
        <span class="step-lines"><span class="step-name">${esc(step.name)}</span><span class="sub">${esc(words)}</span></span>
        ${end}
      </div>${pairing}`;
  }).join("");
  const register = s.register && s.token ? `<p class="footnote">Agent #${esc(s.token)} isn't registered as an agent yet. <button class="text-link" data-action="register">Register it</button>, then start.</p>` : "";
  const start = next === "start" && s.token
    ? `<button class="primary wide" data-action="step" title="Start (Enter)">${s.busy === "start" ? "Starting…" : `Start Agent #${esc(s.token)}`}</button>`
    : !next && at ? `<p class="footnote">Agent #${esc(s.token ?? state.localToken ?? "")} runs here. It turns on and off from the list.</p>` : "";
  return `<header class="settings-head">
      <button class="back" data-action="leave-setup" title="Back (Esc)">‹ Back</button>
      <div class="title">Run an agent here</div>
      <span></span>
    </header>
    <p class="setup-intro">In a box that can't see this computer.</p>
    ${at ? `<section class="card list">${rows}</section>` : `<section class="card list"><div class="line"><span class="sub">Looking at this computer…</span><span class="spinner"></span></div></section>`}
    ${register}
    ${start}
    ${s.error ? `<div class="note bad" role="status">${esc(s.error)}</div>` : ""}`;
}

function noteHtml(): string {
  return state.note ? `<div class="note${state.note.bad ? " bad" : ""}" role="status">${esc(state.note.text)}</div>` : "";
}

/** How the agents are, in a few words: "Both ready", "1 working · 1 ready", "1 ready · 1 offline". */
function summaryOf(): string {
  const word = (p: Phase) => (p.kind === "working" ? "working" : p.kind === "ready" ? "ready" : p.kind === "held" || p.kind === "paused" ? "paused" : p.kind === "offline" ? "offline" : p.kind === "changing" ? "starting" : "off");
  const counts = new Map<string, number>();
  for (const agent of state.agents) counts.set(word(phaseFor(agent)), (counts.get(word(phaseFor(agent))) ?? 0) + 1);
  const n = state.agents.length;
  if (counts.size === 1) {
    const only = [...counts.keys()][0]!;
    return n === 1 ? only.charAt(0).toUpperCase() + only.slice(1) : n === 2 ? `Both ${only}` : `All ${n} ${only}`;
  }
  return ["working", "ready", "paused", "starting", "off", "offline"].filter((w) => counts.has(w)).map((w) => `${counts.get(w)} ${w}`).join(" · ");
}

/** The header's line: how they are, and how many run an older worker. */
function headerLine(): string {
  const behind = state.agents.filter(outdated).length;
  return [summaryOf(), behind ? `${behind} outdated` : null].filter(Boolean).join(" · ");
}

function homeHtml(): string {
  const summary = state.agents.length ? headerLine() : state.loaded ? "No agents yet" : "Reading…";
  const empty = !watched().length && !state.box?.installed;
  return `<header>
      <div><div class="title">IMD Agents</div>${empty ? "" : `<div class="summary">${esc(summary)}</div>`}</div>
      <button class="icon" data-action="settings" title="Settings (,)" aria-label="Settings">${GEAR}</button>
    </header>
    ${empty ? welcomeHtml() : agentsHtml() + workHtml() + networkHtml()}
    ${noteHtml()}`;
}

function pauseHtml(): string {
  if (state.linking) {
    const code = state.linking.code;
    return `<div class="linking">
      <div class="linking-head"><span class="spinner"></span>Approve in your browser</div>
      <div class="code">${esc(code.slice(0, 4))} ${esc(code.slice(4))}</div>
      <div class="actions"><button class="pill" data-action="cancel">Cancel</button><button class="claim" data-action="reopen">Open page</button></div>
    </div>`;
  }
  if (settings.wallets.length) {
    return `<div class="line"><span>Pause and resume<span class="sub">${esc(settings.wallets.map(short).join(", "))}</span></span><button class="pill danger" data-action="disconnect">Turn off</button></div>`;
  }
  return `<div class="line"><span>Pause and resume</span><button class="pill" data-action="connect" title="Allow (L)">Allow</button></div>`;
}

/** Settings' line for this computer: its agent and Restart, or setting one up. */
function thisComputerHtml(): string {
  const here = state.box?.installed && state.box.state === "running" && state.localToken;
  return `<section class="card list spaced">${here
    ? `<div class="line"><span>Agent #${esc(state.localToken!)}<span class="sub">Runs on this computer</span></span><button class="pill" data-action="restart" title="Restart (U)">Restart</button></div>`
    : `<div class="line"><span>Run an agent here<span class="sub">In a box that can't see this computer</span></span><button class="pill" data-action="setup">Set up</button></div>`}</section>`;
}

function settingsHtml(): string {
  return `<header class="settings-head">
      <button class="back" data-action="home" title="Back (Esc)">‹ Back</button>
      <div class="title">Settings</div>
      <span></span>
    </header>
    <div class="group-label">Wallets</div>
    <section class="card list">
      ${watched().map((wallet) => {
        const count = state.holdings.get(wallet);
        const removable = settings.watching.includes(wallet) && !linked(wallet) && wallet !== state.localOwner;
        return `<div class="line wallet" id="wallet-${esc(wallet)}">
          <span class="address" title="${esc(wallet)}">${esc(short(wallet))}</span>
          <span class="line-value">${count === undefined ? "" : `${count} agent${count === 1 ? "" : "s"}`}${removable ? `<button class="remove" data-remove="${esc(wallet)}" title="Stop watching ${esc(short(wallet))}" aria-label="Stop watching ${esc(short(wallet))}">×</button>` : ""}</span>
        </div>`;
      }).join("")}
      <form class="line" data-form="watch"><input class="inline-input" data-field="add" placeholder="Add a wallet: 0x…" spellcheck="false" autocomplete="off" aria-label="Wallet address to watch (W)"></form>
    </section>
    <section class="card list spaced">${pauseHtml()}</section>
    ${thisComputerHtml()}
    ${state.linking || settings.wallets.length ? "" : `<p class="footnote">Sign once in your browser. Watching needs no signature.</p>`}
    ${state.agents.length ? `<div class="group-label">Names</div>
    <section class="card list">
      ${state.agents.map((a) => `<label class="line name-field"><span class="line-label">#${esc(a.tokenId)}</span><input class="inline-input" data-name="${esc(a.tokenId)}" placeholder="${esc(`Agent #${a.tokenId}`)}" value="${esc(settings.names[a.tokenId] ?? "")}" spellcheck="false"></label>`).join("")}
    </section>` : ""}
    <section class="card list spaced">
      <label class="line"><span>Open at login</span><button class="switch${state.openAtLogin ? " on" : ""}" role="switch" aria-checked="${state.openAtLogin}" data-action="login"><span></span></button></label>
      <div class="line"><span>Quit IMD Agents${appVersion ? `<span class="sub">Version ${esc(appVersion)}</span>` : ""}</span><button class="pill" data-action="quit" title="Quit (⌘Q)">Quit</button></div>
    </section>
    ${noteHtml()}`;
}

const GEAR = `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>`;
const CHEVRON = `<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5"/></svg>`;

// ---------------------------------------------------------------------------------------------
// Since you last looked: the panel remembers its numbers as it closes, and opening, they roll from
// there to now, a gain wearing a chip.
// ---------------------------------------------------------------------------------------------

type Totals = { today: number; accepted: number; usd: number | null; coins?: string[] };
const SEEN = "imd-agents:seen";
let seen: Totals | null = (() => { try { return JSON.parse(localStorage.getItem(SEEN) ?? "null") as Totals | null; } catch { return null; } })();
/** What the panel showed when it last closed, while it is open again. */
let openedFrom: Totals | null = null;
/** The first moment of an opening, drawn at the old numbers so the new ones can roll in. */
let revealing = false;

function totals(): Totals | null {
  const known = state.agents.filter((a) => a.accepted !== null);
  if (!known.length) return null;
  const newest = state.rewards[0];
  return {
    today: known.reduce((n, a) => n + (a.today ?? 0), 0),
    accepted: known.reduce((n, a) => n + (a.accepted ?? 0), 0),
    usd: newest ? state.worth.get(newest.wallet)?.usd ?? null : null,
    coins: state.rewards.slice(0, 20).map((r) => r.launchId),
  };
}

function remember(): void {
  const now = totals();
  if (!now) return;
  seen = now;
  try { localStorage.setItem(SEEN, JSON.stringify(now)); } catch { /* remembered for this run */ }
}

/** How deep each view sits, so the next slides in from the side it lives on. */
const DEPTH = { home: 0, settings: 1, setup: 2 } as const;
let shownView = state.view;
let drawn = false;
let lastTray = "";
let lastWindow = 0;
let growing: Animation | null = null;

function render(): void {
  const from = drawn ? panel.offsetHeight : 0;
  const html = state.view === "settings" ? settingsHtml() : state.view === "setup" ? setupHtml() : homeHtml();
  if (state.view !== shownView) {
    slide(html, DEPTH[state.view] > DEPTH[shownView]);
    shownView = state.view;
  } else {
    morph(html, from > 0);
  }
  drawn = true;
  // a ticker drawn new starts on what happened last
  const ticker = document.getElementById("ticker");
  if (ticker && !ticker.childElementCount) tick();
  const tray = trayState(state.agents.map(phaseFor), state.agents.some(outdated));
  if (tray !== lastTray) {
    lastTray = tray;
    void api.setTrayState(tray).catch(() => undefined);
  }
  resize(from);
}

/** What changed changes in place: a status line's new words fade up, new rows settle into the list. */
function morph(html: string, animate: boolean): void {
  const reworded: HTMLElement[] = [];
  const changed: HTMLElement[] = [];
  const arrived: HTMLElement[] = [];
  morphdom(app, `<div id="app">${html}</div>`, {
    onBeforeElUpdated(from, to) {
      // the ticker's lines are the ticker's own
      if (from.id === "ticker") return false;
      // the field someone is typing in stays theirs
      if (from === document.activeElement && from instanceof HTMLInputElement) return false;
      if (from.isEqualNode(to)) return false;
      if (from.classList.contains("status") && from.textContent !== to.textContent) reworded.push(from);
      if (from.classList.contains("dot") && from.className !== to.className && from.parentElement) changed.push(from.parentElement);
      return true;
    },
    onNodeAdded(node) {
      if (node instanceof HTMLElement && node.matches(".row, .reward, .line, .agent-tray, .job-now, .done")) arrived.push(node);
      return node;
    },
  });
  if (!animate || reduced.matches) return;
  for (const el of reworded) el.animate([{ opacity: 0, filter: "blur(3px)" }, { opacity: 1, filter: "blur(0)" }], { duration: 280, easing: EASE });
  // squash and stretch: the face takes the change as something with weight would
  for (const el of changed) el.animate([{ transform: "none" }, { transform: "scale(1.1, 0.9)" }, { transform: "scale(0.95, 1.06)" }, { transform: "none" }], { duration: 520, easing: "ease-out" });
  arrived.forEach((el, i) => el.animate([{ opacity: 0, transform: "translateY(-4px)" }, { opacity: 1, transform: "none" }], { duration: 340, delay: i * 35, easing: EASE, fill: "backwards" }));
}

/**
 * A job accepted while the panel is open: a +1 rises off the face that did it and arcs into the count,
 * which rolls as it lands, and the face gives a little hop. Rare, so it can be seen.
 */
function fly(tokenId: string, by: number): void {
  const mask = document.querySelector<HTMLElement>(`#agent-${CSS.escape(tokenId)} .mask`);
  const count = document.querySelector<HTMLElement>("[data-count=today]");
  if (!mask || !count || reduced.matches) return;
  // in the page's own points, whatever scale it is drawn at
  const page = document.body.getBoundingClientRect();
  const zoom = page.width / document.body.offsetWidth || 1;
  const a = mask.getBoundingClientRect();
  const b = count.getBoundingClientRect();
  const start = { x: (a.left + a.width / 2 - page.left) / zoom, y: (a.top + a.height / 3 - page.top) / zoom };
  const end = { x: (b.left + b.width / 2 - page.left) / zoom, y: (b.top + b.height / 2 - page.top) / zoom };
  // up and over, as a thrown thing goes: a curve through a point above both ends
  const lift = { x: (start.x + end.x) / 2 + 24, y: Math.min(start.y, end.y) - 46 };
  const at = (k: number) => ({
    x: (1 - k) ** 2 * start.x + 2 * (1 - k) * k * lift.x + k ** 2 * end.x,
    y: (1 - k) ** 2 * start.y + 2 * (1 - k) * k * lift.y + k ** 2 * end.y,
  });
  const chip = document.createElement("span");
  chip.className = "flyer";
  chip.textContent = `+${by}`;
  document.body.append(chip);
  const frames = Array.from({ length: 17 }, (_, i) => {
    const k = i / 16;
    const p = at(k);
    const scale = k < 0.2 ? 0.6 + k * 2.5 : 1.1 - (k - 0.2) * 0.4;
    return { transform: `translate(${p.x}px, ${p.y}px) translate(-50%, -50%) scale(${scale.toFixed(3)})`, opacity: k < 0.12 ? k / 0.12 : k > 0.88 ? (1 - k) / 0.12 : 1, offset: k };
  });
  chip.animate(frames, { duration: 900, easing: "cubic-bezier(0.35, 0.1, 0.25, 1)" }).onfinish = () => chip.remove();
  mask.animate([{ transform: "none" }, { transform: "translateY(-5px) scale(1.06)" }, { transform: "none" }], { duration: 420, easing: "cubic-bezier(0.34, 1.56, 0.64, 1)" });
  count.animate([{ transform: "none" }, { transform: "scale(1.12)" }, { transform: "none" }], { duration: 380, delay: 820, easing: "cubic-bezier(0.34, 1.56, 0.64, 1)" });
}

/** Settings and back: the next view slides in from the side it lives on while the last plays out. */
function slide(html: string, forward: boolean): void {
  const ghost = app.cloneNode(true) as HTMLElement;
  ghost.removeAttribute("id");
  ghost.querySelectorAll("[id]").forEach((el) => el.removeAttribute("id"));
  ghost.className = "ghost";
  ghost.setAttribute("aria-hidden", "true");
  app.innerHTML = html;
  if (reduced.matches) return;
  panel.append(ghost);
  const shift = forward ? 28 : -28;
  ghost.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: `translateX(${-shift}px)` }], { duration: 220, easing: EASE, fill: "forwards" }).onfinish = () => ghost.remove();
  app.animate([{ opacity: 0, transform: `translateX(${shift}px)` }, { opacity: 1, transform: "none" }], { duration: 320, easing: EASE });
}

/**
 * The panel is as tall as what it shows, and gets there smoothly: growing, the window makes room first
 * and the panel grows into it; shrinking, the panel shrinks and the window follows. A change mid-way
 * starts from wherever the panel is.
 */
function resize(from: number): void {
  const to = Math.min(Math.ceil(app.offsetHeight), 720);
  if (!to) return;
  panel.style.height = `${to}px`;
  growing?.cancel();
  growing = null;
  if (from <= 0 || Math.abs(to - from) < 1 || reduced.matches || document.visibilityState === "hidden") return fit(to);
  if (to > from) fit(to);
  const anim = panel.animate([{ height: `${from}px` }, { height: `${to}px` }], { duration: 400, easing: EASE });
  growing = anim;
  anim.onfinish = () => {
    if (growing === anim) growing = null;
    fit(to);
  };
}

function fit(height: number): void {
  const size = height + INSET;
  if (size === lastWindow) return;
  lastWindow = size;
  void api.fitPanel(size).catch(() => undefined);
}

// ---------------------------------------------------------------------------------------------
// Opening and closing: the panel comes in from its icon and goes back to it.
// ---------------------------------------------------------------------------------------------

let above = false;
let closing = false;
let fading: Animation | null = null;

function playIn(fromAbove: boolean): void {
  closing = false;
  above = fromAbove;
  document.body.dataset.above = String(above);
  fading?.cancel();
  fading = null;
  // the numbers as they stood when the panel last closed, then, a beat in, as they stand now
  const now = totals();
  openedFrom = seen && now ? seen : null;
  if (openedFrom && now && (openedFrom.today !== now.today || openedFrom.accepted !== now.accepted || openedFrom.usd !== now.usd) && !reduced.matches) {
    revealing = true;
    render();
    setTimeout(() => { revealing = false; render(); }, 420);
  }
  tickAt = 0;
  tick();
  if (reduced.matches) return;
  panel.animate([{ opacity: 0, transform: `translateY(${above ? 6 : -6}px) scale(0.98)` }, { opacity: 1, transform: "none" }], { duration: 300, easing: EASE });
  panel.classList.add("opening");
  setTimeout(() => panel.classList.remove("opening"), 1100);
}

function close(): void {
  if (closing) return;
  closing = true;
  remember();
  openedFrom = null;
  if (reduced.matches) return void api.hidePanel();
  fading = panel.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: `translateY(${above ? 4 : -4}px) scale(0.985)` }], { duration: 140, easing: "cubic-bezier(0.4, 0, 1, 1)", fill: "forwards" });
  fading.onfinish = () => void api.hidePanel();
}

void listen<boolean>("panel-shown", (event) => {
  playIn(event.payload === true);
  void refresh();
});
void listen("panel-close", () => close());

// ---------------------------------------------------------------------------------------------
// Input: every action has a key.
// ---------------------------------------------------------------------------------------------

function openSettings(): void {
  state.view = "settings";
  void autostartIsOn().then((on) => { state.openAtLogin = on; render(); }).catch(() => undefined);
  render();
}

/** W: the field that takes a wallet, on the welcome or in Settings. */
function focusWatch(): void {
  if (state.view === "home" && !app.querySelector("[data-field=add]")) openSettings();
  app.querySelector<HTMLInputElement>("[data-field=add]")?.focus();
}

/** An agent's tray: what it is doing and has done. One open at a time. */
function toggleAgent(tokenId: string): void {
  state.openAgent = state.openAgent === tokenId ? null : tokenId;
  render();
}

function toggleRewards(): void {
  if (!state.rewards.length) return;
  state.rewardsOpen = !state.rewardsOpen;
  render();
}

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
  if (action === "settings") return openSettings();
  if (action === "home") { state.view = "home"; return render(); }
  if (action === "setup") return openSetup();
  if (action === "leave-setup") return leaveSetup();
  if (action === "step") return void setupStep();
  if (action === "pair-open" && state.setup.pairing) return void api.openPairing(state.setup.pairing.url);
  if (action === "pair-cancel") { void api.boxPairCancel(); return; }
  if (action === "register" && state.setup.register) return void api.openPairing(state.setup.register);
  if (action === "rewards") return toggleRewards();
  if (action === "restart") return void restartLocal();
  if (action === "connect") return void connect();
  if (action === "reopen" && state.linking) return void api.linkReopen(state.linking.code);
  if (action === "cancel") { state.linking = null; return render(); }
  if (action === "disconnect") return void disconnect();
  if (action === "quit") return void api.quit();
  if (action === "login") {
    event.preventDefault();
    const next = !state.openAtLogin;
    void (next ? autostartOn() : autostartOff()).then(() => { state.openAtLogin = next; render(); }).catch((e) => { state.note = { text: String(e), bad: true }; render(); });
    return;
  }
  const remove = target.closest<HTMLElement>("[data-remove]")?.dataset.remove;
  if (remove) return unwatch(remove);
  const wallet = target.closest<HTMLElement>("[data-claim]")?.dataset.claim;
  if (wallet) return void api.openExplorer(`/wallet/${wallet}/earned`);
  const token = target.closest<HTMLElement>("[data-token]")?.dataset.token;
  if (token) return void api.openExplorer(`/token/${token}`);
  const page = target.closest<HTMLElement>("[data-explorer]")?.dataset.explorer;
  if (page) return void api.openExplorer(page);
  const agent = target.closest<HTMLElement>("[data-agent]")?.dataset.agent;
  if (agent) return toggleAgent(agent);
});

/** Scrubbing: the day under the pointer, or a step along with the arrow keys; leaving, back to today. */
function scrubTo(day: number | null): void {
  if (day === state.scrub) return;
  state.scrub = day;
  render();
}
/** The day under a point on the chart. */
function dayAt(spark: HTMLElement, x: number): number {
  const box = spark.getBoundingClientRect();
  return Math.max(0, Math.min(DAYS - 1, Math.floor(((x - box.left) / box.width) * DAYS)));
}
// pressed and dragged, the chart scrubs whether or not the panel has focus yet; hovered, once it has
let dragging: HTMLElement | null = null;
app.addEventListener("pointerdown", (event) => {
  const spark = (event.target as HTMLElement).closest<HTMLElement>(".spark");
  if (!spark) return;
  dragging = spark;
  spark.setPointerCapture(event.pointerId);
  scrubTo(dayAt(spark, event.clientX));
});
app.addEventListener("pointermove", (event) => {
  const spark = dragging ?? (event.target as HTMLElement).closest<HTMLElement>(".spark");
  if (!spark) return scrubTo(null);
  scrubTo(dayAt(spark, event.clientX));
});
app.addEventListener("pointerup", (event) => {
  if (!dragging) return;
  const box = dragging.getBoundingClientRect();
  dragging = null;
  // let go over the chart, the day stays under the pointer; let go off it, back to today
  if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) scrubTo(null);
});
app.addEventListener("pointerleave", () => { if (!dragging) scrubTo(null); });
app.addEventListener("focusout", (event) => { if ((event.target as HTMLElement).classList?.contains("spark")) scrubTo(null); });

app.addEventListener("submit", (event) => {
  event.preventDefault();
  const input = (event.target as HTMLElement).querySelector<HTMLInputElement>("[data-field=add]");
  if (input) watch(input.value);
});

app.addEventListener("change", (event) => {
  const input = event.target as HTMLInputElement;
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
  if ((event.target as HTMLElement).classList?.contains("spark") && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
    event.preventDefault();
    const from = state.scrub ?? DAYS - 1;
    return scrubTo(Math.max(0, Math.min(DAYS - 1, from + (event.key === "ArrowLeft" ? -1 : 1))));
  }
  if (event.key === "Escape") {
    if (state.scrub !== null) return scrubTo(null);
    if (state.view === "setup") return leaveSetup();
    if (state.view === "settings") { state.view = "home"; render(); } else close();
    return;
  }
  if (state.view === "setup" && event.key === "Enter") return void setupStep();
  if (event.metaKey || event.ctrlKey) {
    if (event.key === "q") void api.quit();
    if (event.key === ",") openSettings();
    return;
  }
  if (event.key === ",") return state.view === "settings" ? (state.view = "home", render()) : openSettings();
  if (event.key === "w") { event.preventDefault(); return focusWatch(); }
  if (event.key === "l") return void connect();
  if (event.key === "c") return claim();
  if (event.key === "e") return toggleRewards();
  if (event.key === "u") return void restartLocal();
  if (event.key === "r") return void refresh(true);
  if (event.key === "Enter") {
    const row = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("[data-agent]");
    if (row?.dataset.agent) toggleAgent(row.dataset.agent);
    return;
  }
  if (event.key === "o") {
    const tokenId = state.openAgent ?? (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("[data-agent]")?.dataset.agent;
    if (tokenId) void api.openExplorer(`/agents/${tokenId}`);
    return;
  }
  // ⇧1 to ⇧9: that agent's tray
  const shifted = event.shiftKey && /^Digit[1-9]$/.test(event.code) ? Number(event.code.slice(5)) : 0;
  if (state.view === "home" && shifted) {
    const agent = state.agents[shifted - 1];
    if (agent) toggleAgent(agent.tokenId);
    return;
  }
  const number = Number(event.key);
  if (state.view === "home" && number >= 1 && number <= 9) {
    const agent = state.agents[number - 1];
    if (agent) void toggle(agent);
  }
});

// The panel closes when it loses focus, as a menu does, or on a click in the room around it, and reads
// again whenever it opens.
window.addEventListener("blur", () => { if (!state.linking) close(); });
document.addEventListener("pointerdown", (event) => { if (!panel.contains(event.target as Node)) close(); });
window.addEventListener("focus", () => {
  if (closing) playIn(above);
  void refresh();
});

save();
render();
void refresh(true);
void api.appVersion().then((version) => { appVersion = version; render(); }, () => {});
// the swarm's line moves on every few seconds while anyone can see it
setInterval(() => { if (!document.hidden && !closing && state.view === "home") tick(); }, 3600);
// every 10 seconds while the panel is open, every minute while it is not: the icon stays true either way
const poll = () => { void refresh(); setTimeout(poll, document.hasFocus() ? 10_000 : 60_000); };
setTimeout(poll, 10_000);
