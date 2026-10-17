import "./style.css";
import { emit, listen } from "@tauri-apps/api/event";
import morphdom from "morphdom";
import * as api from "./api";
import { setupErrorWords } from "./model";

/**
 * Running an agent here: the setup window. Its own window, which stays open beside Finder and Docker while
 * they're in use, where the panel would close as soon as anything else was clicked. The five steps as a
 * quiet list, each done or what it is, and under them the one button, which takes the next step and shows
 * what it's doing while it runs; it moves on by itself as each thing happens, and closes onto the panel
 * when the agent runs.
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
  /** What the step under way is doing right now, in the words the app's Rust side sends, and since when. */
  words: {} as Partial<Record<Step, string>>,
  since: {} as Partial<Record<Step, number>>,
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

/** Each step by what it sets up, in words for someone who has never heard of a container or a worker. */
const NAMES: Record<Exclude<Step, "start">, string> = { docker: "Install Docker", pull: "Install IMD Box", install: "Install IMD Agent", signin: "Connect Claude", pair: "Connect IMD Agent" };

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
  state.since = { [next]: Date.now() };
  render();
  try {
    if (next === "docker") {
      await (state.at?.docker === "missing" ? api.dockerInstall() : api.dockerOpen());
      state.words.docker = mac || state.at?.docker === "stopped" ? "Starting Docker…" : "Waiting for Docker…";
      state.since.docker = Date.now();
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
  const { step, words } = event.payload;
  // a new phase starts its clock again; a count that only moves on keeps it
  if (state.words[step]?.replace(/[\d,]+/g, "#") !== words.replace(/[\d,]+/g, "#")) state.since[step] = Date.now();
  state.words[step] = words;
  render();
});

/**
 * How long a phase with no count of its own has been going, ticking, so a slow one plainly isn't stuck: an
 * older Mac can take a minute over Docker's installer or the box's unpacking.
 */
function elapsed(step: Step): string {
  const words = state.words[step] ?? "";
  const since = state.since[step];
  if (!since || /\d/.test(words)) return "";
  const seconds = Math.floor((Date.now() - since) / 1000);
  return seconds < 3 ? "" : ` · ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
setInterval(() => { if (state.busy) render(); }, 1000);

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
  if (words.startsWith("Downloading") || words.startsWith("Starting the download") || words.startsWith("Checking")) return "Next, a box from IMD Agents asks for your Mac's password, for Docker's installer.";
  if (words.startsWith("Waiting for your password")) return "Type your Mac's password in the box from IMD Agents. Docker's installer needs it once.";
  if (words.startsWith("Installing")) return "Docker's installer is putting Docker in Applications. On an older Mac this takes a minute or two.";
  return "Docker starts by itself, which can take a minute. If it offers a sign-in, you can skip it.";
}

/** Docker's step in words, for each state it can be in: not here, here but not running, or under way. */
function docker(at: api.Setup | null, busy: boolean): { about: string; act: string; busy: string; help: string } {
  const missing = at?.docker === "missing";
  return {
    about: missing ? "The free app that runs the sealed box." : "Installed, not running.",
    act: missing ? (mac ? "Install Docker" : "Get Docker") : "Open Docker",
    busy: state.words.docker ?? (missing && mac ? "Starting the download…" : missing ? "Waiting for Docker…" : "Starting Docker…"),
    help: busy ? dockerHelp(missing) : missing && mac ? `Installs Docker Desktop, free for personal use. You accept <button class="text-link" data-action="docker-terms">Docker's terms</button>.` : "",
  };
}

/** The one button: the next step by name, or while it's under way, what it's doing, filled as far as it has got. */
function button(next: Step | null): string {
  if (!next) return `<button class="primary big" data-action="done" title="Done (Enter)">Done</button>`;
  if (state.busy !== next) {
    const label = next === "docker" ? docker(state.at, false).act : next === "start" ? `Start Agent #${state.token}` : NAMES[next];
    return `<button class="primary big" data-action="step" title="${esc(label)} (Enter)">${esc(label)}</button>`;
  }
  const words = next === "docker" ? docker(state.at, true).busy : next === "pull" ? state.words.pull ?? "Starting the download…" : next === "install" ? state.words.install ?? "Installing…"
    : next === "signin" ? "Waiting for you to sign in…" : next === "pair" ? "Waiting for your wallet…" : "Starting…";
  const clock = elapsed(next);
  const [, got, total] = words.match(/([\d,]+) of ([\d,]+) MB/) ?? [];
  const share = got && total ? Math.min(100, (100 * Number(got.replace(/,/g, ""))) / Number(total.replace(/,/g, ""))) : null;
  return `<button class="primary big busy" disabled>${share === null ? `<span class="spinner"></span>` : `<span class="fill" style="width: ${share.toFixed(1)}%"></span>`}<span class="label">${esc(clock ? words.replace(/…$/, "") : words)}${clock}</span></button>`;
}

/** The line under the button: what happens next outside this window, said before it happens. Constants only. */
function nextHelp(next: Step | null): string {
  if (!next) return "";
  const busy = state.busy === next;
  if (next === "docker") return docker(state.at, busy).help;
  if (next === "pull" && busy && state.words.pull === "Unpacking…") return "Docker is unpacking the box. On an older Mac this takes a few minutes.";
  if (next === "signin" && busy) return "A Terminal window opened inside the box. Type /login there, and this step finishes by itself.";
  if (next === "pair" && busy) return "Your browser opened a page to approve with the wallet that holds your seat.";
  return "";
}

