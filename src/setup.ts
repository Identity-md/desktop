import "./style.css";
import { emit, listen } from "@tauri-apps/api/event";
import morphdom from "morphdom";
import * as api from "./api";
import { faceFor, loadFace } from "./masks";
import { setupErrorWords } from "./model";
import { iconHome, mac, windows } from "./platform";

/**
 * Running an agent here: the setup window. Its own window, which stays open beside Finder and Docker while
 * they're in use, where the panel would close as soon as anything else was clicked. The five steps as a
 * quiet list, each done or what it is, and under them the one button, which takes the next step and shows
 * what it's doing while it runs; it moves on by itself as each thing happens, and closes onto the panel
 * when the agent runs.
 */

type Step = "docker" | "pull" | "install" | "signin" | "pair" | "start";

/**
 * Where the seat this computer will run is: in its person's own wallet; in a friend's, approved from it through a link
 * sent to them; or on imdLend, where a vault holds it and imdLend approves the pairing. Asked once, after the first
 * screen, and kept; until it's answered, the person's own wallet.
 */
type Seat = "own" | "friend" | "lend";
const SEAT = "imd-agents:seat";
const savedSeat = (() => { try { const seat = localStorage.getItem(SEAT); return seat === "own" || seat === "friend" || seat === "lend" ? seat : null; } catch { return null; } })();

/** Where the app installs Docker itself, with Docker's own installer; on Linux it opens Docker's page. */
const installs = mac || windows;
/** This computer, as its person calls it. */
const computer = mac ? "Mac" : windows ? "PC" : "computer";
const settings = (() => { try { return JSON.parse(localStorage.getItem("imd-agents:settings") ?? "{}") as { runtime?: string }; } catch { return {}; } })();
/** Whether Continue was pressed on the first screen, now or before: reopened part way, setup opens on its steps. */
const BEGUN = "imd-agents:setup-begun";
const begun = (() => { try { return localStorage.getItem(BEGUN) === "1"; } catch { return false; } })();

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
  /** When the pairing code runs out, as the network has it, for the button to count down to. */
  expires: null as number | null,
  /** Whether the code went onto the clipboard, for imdLend's page to take. */
  copied: false,
  /** Pairing stopped by Cancel: its end is no error. */
  cancelled: false,
  /** A pairing this window found already waiting, opened again after its code went out: its end comes as an event. */
  resumed: false,
  /** Where the seat is, as answered; null until asked. */
  seat: savedSeat as Seat | null,
  /** The seat screen, while it shows: after the first screen, or from step 5's Change. */
  asking: null as "first" | "change" | null,
  /** The answer picked on the seat screen, kept by Continue. */
  picked: "own" as Seat,
  register: null as string | null,
  error: null as string | null,
  errorDetail: null as string | null,
  started: false,
  intro: !begun,
  /** Bytes free where Docker and the box will live, once read; null where the app can't tell. */
  free: null as number | null,
};

/** What setup takes on disk: Docker 2.2 GB, the box 1.4 GB, and Docker's 590 MB download while it installs. On Windows,
 * Docker 3.5 GB and its 650 MB download, and WSL besides. */
const NEEDED = windows ? 7e9 : 5e9;

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
/** Windows: Docker started by setup itself, once, on opening to it installed and not running, as after WSL's restart. */
let startedDocker = false;

