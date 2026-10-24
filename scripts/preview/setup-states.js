// Every state of the setup window, in the order a new Mac or PC meets them, for setup-review.html to page through.
// Each opens the real setup page (setup-state.html) with the Rust side stood in for, then presses and says
// what the app would to get there: `click` presses the button, `words` is the app's progress line for a step,
// `hang` keeps a command waiting, `resolve` answers one at once, `fail` makes one fail as Docker would. A state
// with `os` is only that computer's.
import { installMock } from "./mock.mjs";

const E = "e".padEnd(64, "0"); // a box with its key, not paired yet
const D = "d5e40d01".padEnd(64, "0"); // the mock's paired box: Agent #12
const none = { docker: "missing", restart_ahead: false, image: false, worker: false, claude: false, device_key: null };
const docker = { ...none, docker: "running" };
const box = { ...docker, image: true };
const agent = { ...box, worker: true, device_key: E };
const claude = { ...agent, claude: true };
const paired = { ...claude, device_key: D };

export const STATES = [
  { id: "intro", group: "Opening", name: "First screen", setup: none, intro: true, about: "What it is, why it's safe and what it needs. Press Continue: the button travels to its place on the steps." },
  { id: "intro-short", group: "Opening", name: "Short of space", setup: none, intro: true, free: 3.2e9, about: "The disk is read, not asked about: a Mac short of room hears it here, before anything downloads." },
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
  { id: "claude-waiting", group: "Connect Claude", name: "Waiting for sign-in", setup: agent, click: true, about: "Terminal opens Claude's sign-in inside the box. It says to choose No, exit when Claude asks about trusting the folder." },
  { id: "pair", group: "Connect IMD Agent", name: "Connect IMD Agent", setup: claude, about: "Pairs this box with an agent seat, approved by the wallet that holds it." },
  { id: "pair-code", group: "Connect IMD Agent", name: "Pairing code", setup: claude, click: true, about: "The pairing page opened in the browser. Enter opens it again, Esc cancels." },
  { id: "register", group: "Your agent", name: "Not registered yet", setup: claude, click: true, register: true, about: "Paired, but the seat isn't registered as an agent yet." },
  { id: "start", group: "Your agent", name: "Set up", setup: paired, box: "stopped", about: "The five steps done: the agent's own face, grey until it runs. Press Start and it lights up." },
  { id: "starting", group: "Your agent", name: "Starting", setup: paired, box: "stopped", click: true, hang: ["box_start"], about: "The box starting." },
  { id: "done", group: "Your agent", name: "Running", setup: paired, box: "running", about: "Lit: it runs. Done closes the window onto the panel." },
  { id: "error-docker", group: "If a step fails", name: "Docker's download", setup: none, click: true, fail: { docker_install: "Docker's download answered 503 Service Unavailable. Try again in a few minutes." }, about: "The longest foot there is: Docker's terms line and an error over the button." },
  { id: "error", group: "If a step fails", name: "Out of disk space", setup: docker, click: true, fail: { box_pull: "Error: no space left on device" }, about: "A failed step says what happened and what to do, under the button." },
];

/** The states one computer meets: a Mac's or a PC's. */
export const statesFor = (os) => STATES.filter((state) => !state.os || state.os === os);

/** What WebView2 says it is, on Windows 11: the setup page's words follow it. */
const WINDOWS_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0";

/** Readies setup-state.html for one state, before the setup page's own script runs. */
export function stage(id, theme, os) {
  const s = STATES.find((state) => state.id === id) ?? STATES[0];
  if (os === "windows") Object.defineProperty(navigator, "userAgent", { value: WINDOWS_AGENT });
  // past the first screen, but on it
  try { if (s.intro) localStorage.removeItem("imd-agents:setup-begun"); else localStorage.setItem("imd-agents:setup-begun", "1"); } catch {}
  installMock({ fixtures: { api: {}, svg: {} }, scenario: { box: s.box ?? "no-docker", linked: [], watching: [], setup: s.setup, fail: s.fail }, owner: null, scheme: theme ?? "light" });
  // the setup window has no desktop behind it
  document.addEventListener("DOMContentLoaded", () => { document.documentElement.style.background = ""; });
  const invoke = window.__TAURI_INTERNALS__.invoke;
  let registered = false;
  let started = false;
  window.__TAURI_INTERNALS__.invoke = async (cmd, args, options) => {
    // the agents' own faces, from the fixtures the panel's preview reads, when this machine has them
    if (cmd === "agent_svg") return fetch("./fixtures.json").then((r) => r.json()).then((f) => f.svg?.[args.tokenId] ?? null).catch(() => null);
    // the window fits its page, as the app's does: the review page sizes the frame
    if (cmd === "fit_setup") { parent.postMessage({ fit: Math.min(900, Math.max(200, args.height)) }, location.origin); return null; }
    if (s.hang?.includes(cmd)) return new Promise(() => {});
    if (s.resolve?.includes(cmd)) return null;
    // the disk: plenty, unless the state says otherwise
    if (cmd === "free_space") return s.free ?? 120e9;
    // Start, pressed here, runs the box
    if (cmd === "box_start") { started = true; return null; }
    if (cmd === "box_pair" && s.register) { registered = true; return { register: "https://imd.fun/register" }; }
    const answer = await invoke(cmd, args, options);
    if (cmd === "box_state" && started) return { ...answer, state: "running", device_key: D };
    return cmd === "box_setup_state" && registered ? { ...answer, device_key: D } : answer;
  };
  if (theme) {
    // the page follows the Mac's appearance; here it takes the one the review page shows, again whenever Vite swaps the styles
    const force = () => {
      document.documentElement.style.colorScheme = theme;
      for (const sheet of document.styleSheets) {
        let rules;
        try { rules = sheet.cssRules; } catch { continue; }
        for (const rule of rules) {
          if (rule instanceof CSSMediaRule && rule.conditionText.includes("prefers-color-scheme")) rule.media.mediaText = rule.conditionText.includes("dark") === (theme === "dark") ? "all" : "not all";
        }
      }
    };
    new MutationObserver(force).observe(document.head, { childList: true, subtree: true, characterData: true });
    force();
  }
  // once the page has looked at this computer, press and say what the app would to get here
  if (s.click || s.words) {
    const go = () => {
      const button = document.querySelector("#setup [data-action=step]");
      if (!button) return void setTimeout(go, 40);
      if (s.click) button.click();
      if (s.words) setTimeout(() => window.__emit("setup-step-progress", { step: s.words[0], words: s.words[1] }), 60);
    };
    setTimeout(go, 0);
  }
}
