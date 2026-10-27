// Every state of the setup window, in the order a new Mac or PC meets them, for setup-review.html to page through.
// Each opens the real setup page (setup-state.html) with the Rust side stood in for, then presses and says
// what the app would to get there: `click` presses the button, `press` clicks what each selector names, in turn,
// `words` is the app's progress line for a step, `hang` keeps a command waiting, `resolve` answers one at once, `fail`
// makes one fail as Docker would, `code` is pasted into Claude's sign-in and `send` hands it over, and `seat` is
// where the seat was said to be, "own" unless the state says otherwise.
// A state with `os` is only that computer's.
import { installMock } from "./mock.mjs";
import { forceTheme, holdStill, ready } from "./preview.js";

const E = "e".padEnd(64, "0"); // a box with its key, not paired yet
const D = "d5e40d01".padEnd(64, "0"); // the mock's paired box: this computer's agent
const none = { docker: "missing", restart_ahead: false, image: false, worker: false, claude: false, device_key: null };
const docker = { ...none, docker: "running" };
const box = { ...docker, image: true };
const agent = { ...box, worker: true, device_key: E };
const claude = { ...agent, claude: true };
const paired = { ...claude, device_key: D };

export const STATES = [
  { id: "intro", group: "Opening", name: "First screen", setup: none, intro: true, about: "What it is, why it's safe and what it needs. Press Continue: the button travels to its place on the steps." },
  { id: "intro-short", group: "Opening", name: "Short of space", setup: none, intro: true, free: 3.2e9, about: "The disk is read, not asked about: a Mac short of room hears it here, before anything downloads." },
  { id: "seat", group: "Opening", name: "Your seat", setup: none, intro: true, seat: null, press: ["[data-action=begin]"], about: "Continue pressed: one question before the steps, since where the seat is says what approves it. The person's own wallet is picked to begin with; 1 to 3 or the arrows pick, G opens imd.fun's seats, Esc goes back." },
  { id: "seat-friend", group: "Opening", name: "In a friend's wallet", setup: none, intro: true, seat: null, press: ["[data-action=begin]", "[data-seat=friend]"], about: "A seat that stays in a friend's wallet: they approve this box from it, through a link sent to them. Nothing to buy, take or sign here." },
  { id: "seat-lend", group: "Opening", name: "On imdLend", setup: none, intro: true, seat: null, press: ["[data-action=begin]", "[data-seat=lend]"], about: "Borrowed on imdLend: the seat sits in a vault there, and imdLend approves the pairing." },
  { id: "looking", group: "Opening", name: "Looking at this computer", setup: none, hang: ["box_setup_state"], about: "Only if Continue is pressed before the check of this Mac is back, usually under a second." },
  { id: "docker", group: "Install Docker", name: "Install Docker", setup: none, about: "A Mac without Docker. The button installs it, the link opens Docker's terms." },
  { id: "docker-pc", group: "Install Docker", name: "Install Docker, restart ahead", os: "windows", setup: { ...none, restart_ahead: true }, about: "A PC without WSL: installing Docker ends in one restart, which the line under the button says before anything starts." },
  { id: "docker-checking", group: "Install Docker", name: "Checking this PC", os: "windows", setup: none, click: true, about: "Install Docker pressed. A second's look at Windows' version, virtualization and WSL." },
  { id: "docker-ok", group: "Install Docker", name: "Windows asks", os: "windows", setup: none, click: true, words: ["docker", "Waiting for your OK…"], about: "Only without WSL, or with one too old: Windows dims the screen and asks to let Windows Subsystem for Linux, from Microsoft, make changes. A clock shows after 3 seconds." },
  { id: "docker-wsl", group: "Install Docker", name: "Installing WSL", os: "windows", setup: none, click: true, words: ["docker", "Installing WSL…"], about: "Windows installing WSL, which Docker's Linux runs on, a few minutes." },
  { id: "docker-restart", group: "Install Docker", name: "Restart", os: "windows", setup: { ...none, docker: "restart" }, about: "WSL and Docker installed on a PC whose Virtual Machine Platform was off: WSL turns on at the next start of Windows, and Docker starts after it. Restart your PC restarts it, and setup opens again by itself and starts Docker." },
  { id: "docker-restart-wsl", group: "Install Docker", name: "Restart, Docker after", os: "windows", setup: { ...none, docker: "restart-wsl" }, about: "Only if Docker's installer turned down a PC whose WSL waits on its restart: the restart comes first, and Docker installs after it." },
  { id: "docker-start", group: "Install Docker", name: "Starting the download", setup: none, click: true, words: ["docker", "Starting the download…"], about: "Install Docker pressed. Docker's own installer starts downloading." },
  { id: "docker-download", group: "Install Docker", name: "Downloading", setup: none, click: true, words: ["docker", "Downloading 212 of 590 MB"], about: "Docker's installer downloading. The button fills as it goes." },
  { id: "docker-check", group: "Install Docker", name: "Verifying", setup: none, click: true, words: ["docker", "Verifying Docker…"], about: "Verifying the download is Docker's own signed installer. About a second." },
  { id: "docker-password", group: "Install Docker", name: "Password", os: "mac", setup: none, click: true, words: ["docker", "Waiting for your password…"], about: "macOS asks for the password in a box from IMD Agents. A clock shows after 3 seconds." },
  { id: "docker-installing", group: "Install Docker", name: "Installing", setup: none, click: true, words: ["docker", "Installing Docker…"], about: "Docker's installer putting Docker in Applications, or on Windows installing it for this user alone, with no prompt." },
  { id: "docker-opening", group: "Install Docker", name: "Opening Docker", setup: none, click: true, words: ["docker", "Opening Docker…"], about: "Installed. Docker opens for its first run." },
  { id: "docker-starting", group: "Install Docker", name: "Starting Docker", setup: none, click: true, resolve: ["docker_install"], about: "Waiting for Docker to finish starting. It may offer a sign-in, which can be skipped." },
  { id: "docker-open", group: "Install Docker", name: "Not running", setup: { ...none, docker: "stopped" }, about: "Docker installed but not running, as after a restart." },
  { id: "box", group: "Install IMD Box", name: "Install IMD Box", setup: docker, about: "Docker is running. The box comes next." },
  { id: "box-download", group: "Install IMD Box", name: "Downloading", setup: docker, click: true, hang: ["box_pull"], words: ["pull", "Downloading 157 of 385 MB"], about: "The box downloading through Docker." },
  { id: "box-unpacking", group: "Install IMD Box", name: "Unpacking", setup: docker, click: true, hang: ["box_pull"], words: ["pull", "Unpacking…"], about: "Docker unpacking the box. A few minutes on an older Mac." },
  { id: "agent", group: "Install IMD Agent", name: "Install IMD Agent", setup: box, about: "The box is in. The IMD worker goes inside it." },
  { id: "agent-installing", group: "Install IMD Agent", name: "Installing", setup: box, click: true, hang: ["box_install"], words: ["install", "Installing Claude Code…"], about: "Claude Code, the IMD worker, then its browser, each in turn, inside the box." },
  { id: "claude", group: "Connect Claude", name: "Connect Claude", setup: agent, about: "The AI the agent thinks with, signed in once." },
  { id: "claude-waiting", group: "Connect Claude", name: "Waiting for sign-in", setup: agent, click: true, about: "Claude's sign-in opened in the browser, from Claude Code in the box with no terminal. The page ends on a code, which goes in the field under its name: pasted whole, it goes straight in. Enter opens the page again, Esc cancels." },
  { id: "claude-code", group: "Connect Claude", name: "Code typed", setup: agent, click: true, code: "Kq3vW9sTzX0aPbR7mN2cYd5LhE8uJf1Gk4iOp6Vx#Tz8qL2mN5bV7cX1", about: "A code typed in rather than pasted: the button hands it to Claude Code, as Enter does." },
  { id: "claude-checking", group: "Connect Claude", name: "Checking the code", setup: agent, click: true, code: "Kq3vW9sTzX0aPbR7mN2cYd5LhE8uJf1Gk4iOp6Vx#Tz8qL2mN5bV7cX1", send: true, hang: ["box_sign_in_code"], about: "Claude Code trading the code for its sign-in, a second or two. Signed in, the step is done." },
  { id: "pair", group: "Connect IMD Agent", name: "Connect IMD Agent", setup: claude, about: "Pairs this box with a seat in the wallet: the line above the button says the browser opens next. Change (C) asks where the seat is again." },
  { id: "pair-code", group: "Connect IMD Agent", name: "Pairing code", setup: claude, click: true, about: "The pairing page opened in the browser. The button counts down to the code's own end, as the network sets it. Enter opens the page again, Esc cancels." },
  { id: "pair-friend", group: "Connect IMD Agent", name: "A friend's seat", setup: claude, seat: "friend", about: "Step 5 for a friend's seat: a link comes next, for the friend to approve before the code runs out." },
  { id: "pair-friend-code", group: "Connect IMD Agent", name: "Link sent to a friend", setup: claude, seat: "friend", click: true, about: "The link on the clipboard, nothing opened: the friend approves it in their own browser with their wallet. Enter copies it again, Esc cancels." },
  { id: "pair-resumed", group: "Connect IMD Agent", name: "Opened again, link out", setup: claude, seat: "friend", pending: true, about: "Setup closed while the friend's link waited, then opened again: the same code and countdown, not Connect, which would make a new code and end the one already sent. Approved, the agent starts by itself, window or not." },
  { id: "pair-lend", group: "Connect IMD Agent", name: "A seat from imdLend", setup: claude, seat: "lend", about: "Step 5 for a borrowed seat: imdLend opens next, with the code copied." },
  { id: "pair-lend-code", group: "Connect IMD Agent", name: "Pairing on imdLend", setup: claude, seat: "lend", click: true, about: "The code on the clipboard and imdLend's pairing page open: paste, pick the seat, approve. Enter copies it and opens the page again, Esc cancels." },
  { id: "pair-change", group: "Connect IMD Agent", name: "Change", setup: claude, seat: "lend", press: ["[data-action=change-seat]"], about: "Change, from step 5: the question again, the answer as it was. Continue or Esc goes back to the steps." },
  { id: "register", group: "Your agent", name: "Not registered yet", setup: claude, click: true, register: true, about: "Paired, but the seat isn't registered as an agent yet." },
  { id: "start", group: "Your agent", name: "Set up", setup: paired, box: "stopped", about: "The five steps done: the agent's own face, grey until it runs. Press Start and it lights up." },
  { id: "starting", group: "Your agent", name: "Starting", setup: paired, box: "stopped", click: true, hang: ["box_start"], about: "The box starting." },
  { id: "done", group: "Your agent", name: "Running", setup: paired, box: "running", about: "Lit: it runs. Done closes the window onto the panel." },
  { id: "error-docker", group: "If a step fails", name: "Docker's download", setup: none, click: true, fail: { docker_install: "Docker's download answered 503 Service Unavailable. Try again in a few minutes." }, about: "The longest foot there is: Docker's terms line and an error over the button." },
  { id: "error-expired", group: "If a step fails", name: "Code ran out", setup: claude, click: true, fail: { box_pair: "pairing code expired before it was signed" }, about: "Five minutes passed before the wallet approved: the button asks for a new code." },
  { id: "error-claude", group: "If a step fails", name: "Code turned down", setup: agent, click: true, fail: { box_sign_in: "Login failed: Request failed with status code 400" }, about: "Claude Code didn't take the code, as when it's mistyped or from an older page: Connect again opens a new page." },
  { id: "error", group: "If a step fails", name: "Out of disk space", setup: docker, click: true, fail: { box_pull: "Error: no space left on device" }, about: "A failed step says what happened and what to do, under the button." },
];

