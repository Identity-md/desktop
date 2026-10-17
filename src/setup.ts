import "./style.css";
import { emit, listen } from "@tauri-apps/api/event";
import morphdom from "morphdom";
import * as api from "./api";
import { setupErrorWords } from "./model";

/**
 * Running an agent here: the setup window. Its own window, which stays open beside Finder and Docker while
 * they're in use, where the panel would close as soon as anything else was clicked. One step at a time,
 * each done, under way with what it is doing right now, or the one button that does it; it moves on by
 * itself as each thing happens, and closes onto the panel when the agent runs.
 */

type Step = "docker" | "pull" | "install" | "signin" | "pair" | "start";

const mac = /Mac/.test(navigator.userAgent);
const windows = /Windows/.test(navigator.userAgent);
const settings = (() => { try { return JSON.parse(localStorage.getItem("imd-agents:settings") ?? "{}") as { runtime?: string }; } catch { return {}; } })();

const state = {
  at: null as api.Setup | null,
  /** The agent the box is paired to, as the network has it. */
  token: null as string | null,
  /** Whether the box runs already: set up and started, there's nothing left to do. */
  running: false,
  busy: null as Step | null,
  /** What the step under way is doing right now, in the words the app's Rust side sends. */
  words: {} as Partial<Record<Step, string>>,
  pairing: null as { code: string; url: string } | null,
  register: null as string | null,
  error: null as string | null,
  errorDetail: null as string | null,
  started: false,
};

const esc = (text: unknown) => String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** The step to take next, or none when the box is set up and running. */
function nextStep(): Step | null {
  const at = state.at;
  if (!at) return null;
  if (at.docker !== "running") return "docker";
  if (!at.image) return "pull";
  if (!at.worker) return "install";
  if (!at.claude) return "signin";
  if (!state.token) return "pair";
  return state.running ? null : "start";
}

const NAMES: Record<Exclude<Step, "start">, string> = { docker: "Docker", pull: "The box", install: "The worker", signin: "Claude", pair: "Your agent" };

let timer: ReturnType<typeof setTimeout> | null = null;

/** Reads how far this computer has got, and looks again every few seconds while something outside the window is under way. */
async function check(): Promise<void> {
  if (timer) clearTimeout(timer);
  state.at = await api.boxSetupState().catch(() => state.at);
  state.token = state.at?.device_key ? await api.deviceSeat(state.at.device_key).catch(() => state.token) : null;
  state.running = (await api.boxState().catch(() => null))?.state === "running";
  if (state.busy === "docker" && state.at?.docker === "running") state.busy = null;
  if (state.busy === "signin" && state.at?.claude) state.busy = null;
  render();
  // the panel's row: where setup has got
  const next = nextStep();
  const order: Step[] = ["docker", "pull", "install", "signin", "pair"];
  void emit("setup-progress", next && next !== "start" ? `Step ${order.indexOf(next) + 1} of 5 · ${NAMES[next]}` : next === "start" ? "Ready to start" : null);
  if (state.busy === "docker" || state.busy === "signin") timer = setTimeout(() => void check(), 2500);
}

/** Takes the next step: installs or opens Docker, downloads the box, installs the worker, opens Claude's sign-in, pairs, starts. */
async function step(): Promise<void> {
  const next = nextStep();
  if (!next || (state.busy && state.busy !== "docker" && state.busy !== "signin")) return;
  state.error = null;
  state.busy = next;
  state.words = {};
  render();
  try {
    if (next === "docker") {
      await (state.at?.docker === "missing" ? api.dockerInstall() : api.dockerOpen());
      state.words.docker = mac || state.at?.docker === "stopped" ? "Starting Docker…" : "Waiting for Docker…";
      return void check();
    }
    if (next === "signin") {
      await api.boxSignIn();
      return void check();
    }
    if (next === "pull") await api.boxPull();
    if (next === "install") await api.boxInstall();
    if (next === "pair") state.register = (await api.boxPair()).register;
    if (next === "start") {
      await api.boxStart(settings.runtime ?? "claude");
      state.started = true;
    }
  } catch (error) {
    state.errorDetail = String(error).replace(/^Error: /, "");
    state.error = setupErrorWords(state.errorDetail);
  }
  state.busy = null;
  state.pairing = null;
  await check();
}

void listen<{ step: Step; words: string }>("setup-step-progress", (event) => {
  state.words[event.payload.step] = event.payload.words;
  render();
});

// the pairing code arrives while `imd pair` waits for the wallet: its page opens, and the code shows here
void listen<{ code: string; url: string }>("box-pairing", (event) => {
  state.pairing = event.payload;
  void api.openPairing(event.payload.url).catch(() => undefined);
  render();
});

/** A closed padlock, drawn at the step numbers' weight. */
const LOCK = `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="7" width="10" height="7" rx="1.6"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/></svg>`;

const CHECK = `<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 8.5 6.5 11.5 12.5 4.5"/></svg>`;

/** While Docker's step is under way: what comes next outside this window, said before it happens. */
function dockerHelp(missing: boolean): string {
  const words = state.words.docker ?? "";
  if (missing && !mac) return windows ? "Run the installer in Downloads. Docker opens once it's installed." : "Install Docker Desktop from its page, then open it.";
  if (words.startsWith("Downloading") || words.startsWith("Starting the download") || words.startsWith("Checking")) return "Next, macOS asks for your password, for Docker's installer.";
  if (words === "Installing Docker…") return "Type your Mac's password when macOS asks. Docker's installer needs it once.";
  return "If Docker shows its terms, accept them. Its sign-in you can skip.";
}