function html(): string {
  const at = state.at;
  const next = nextStep();
  const hero = `<img class="setup-icon" src="/app-icon.png" width="64" height="64" alt="">
    <h1>Run an agent here</h1>
    <p class="setup-intro">Your agent works in its own sealed box on this computer.</p>
    <ul class="setup-safe">
      <li>${LOCK}Your files, photos and passwords stay out of its sight</li>
      <li>${LOCK}Your other devices stay out of its reach</li>
      <li>${LOCK}Your wallet never touches it</li>
    </ul>`;
  const footer = !next && at ? "" : `<p class="setup-help">Stuck on a step? <button class="text-link" data-action="help" title="Get help (?)">Get help</button></p>`;
  if (!at) return `${hero}<section class="card list"><div class="line"><span class="sub">Looking at this computer…</span><span class="spinner"></span></div></section>${footer}`;
  const steps: Array<{ key: Exclude<Step, "start">; done: boolean; doneWords: string; about: string }> = [
    { key: "docker", done: at.docker === "running", doneWords: "Running", about: docker(at, false).about },
    { key: "pull", done: at.image, doneWords: "Installed", about: "The sealed box your agent works in. A few hundred MB." },
    { key: "install", done: at.worker, doneWords: "Installed", about: "It goes inside the sealed box." },
    { key: "signin", done: at.claude, doneWords: "Connected", about: "The AI your agent thinks with. Sign in once." },
    { key: "pair", done: Boolean(state.token), doneWords: `Connected · Agent #${state.token}`, about: "Approve with the wallet that holds your seat." },
  ];
  const list = steps.map((s, i) => `<div class="line step${s.done ? " done" : s.key === next ? " next" : ""}" id="step-${s.key}">
      <span class="step-num" aria-hidden="true">${s.done ? CHECK : `<b>${i + 1}</b>`}</span>
      <span class="step-lines"><span class="step-name">${esc(NAMES[s.key])}</span><span class="sub">${esc(s.done ? s.doneWords : s.about)}</span></span>
    </div>`).join("");
  const pairing = state.busy === "pair" && state.pairing
    ? `<div class="pairing"><div class="code">${esc(state.pairing.code.slice(0, 4))} ${esc(state.pairing.code.slice(4))}</div><div class="actions"><button class="pill" data-action="pair-cancel" title="Cancel (Esc)">Cancel</button><button class="pill" data-action="pair-open" title="Open page (Enter)">Open page</button></div></div>`
    : "";
  const register = state.register && state.token ? `<p class="footnote">Agent #${esc(state.token)} isn't registered as an agent yet. <button class="text-link" data-action="register">Register it</button>, then start.</p>` : "";
  const done = next ? "" : `<p class="step-help">Agent #${esc(state.token ?? "")} runs here. It's in your menu bar, where it turns on and off.</p>`;
  const help = nextHelp(next);
  return `${hero}<section class="card list">${list}</section>
    ${pairing}${register}${done}${button(next)}${help ? `<p class="step-help">${help}</p>` : ""}
    ${state.error ? `<div class="note bad" role="status" title="${esc(state.errorDetail ?? "")}">${esc(state.error)}</div>` : ""}
    ${footer}`;
}

const root = document.getElementById("setup")!;
// the window fits the page: a step's new line grows it, and nothing leaves a blank foot. It goes by the room the
// page got, not the size it asked for, so whatever the window keeps for itself is made up: on macOS 15 that was a line
let asked = 0;
let waiting = 0;
function fit(): void {
  // while it's still looking at this computer, the window keeps its first size rather than shrink and grow again
  if (waiting || !state.at) return;
  const lack = Math.ceil(root.getBoundingClientRect().height) - window.innerHeight;
  if (Math.abs(lack) <= 1) return;
  const height = Math.min(900, Math.max(360, (asked || window.innerHeight) + lack));
  if (height === asked) return;
  asked = height;
  void api.fitSetup(height).catch(() => undefined);
  // the resize measures again; a size the window can't take brings none, so stop waiting regardless
  waiting = window.setTimeout(() => { waiting = 0; }, 500);
}
window.addEventListener("resize", () => { clearTimeout(waiting); waiting = 0; fit(); });

function render(): void {
  morphdom(root, `<main id="setup" class="setup-page">${html()}</main>`, { onBeforeElUpdated: (from, to) => !from.isEqualNode(to) });
  fit();
}

root.addEventListener("click", (event) => {
  const action = (event.target as HTMLElement).closest<HTMLElement>("[data-action]")?.dataset.action;
  if (action === "step") return void step();
  if (action === "done") return void api.setupDone();
  if (action === "docker-terms") return void api.openDockerTerms();
  if (action === "help") return void api.openSetupHelp();
  if (action === "pair-open" && state.pairing) return void api.openPairing(state.pairing.url);
  if (action === "pair-cancel") return void api.boxPairCancel();
  if (action === "register" && state.register) return void api.openPairing(state.register);
});

window.addEventListener("keydown", (event) => {
  if (event.key === "?") return void api.openSetupHelp();
  // while the wallet's page is out, Enter opens it again and Escape stops pairing
  if (state.busy === "pair" && state.pairing) {
    if (event.key === "Enter") return void api.openPairing(state.pairing.url);
    if (event.key === "Escape") return void api.boxPairCancel();
  }
  if (event.key !== "Enter") return;
  if (!nextStep() && state.at) return void api.setupDone();
  void step();
});

render();
void check();