/** Reads how far this computer has got, and looks again every few seconds while something outside the window is under way. */
async function check(): Promise<void> {
  if (timer) clearTimeout(timer);
  state.at = await api.boxSetupState().catch(() => state.at);
  state.token = state.at?.device_key ? await api.deviceSeat(state.at.device_key).catch(() => state.token) : null;
  if (state.token) void loadFace(state.token, render);
  state.running = (await api.boxState().catch(() => null))?.state === "running";
  if (state.busy === "docker" && state.at?.docker === "running") state.busy = null;
  if (state.busy === "signin" && state.at?.claude) state.busy = null;
  render();
  // the panel's row: where setup has got
  const next = nextStep();
  const order: Step[] = ["docker", "pull", "install", "signin", "pair"];
  void emit("setup-progress", next && next !== "start" ? `Step ${order.indexOf(next) + 1} of 5 · ${NAMES[next]}` : next === "start" ? "Ready to start" : null);
  if (state.busy === "docker" || state.busy === "signin") timer = setTimeout(() => void check(), 2500);
  // reopened after WSL's restart on a Docker installed before it: setup carries on by itself
  else if (windows && !startedDocker && !state.intro && state.at?.docker === "stopped") {
    startedDocker = true;
    void step();
  }
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
      // the restart Windows needs to turn WSL on: setup opens again after it
      if (state.at?.docker === "restart" || state.at?.docker === "restart-wsl") {
        await api.restartPc();
        // Windows asks apps with unsaved work first: canceled there, the button comes back
        setTimeout(() => { if (state.busy === "docker") { state.busy = null; render(); } }, 30_000);
        return;
      }
      const restart = state.at?.docker === "missing" ? await api.dockerInstall() : await api.dockerOpen();
      if (restart) {
        state.busy = null;
        return void check();
      }
      state.words.docker = installs || state.at?.docker === "stopped" ? "Starting Docker…" : "Waiting for Docker…";
      state.since.docker = Date.now();
      return void check();
    }
    if (next === "signin") {
      await api.boxSignIn();
      return void check();
    }
    if (next === "pull") await api.boxPull();
    if (next === "install") await api.boxInstall();
    if (next === "pair") state.register = (await api.boxPair(settings.runtime ?? "claude")).register;
    if (next === "start") {
      await api.boxStart(settings.runtime ?? "claude");
      state.started = true;
    }
  } catch (error) {
    if (!(next === "pair" && state.cancelled)) {
      state.errorDetail = String(error).replace(/^Error: /, "");
      state.error = setupErrorWords(state.errorDetail);
    }
  }
  state.busy = null;
  state.pairing = null;
  state.expires = null;
  state.copied = false;
  state.cancelled = false;
  await check();
}

/**
 * Setup opened again while a code waits, its link perhaps already with a friend: that pairing, shown where it was,
 * rather than Connect, which would make a new code and end it.
 */
async function resume(): Promise<void> {
  const pending = await api.pairingPending().catch(() => null);
  if (!pending || state.busy) return;
  state.busy = "pair";
  state.resumed = true;
  state.pairing = pending;
  state.since = { pair: Date.now() };
  void api.pairingExpires(pending.code).then((at) => { if (state.pairing?.code === pending.code) { state.expires = at; render(); } }).catch(() => undefined);
  render();
}

// a pairing this window didn't start, ending: connected and started, or why not
void listen<{ token_id: string | null; error: string | null }>("box-pair-ended", (event) => {
  if (!state.resumed) return;
  state.resumed = false;
  state.busy = null;
  state.pairing = null;
  state.expires = null;
  state.copied = false;
  const { error } = event.payload;
  if (error && !state.cancelled) {
    state.errorDetail = error;
    state.error = setupErrorWords(error);
  }
  state.cancelled = false;
  void check();
});

/** Cancel, while the code waits: the pairing stops, and the step stands as it was. */
function cancelPairing(): void {
  state.cancelled = true;
  void api.boxPairCancel();
}

void listen<{ step: Step; words: string }>("setup-step-progress", (event) => {
  const { step, words } = event.payload;
  // approved: the code's done with, and the agent is starting
  if (step === "pair") { state.pairing = null; state.expires = null; }
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
  const { code } = event.payload;
  state.pairing = event.payload;
  state.expires = null;
  state.copied = false;
  openApproval();
  // when it runs out, from the network's own record of the code
  void api.pairingExpires(code).then((at) => { if (state.pairing?.code === code) { state.expires = at; render(); } }).catch(() => undefined);
  render();
});

/** Where the seat is: as answered, or the person's own wallet until then. */
const seat = (): Seat => state.seat ?? "own";

/**
 * Where the code goes to be approved. A seat in the wallet: the network's own page, with the code in its link. A
 * friend's: that link, onto the clipboard, to send them, since their wallet isn't here. A seat from imdLend: imdLend's
 * page, which can't take a code from its link, so the code goes onto the clipboard to paste there.
 */
function openApproval(): void {
  const pairing = state.pairing;
  if (!pairing) return;
  const copied = () => { if (state.pairing === pairing) { state.copied = true; render(); } };
  if (seat() === "friend") return void api.copyPairing(pairing.url).then(copied).catch(() => undefined);
  if (seat() === "own") return void api.openPairing(pairing.url).catch(() => undefined);
  void api.openLend("pair", pairing.code).then((done) => { if (done) copied(); }).catch(() => undefined);
}