/** The states one computer meets: a Mac's or a PC's. */
export const statesFor = (os) => STATES.filter((state) => !state.os || state.os === os);

/** What WebView2 says it is, on Windows 11: the setup page's words follow it. */
const WINDOWS_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0";

/**
 * Readies setup-state.html for one state, before the setup page's own script runs. The agent it pairs is the
 * fixtures' first seat, with its own face, when this checkout has read a wallet; setup needs none of the rest.
 */
export function stage(id, theme, os, fixtures) {
  const s = STATES.find((state) => state.id === id) ?? STATES[0];
  if (os === "windows") Object.defineProperty(navigator, "userAgent", { value: WINDOWS_AGENT });
  // past the first screen, but on it
  try { if (s.intro) localStorage.removeItem("imd-agents:setup-begun"); else localStorage.setItem("imd-agents:setup-begun", "1"); } catch {}
  // where the seat was said to be: in the wallet, unless the state asks again
  const seat = "seat" in s ? s.seat : "own";
  try { if (seat) localStorage.setItem("imd-agents:seat", seat); else localStorage.removeItem("imd-agents:seat"); } catch {}
  installMock({ fixtures: fixtures ?? { api: {}, svg: {} }, scenario: { box: s.box ?? "no-docker", linked: [], watching: [], setup: s.setup, fail: s.fail, pending: s.pending } });
  const invoke = window.__TAURI_INTERNALS__.invoke;
  let registered = false;
  let started = false;
  window.__TAURI_INTERNALS__.invoke = async (cmd, args, options) => {
    // the window fits its page, as the app's does: the review page sizes the frame
    if (cmd === "fit_setup") { parent.postMessage({ fit: Math.min(900, Math.max(200, args.height)) }, location.origin); return null; }
    if (s.hang?.includes(cmd)) return new Promise(() => {});
    if (s.resolve?.includes(cmd)) return null;
    // the disk: plenty, unless the state says otherwise
    if (cmd === "free_space") return s.free ?? 120e9;
    // Start, pressed here, runs the box
    if (cmd === "box_start") { started = true; return null; }
    if (cmd === "box_pair" && s.register) { registered = true; return { register: "https://imd.fun/register" }; }
    // the code's own record: it ends five minutes from now, the network's default
    if (cmd === "api_get" && /^\/pair\/[A-Z2-9]+$/.test(args.path)) return { status: 200, body: { expiresAt: new Date(Date.now() + 299_000).toISOString() } };
    // imdLend's page opens, with the code on the clipboard
    if (cmd === "open_lend") return true;
    const answer = await invoke(cmd, args, options);
    if (cmd === "box_state" && started) return { ...answer, state: "running", device_key: D };
    return cmd === "box_setup_state" && registered ? { ...answer, device_key: D } : answer;
  };
  // the page follows the computer's appearance; the review page sets the one it shows
  if (theme) forceTheme(theme);
  if (new URLSearchParams(location.search).has("shot")) holdStill(document.getElementById("setup"));
  // once the page has looked at this computer, press and say what the app would to get here
  const go = () => {
    const button = document.querySelector("#setup [data-action=step]");
    if (!button) return void setTimeout(go, 40);
    if (s.click) button.click();
    if (s.words) setTimeout(() => window.__emit("setup-step-progress", { step: s.words[0], words: s.words[1] }), 60);
    if (s.code) return void paste();
    setTimeout(ready, 100);
  };
  // a code pasted from Claude's page once its field is there, and handed over if the state says so
  const paste = () => {
    const field = document.querySelector("#setup [data-field=code]");
    if (!field) return void setTimeout(paste, 40);
    field.value = s.code;
    field.dispatchEvent(new Event("input", { bubbles: true }));
    if (s.send) setTimeout(() => document.querySelector("#setup [data-action=signin-code]")?.click(), 60);
    setTimeout(ready, 160);
  };
  const drawn = () => (document.getElementById("setup").childElementCount ? ready() : setTimeout(drawn, 40));
  // each selector clicked once it's there, in turn
  const press = (selectors) => {
    if (!selectors.length) return void setTimeout(ready, 100);
    const target = document.querySelector(`#setup ${selectors[0]}`);
    if (!target) return void setTimeout(() => press(selectors), 40);
    target.click();
    setTimeout(() => press(selectors.slice(1)), 60);
  };
  setTimeout(s.press ? () => press(s.press) : s.click || s.words ? go : drawn, 0);
}