/** Docker's step in words, for each state it can be in: not here, here but not running, or under way. */
function docker(at: api.Setup | null, busy: boolean): { todo: string; act: string; busy: string; help: string } {
  const missing = at?.docker === "missing";
  return {
    todo: missing ? "Not on this computer yet." : "Installed, not running.",
    act: missing ? (mac ? "Install Docker" : "Get Docker") : "Open Docker",
    busy: state.words.docker ?? (missing && mac ? "Starting the download…" : missing ? "Waiting for Docker…" : "Starting Docker…"),
    help: busy ? dockerHelp(missing) : missing && mac ? `Installs Docker Desktop, free for personal use. You accept <button class="text-link" data-action="docker-terms">Docker's terms</button>.` : "",
  };
}

function html(): string {
  const at = state.at;
  const next = nextStep();
  const d = docker(at, state.busy === "docker");
  const steps: Array<{ key: Exclude<Step, "start">; done: boolean; done_: string; todo: string; busy: string; act: string; help?: string }> = [
    { key: "docker", done: at?.docker === "running", done_: "Running", todo: d.todo, busy: d.busy, act: d.act, help: d.help },
    { key: "pull", done: Boolean(at?.image), done_: "Downloaded", todo: "A few hundred MB, once.", busy: state.words.pull ?? "Starting the download…", act: "Download" },
    { key: "install", done: Boolean(at?.worker), done_: "Installed", todo: "IMD and Claude Code.", busy: state.words.install ?? "Installing…", act: "Install" },
    { key: "signin", done: Boolean(at?.claude), done_: "Signed in", todo: "The Claude account it works with.", busy: "In Terminal, type /login.", act: "Sign in",
      help: "A Terminal window opened inside the box. Sign in there, and this step finishes by itself." },
    { key: "pair", done: Boolean(state.token), done_: state.token ? `Agent #${state.token}` : "", todo: "Approve with the wallet that holds your seat.", busy: "Approve in your browser.", act: "Pair" },
  ];
  const rows = steps.map((s, i) => {
    const busy = state.busy === s.key;
    const words = s.done ? s.done_ : busy ? s.busy : s.todo;
    const number = `<span class="step-num" aria-hidden="true">${s.done ? CHECK : `<b>${i + 1}</b>`}</span>`;
    const end = s.done ? "" : busy ? `<span class="spinner"></span>` : s.key === next ? `<button class="pill" data-action="step" title="${esc(s.act)} (Enter)">${esc(s.act)}</button>` : "";
    // the line under the step that's next or under way: what happens, or what to do outside this window
    const help = !s.done && s.help && (busy || s.key === next) && (s.key === "docker" || busy) ? `<p class="step-help">${s.key === "docker" && !busy ? s.help : esc(s.help)}</p>` : "";
    const pairing = s.key === "pair" && busy && state.pairing
      ? `<div class="pairing"><div class="code">${esc(state.pairing.code.slice(0, 4))} ${esc(state.pairing.code.slice(4))}</div><div class="actions"><button class="pill" data-action="pair-cancel">Cancel</button><button class="claim" data-action="pair-open">Open page</button></div></div>`
      : "";
    return `<div class="line step${s.done ? " done" : s.key === next ? " next" : ""}" id="step-${s.key}">
        ${number}
        <span class="step-lines"><span class="step-name">${esc(NAMES[s.key])}</span><span class="sub">${esc(words)}</span></span>
        ${end}
      </div>${help}${pairing}`;
  }).join("");
  const register = state.register && state.token ? `<p class="footnote">Agent #${esc(state.token)} isn't registered as an agent yet. <button class="text-link" data-action="register">Register it</button>, then start.</p>` : "";
  const finish = next === "start" && state.token
    ? `<button class="primary wide" data-action="step" title="Start (Enter)">${state.busy === "start" ? "Starting…" : `Start Agent #${esc(state.token)}`}</button>`
    : !next && at
      ? `<div class="setup-done"><p>Agent #${esc(state.token ?? "")} runs here. It's in your menu bar, where it turns on and off.</p><button class="primary wide" data-action="done" title="Done (Enter)">Done</button></div>`
      : "";
  return `<h1>Run an agent here</h1>
    <p class="setup-intro">Your agent works in its own sealed box on this computer.</p>
    <ul class="setup-safe">
      <li>${LOCK}Your files, photos and passwords stay out of its sight</li>
      <li>${LOCK}Your other devices stay out of its reach</li>
      <li>${LOCK}Your wallet never touches it</li>
    </ul>
    ${at ? `<section class="card list">${rows}</section>` : `<section class="card list"><div class="line"><span class="sub">Looking at this computer…</span><span class="spinner"></span></div></section>`}
    ${register}
    ${finish}
    ${state.error ? `<div class="note bad" role="status" title="${esc(state.errorDetail ?? "")}">${esc(state.error)}</div>` : ""}`;
}

const root = document.getElementById("setup")!;
function render(): void {
  morphdom(root, `<main id="setup" class="setup-page">${html()}</main>`, { onBeforeElUpdated: (from, to) => !from.isEqualNode(to) });
}

root.addEventListener("click", (event) => {
  const action = (event.target as HTMLElement).closest<HTMLElement>("[data-action]")?.dataset.action;
  if (action === "step") return void step();
  if (action === "done") return void api.setupDone();
  if (action === "docker-terms") return void api.openDockerTerms();
  if (action === "pair-open" && state.pairing) return void api.openPairing(state.pairing.url);
  if (action === "pair-cancel") return void api.boxPairCancel();
  if (action === "register" && state.register) return void api.openPairing(state.register);
});

window.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  if (!nextStep() && state.at) return void api.setupDone();
  void step();
});

render();
void check();