/** What's left of the code's time, as " · 4:59", once the network has said when it runs out. */
function left(): string {
  if (!state.expires) return "";
  const seconds = Math.max(0, Math.ceil((state.expires - Date.now()) / 1000));
  return ` · ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** A closed padlock, drawn at the step numbers' weight. */
const LOCK = `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="7" width="10" height="7" rx="1.6"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/></svg>`;

const CHECK = `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 8.5 6.5 11.5 12.5 4.5"/></svg>`;

/** The first words of Docker's step, before the app's own: a Mac downloads at once, a PC looks at itself first. */
const FIRST_WORDS = windows ? "Checking this PC…" : "Starting the download…";

/** While Docker's step is under way: what comes next outside this window, said before it happens. */
function dockerHelp(missing: boolean): string {
  const words = state.words.docker ?? (missing && installs ? FIRST_WORDS : "");
  if (missing && !installs) return "Install Docker Desktop from its page, then open it.";
  // on Windows nothing asks anything between the check and Docker's first run
  if (windows && /^(Checking|Starting the download|Downloading|Verifying)/.test(words)) return "";
  if (words.startsWith("Downloading") || words.startsWith("Starting the download") || words.startsWith("Verifying")) return "Next, your Mac asks for your password to install Docker.";
  // macOS's own box takes it, and gives the app leave to install, never the password
  if (words.startsWith("Waiting for your password")) return "Your Mac needs your password to install Docker. It goes to macOS, never to IMD Agents.";
  // Windows dims the screen for its own prompt, which names WSL and Microsoft as its publisher; Docker itself asks for none
  if (words.startsWith("Waiting for your OK")) return "Windows asks to let Windows Subsystem for Linux, which Docker runs on, make changes. Choose Yes.";
  if (/^(Installing|Updating) WSL/.test(words)) return `Docker runs on WSL, a part of Windows.<br>${words.startsWith("Updating") ? "Updating" : "Installing"} it takes a few minutes.`;
  if (words.startsWith("Installing")) {
    return mac ? "Docker's installer is putting Docker in Applications. On an older Mac this takes a minute or two." : "Docker's installer is setting it up. This takes a few minutes.";
  }
  // Docker's first run asks things the box doesn't need: an account, and on a Mac the local network
  return mac ? "Docker starts by itself. Skip its sign-in, and if your Mac asks about devices on your network, choose Don't Allow." : "Docker starts by itself. Skip its sign-in.";
}

/** Docker's step in words, for each state it can be in: not here, here but not running, or under way. */
function docker(at: api.Setup | null, busy: boolean): { about: string; act: string; busy: string; help: string } {
  // Windows: WSL turns on with a restart, after which setup opens again by itself. Docker, in before it, starts
  // after it; one that wouldn't install yet goes in after it
  if (at?.docker === "restart" || at?.docker === "restart-wsl") {
    const about = at.docker === "restart" ? "Docker is installed. It starts after a restart." : "WSL is installed. It turns on after a restart.";
    return { about, act: "Restart your PC", busy: "Restarting…", help: busy ? "" : "Save your work first. Setup opens again after the restart." };
  }
  // not looked at yet, it reads as not here: the words a new Mac sees first
  const missing = !at || at.docker === "missing";
  return {
    about: missing ? "The free app that runs the sealed box." : "Installed, not running.",
    act: missing ? (installs ? "Install Docker" : "Get Docker") : "Open Docker",
    busy: state.words.docker ?? (missing && installs ? FIRST_WORDS : missing ? "Waiting for Docker…" : "Starting Docker…"),
    // the restart WSL ends in, said before anything starts
    help: busy ? dockerHelp(missing) : missing && installs ? `Installs Docker Desktop, free for personal use.<br>${at?.restart_ahead ? "Your PC restarts once. " : ""}You accept <button class="text-link" data-action="docker-terms">Docker's terms</button>.` : "",
  };
}

/** The one button: the next step by name, or while it's under way, what it's doing, filled as far as it has got. */
function button(next: Step | null): string {
  if (!next) return `<button id="go" class="primary big" data-action="done" title="Done (Enter)"><span class="label">Done</span></button>`;
  if (state.busy !== next) {
    const label = next === "docker" ? docker(state.at, false).act : next === "start" ? `Start Agent #${state.token}` : NAMES[next];
    return `<button id="go" class="primary big" data-action="step" title="${esc(label)} (Enter)"><span class="label">${esc(label)}</span></button>`;
  }
  const words = next === "docker" ? docker(state.at, true).busy : next === "pull" ? state.words.pull ?? "Starting the download…" : next === "install" ? state.words.install ?? "Installing…"
    : next === "signin" ? "Waiting for you to sign in…" : next === "pair" ? state.words.pair ?? (seat() === "friend" ? "Waiting for your friend…" : "Waiting for your wallet…") : "Starting…";
  // the code counts down, where every other step counts up
  const clock = next === "pair" && state.pairing && state.expires ? left() : elapsed(next);
  const [, got, total] = words.match(/([\d,]+) of ([\d,]+) MB/) ?? [];
  const share = got && total ? Math.min(100, (100 * Number(got.replace(/,/g, ""))) / Number(total.replace(/,/g, ""))) : null;
  return `<button id="go" class="primary big busy" disabled>${share === null ? `<span class="spinner"></span>` : `<span class="fill" style="width: ${share.toFixed(1)}%"></span>`}<span class="label">${esc(clock ? words.replace(/…$/, "") : words)}${clock}</span></button>`;
}

/** The line under the button: what happens next outside this window, said before it happens. Constants only. */
function nextHelp(next: Step | null): string {
  if (!next) return "";
  const busy = state.busy === next;
  if (next === "docker") return docker(state.at, busy).help;
  if (next === "pull" && busy && state.words.pull === "Unpacking…") return `Docker is unpacking the box. On an older ${computer} this takes a few minutes.`;
  // on a Mac, the sign-in opens in Terminal, which the Mac asks about the first time: the one prompt to allow
  if (next === "signin" && mac) return busy ? "Choose Allow if your Mac asks, then sign in through the Terminal window. This step finishes by itself." : "If your Mac asks to let IMD Agents control Terminal, choose Allow. Claude's sign-in opens there.";
  if (next === "signin" && busy) return "A terminal window opened inside the box. Sign in there, and this step finishes by itself.";
  // the page that approves the seat, said before it opens; once it's out, step 5's own line says what to do there
  if (next === "pair" && !busy && seat() === "lend") return "imdLend opens next with the code copied. Paste it there and approve.";
  if (next === "pair" && !busy && seat() === "own") return "Your browser opens next. Approve there with the wallet that holds your seat.";
  // how long the link lasts is the network's to say: the button counts it down, from the code's own end
  if (next === "pair" && !busy && seat() === "friend") return "Next, a link to send your friend. They approve it with their wallet.";
  return "";
}

/** Step 5's line while its code waits: what to do on the page that's out, where the code's room leaves none below. */
function approving(): string {
  if (seat() === "lend") return state.copied ? "Code copied. Paste it on imdLend and approve." : "Enter this code on imdLend and approve.";
  if (seat() === "friend") return state.copied ? "Link copied. Send it to your friend to approve." : "Copy the link and send it to your friend.";
  return "Approve in your browser with your seat's wallet.";
}

type Screen = "intro" | "seat" | "steps" | "agent";

/**
 * Four screens, one job each: the first, until Continue, says what it is, why it's safe and what it needs; the
 * seat, asked once; the steps; then, once the five are done, the agent itself, its face lit when it runs.
 */
function screenOf(): Screen {
  const next = nextStep();
  if (state.at && (next === "start" || !next)) return "agent";
  if (state.intro) return "intro";
  return state.asking ? "seat" : "steps";
}
const onIntro = () => screenOf() === "intro";

function introHtml(): string {
  // the disk is read, not asked about: it's said only when it's short
  const short = state.free !== null && state.free < NEEDED
    ? `<p class="note warn" role="status">This ${computer} has ${(state.free / 1e9).toFixed(1)} GB free. Setup needs about ${NEEDED / 1e9} GB.</p>`
    : "";
  // what setup can't check for: Claude Code comes with every paid Claude plan, and Codex isn't in the box. The seat
  // is the next screen's
  const seat = `<p class="setup-needs">You'll need <button class="text-link" data-action="claude-plans" title="Claude's plans (C)">a paid Claude plan</button>.</p>`;
  return `<div class="hero">
      <img class="setup-icon" src="/app-icon.png" width="72" height="72" alt="">
      <h1>Run an IMD Agent</h1>
      <p class="setup-intro">Your agent works in its own sealed box on this computer.</p>
      <ul class="setup-safe">
        <li>${LOCK}Your files, photos and passwords stay out of its sight</li>
        <li>${LOCK}Your other devices stay out of its reach</li>
        <li>${LOCK}Your wallet never touches it</li>
      </ul>
    </div>
    ${foot(`${short}${seat}`, `<button id="go" class="primary big" data-action="begin" title="Continue (Enter)"><span class="label">Continue</span></button>`, false)}`;
}

/** Past the first screen, remembered, so setup reopened opens on its steps; the seat comes next, unless it's known. */
function begin(): void {
  state.intro = false;
  try { localStorage.setItem(BEGUN, "1"); } catch { /* setup reopened shows the first screen again */ }
  if (state.seat === null) return ask("first");
  render();
}

/** The three answers: where the seat is, said the way its person would. */
const SEATS: Array<{ key: Seat; name: string }> = [
  { key: "own", name: "In my wallet" },
  { key: "friend", name: "In a friend's wallet" },
  { key: "lend", name: "On imdLend" },
];

function ask(mode: NonNullable<typeof state.asking>): void {
  state.asking = mode;
  state.picked = seat();
  render();
}

/** Continue on the seat screen: the answer kept. */
function keep(): void {
  state.seat = state.picked;
  try { localStorage.setItem(SEAT, state.seat); } catch { /* asked again next time */ }
  state.asking = null;
  render();
}

/**
 * The seat it will run: one question, three short answers, the person's own wallet picked to begin with. What each
 * means comes at the last step, before it happens. No seat yet: one link to get one, and setup goes on meanwhile.
 */
function seatHtml(): string {
  const rows = SEATS.map((s, i) => `<button class="seat-choice${state.picked === s.key ? " on" : ""}" role="radio" aria-checked="${state.picked === s.key}" data-seat="${s.key}" title="${esc(s.name)} (${i + 1})">
      <span class="radio" aria-hidden="true"></span><span class="step-name">${esc(s.name)}</span>
    </button>`).join("");
  const get = `<p class="setup-needs">No seat yet? <button class="text-link" data-action="seats" title="Agent seats on imd.fun (G)">Get one</button></p>`;
  const go = `<button id="go" class="primary big" data-action="keep" title="Continue (Enter)"><span class="label">Continue</span></button>`;
  return `<div class="question">
      <h1>Where's the agent seat?</h1>
      <p class="setup-intro">Your agent needs one to take jobs.</p>
      <div class="seat-choices" role="radiogroup" aria-label="Where's the agent seat?">${rows}</div>
    </div>
    ${foot(get, go, false)}`;
}

const errorLine = () => state.error ? `<div class="note bad" role="status" title="${esc(state.errorDetail ?? "")}">${esc(state.error)}</div>` : "";

/**
 * The foot of every screen, in the same place in a window that keeps one height: what's happening outside it or
 * what went wrong, then the one button, then help, its room kept where there's none, so the button never moves.
 */
function foot(message: string, go: string, help: boolean): string {
  return `<div class="setup-foot">${message}${go}<p class="setup-help${help ? "" : " empty"}">Stuck on a step? <button class="text-link" data-action="help" title="Get help (?)"${help ? "" : " tabindex=\"-1\""}>Get help</button></p></div>`;
}

/** The agent, set up: its own face, grey until it runs, and Start; then lit, and Done. */
function agentHtml(): string {
  const token = state.token ?? "";
  const running = !nextStep();
  const face = faceFor(token, running ? "on" : "away");
  const register = state.register ? `<p class="footnote">Agent #${esc(token)} isn't registered as an agent yet. <button class="text-link" data-action="register">Register it</button>, then start.</p>` : "";
  return `<div class="agent">
      <span class="mask big${running ? "" : " away"}">${face ? `<img src="${esc(face)}" alt="" draggable="false">` : `<span class="mask-blank"></span>`}<span class="dot${running ? " on" : ""}"></span></span>
      <h1>Agent #${esc(token)} ${running ? "is running" : "is set up"}</h1>
      <p class="setup-intro">${running ? `It's in your ${iconHome}, where it turns on and off.` : "Start it and it begins taking jobs."}</p>
    </div>
    ${foot(`${register}${errorLine()}`, button(nextStep()), !running)}`;
}

/** The seat, as answered, under the step that connects it. */
const SEAT_WORDS: Record<Seat, string> = { own: "Seat in your wallet", friend: "Seat in a friend's wallet", lend: "Seat on imdLend" };

/** Step 5 waiting on its button: the one moment Change shows. */
const changeable = () => nextStep() === "pair" && !state.busy;

function html(): string {
  const screen = screenOf();
  if (screen === "intro") return introHtml();
  if (screen === "seat") return seatHtml();
  if (screen === "agent") return agentHtml();
  const at = state.at;
  const next = nextStep();
  // until it has looked at this computer, the steps stand by their names and the button says it's looking, so the
  // window opens at about the size it keeps
  const steps: Array<{ key: Exclude<Step, "start">; done: boolean; doneWords: string; about: string }> = [
    { key: "docker", done: at?.docker === "running", doneWords: "Running", about: docker(at, false).about },
    { key: "pull", done: Boolean(at?.image), doneWords: "Installed", about: "The sealed box your agent works in." },
    { key: "install", done: Boolean(at?.worker), doneWords: "Installed", about: "The IMD worker and Claude Code, in the sealed box." },
    { key: "signin", done: Boolean(at?.claude), doneWords: "Connected", about: "The AI your agent thinks with. Sign in once." },
    { key: "pair", done: Boolean(state.token), doneWords: `Connected · Agent #${state.token}`, about: state.busy === "pair" && state.pairing ? approving() : SEAT_WORDS[seat()] },
  ];
  const change = ` · <button class="text-link" data-action="change-seat" title="Change where your seat is (C)">Change</button>`;
  const list = steps.map((s, i) => `<div class="line step${s.done ? " complete" : s.key === next ? " next" : ""}" id="step-${s.key}">
      <span class="step-num" aria-hidden="true">${s.done ? CHECK : `<b>${i + 1}</b>`}</span>
      <span class="step-lines"><span class="step-name">${esc(NAMES[s.key])}</span><span class="sub">${esc(s.done ? s.doneWords : s.about)}${s.key === "pair" && changeable() ? change : ""}</span></span>
    </div>`).join("");
  const page = seat() === "lend" ? "Open imdLend" : seat() === "friend" ? "Copy link" : "Open page";
  const pairing = state.busy === "pair" && state.pairing
    ? `<div class="pairing"><div class="code">${esc(state.pairing.code.slice(0, 4))} ${esc(state.pairing.code.slice(4))}</div><div class="actions"><button class="pill" data-action="pair-cancel" title="Cancel (Esc)">Cancel</button><button class="pill" data-action="pair-open" title="${page} (Enter)">${page}</button></div></div>`
    : "";
  const help = nextHelp(next);
  const go = at ? button(next) : `<button id="go" class="primary big busy" disabled><span class="spinner"></span><span class="label">Looking at this computer…</span></button>`;
  return `<section class="steps">${list}</section>
    ${foot(`${pairing}${help ? `<p class="step-help">${help}</p>` : ""}${errorLine()}`, go, true)}`;
}

const root = document.getElementById("setup")!;
/**
 * The window keeps one height on every screen, the tallest one's (a failed Docker download), so the button never
 * moves. It goes by the room the page got, not the size it asked for, so whatever the window keeps for itself is
 * made up: on macOS 15 that was a line.
 */
const ROOM = 556;
let asked = 0;
let waiting = 0;
function fit(): void {
  if (waiting) return;
  const lack = ROOM - window.innerHeight;
  if (Math.abs(lack) <= 1) return;
  const height = Math.min(900, Math.max(200, (asked || window.innerHeight) + lack));
  if (height === asked) return;
  asked = height;
  void api.fitSetup(height).catch(() => undefined);
  // the resize measures again; a size the window can't take brings none, so stop waiting regardless
  waiting = window.setTimeout(() => { waiting = 0; }, 500);
}
window.addEventListener("resize", () => { clearTimeout(waiting); waiting = 0; fit(); });

/** The panel's own easing: settles without passing its mark. */
const EASE = "cubic-bezier(0.2, 0.9, 0.25, 1)";
const reduced = matchMedia("(prefers-reduced-motion: reduce)");
/** A label's words without its count or clock: a new phase, where a count moving on is the same one. */
const phaseOf = (text: string) => text.replace(/ · \d+:\d\d$/, "").replace(/…$/, "").replace(/[\d,]+/g, "#");
let shown: Screen | null = null;

function render(): void {
  const screen = screenOf();
  const moved = shown !== null && screen !== shown;
  const go = document.getElementById("go");
  const from = moved ? go?.getBoundingClientRect().top : undefined;
  const said = go?.querySelector(".label")?.textContent ?? null;
  morphdom(root, `<main id="setup" class="setup-page">${html()}</main>`, { onBeforeElUpdated: (from, to) => !from.isEqualNode(to) });
  shown = screen;
  fit();
  const button = document.getElementById("go");
  if (!button) return;
  // a new screen comes in from the side the next one lives on, and the one button travels to its place on it
  if (moved) {
    for (const el of root.children) {
      if (el !== button) el.animate(reduced.matches ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, transform: "translateX(28px)" }, { opacity: 1, transform: "none" }], { duration: 320, easing: EASE });
    }
    if (from !== undefined && !reduced.matches) button.animate([{ transform: `translateY(${from - button.getBoundingClientRect().top}px)` }, { transform: "none" }], { duration: 400, easing: EASE });
  }
  // a new phase's words come in soft, where a count moving on only changes
  const label = button.querySelector(".label");
  if (said !== null && label && phaseOf(label.textContent ?? "") !== phaseOf(said)) {
    label.animate([{ opacity: 0, filter: "blur(2px)" }, { opacity: 1, filter: "none" }], { duration: 220, easing: EASE });
  }
}

/** An answer picked on the seat screen, by click, number or arrow. */
function pick(seat: Seat): void {
  state.picked = seat;
  render();
}

root.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  const seat = target.closest<HTMLElement>("[data-seat]")?.dataset.seat as Seat | undefined;
  if (seat) return pick(seat);
  const action = target.closest<HTMLElement>("[data-action]")?.dataset.action;
  if (action === "begin") return begin();
  if (action === "keep") return keep();
  if (action === "change-seat") return ask("change");
  if (action === "seats") return void api.openSeats();
  if (action === "claude-plans") return void api.openClaudePlans();
  if (action === "step") return void step();
  if (action === "done") return void api.setupDone();
  if (action === "docker-terms") return void api.openDockerTerms();
  if (action === "help") return void api.openSetupHelp();
  if (action === "pair-open") return openApproval();
  if (action === "pair-cancel") return cancelPairing();
  if (action === "register" && state.register) return void api.openPairing(state.register);
});

/** The seat screen by keys: 1 to 3 or the arrows pick, G gets a seat, Enter goes on, Escape goes back without a change. */
function seatKey(event: KeyboardEvent): void {
  const number = Number(event.key);
  if (number >= 1 && number <= SEATS.length) return pick(SEATS[number - 1]!.key);
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const at = SEATS.findIndex((s) => s.key === state.picked) + (event.key === "ArrowDown" ? 1 : -1);
    return pick(SEATS[(at + SEATS.length) % SEATS.length]!.key);
  }
  if (event.key === "g") return void api.openSeats();
  if (event.key === "Enter") return keep();
  if (event.key === "Escape") {
    // the first time, back to the first screen; from the steps, back to them as they were
    if (state.asking === "first") state.intro = true;
    state.asking = null;
    render();
  }
}

window.addEventListener("keydown", (event) => {
  if (event.key === "?") return void api.openSetupHelp();
  if (screenOf() === "seat") return seatKey(event);
  if (event.key === "c" && onIntro()) return void api.openClaudePlans();
  if (event.key === "c" && changeable()) return ask("change");
  // while the wallet's page is out, Enter opens it again and Escape stops pairing
  if (state.busy === "pair" && state.pairing) {
    if (event.key === "Enter") return openApproval();
    if (event.key === "Escape") return cancelPairing();
  }
  if (event.key !== "Enter") return;
  if (onIntro()) return begin();
  if (!nextStep() && state.at) return void api.setupDone();
  void step();
});

render();
// a code already out comes back first, so Connect never shows over it
void resume().then(check);
void api.freeSpace().then((bytes) => { state.free = bytes; render(); }).catch(() => undefined);
