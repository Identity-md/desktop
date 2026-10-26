import { invoke } from "@tauri-apps/api/core";
export { getVersion as appVersion } from "@tauri-apps/api/app";
import type { Span, Terms } from "./lending";
import { sumOf, worthOf, type Box, type Earning, type ReleaseRow, type RewardValue, type Standing, type WorkRow } from "./model";

/**
 * Everything the panel asks of the app's Rust side. The page itself reaches no network, holds no key
 * and starts no process: it asks for a path on the IMD API, a pause signed by this computer's key, or
 * the box started or stopped.
 */

type Answer<T> = { status: number; body: T | null };

export const get = <T>(path: string) => invoke<Answer<T>>("api_get", { path });

export type PairWallet = { tokens: Array<{ tokenId: string; device: { key: string; online: boolean } | null }> };

export async function walletSeats(wallet: string): Promise<PairWallet["tokens"]> {
  const answer = await get<PairWallet>(`/pair/wallet/${wallet}`);
  return answer.status === 200 && answer.body ? answer.body.tokens ?? [] : [];
}

export type SeatRecord = {
  owner: string | null;
  /** Whether a device of the seat is up, as the network last saw it. */
  online?: boolean;
  accepted: number;
  rejected?: number;
  failed?: number;
  runtimes?: Array<{ id: string; premiumModel?: { model: string; effort?: string } | null }>;
  work: WorkRow[];
};

/** The seat's record with its newest `rows` of work: a hundred count today's, five hundred two weeks'. */
export async function seatRecord(tokenId: string, rows = 100): Promise<SeatRecord | null> {
  const answer = await get<SeatRecord>(`/seats/${tokenId}?work=${rows}&reviews=0&collaborators=0`);
  return answer.status === 200 ? answer.body : null;
}

/**
 * A seat looked up to watch it: its record; "none" when the network has none, so it never ran an agent; or
 * "unreached" when the read failed, which says nothing about the seat.
 */
export async function seatLookup(tokenId: string): Promise<SeatRecord | "none" | "unreached"> {
  const answer = await get<SeatRecord>(`/seats/${tokenId}?work=0&reviews=0&collaborators=0`).catch(() => null);
  if (answer?.status === 404) return "none";
  return answer?.status === 200 && answer.body ? answer.body : "unreached";
}

/** Something that just happened in the swarm: a step started or accepted, a job posted, an agent joined, a site went up. */
export type SwarmEvent = { kind: string; at: string; tokenId?: number | null; step?: string; state?: string; jobId?: string; objective?: string; ensName?: string };

/** The whole swarm right now: agents online, agents at work, and what just happened, newest first. */
export async function swarm(): Promise<{ online: number; working: number; events: SwarmEvent[] } | null> {
  const answer = await get<{ health?: { agentsOnline: number; workingNow: number }; events?: SwarmEvent[] }>("/swarm");
  const health = answer.status === 200 ? answer.body?.health : null;
  return health ? { online: health.agentsOnline, working: health.workingNow, events: answer.body?.events ?? [] } : null;
}

/**
 * Which seat a device serves, from the network's own record of it: null when it serves none, as when it never paired,
 * was unlinked, or its seat moved to another wallet, which retires its pairing. A read that fails throws, so a busy
 * network isn't taken for a box with no seat.
 */
export async function deviceSeat(deviceKey: string): Promise<string | null> {
  const answer = await get<Standing>(`/workers/${deviceKey}/standing?queue=0`);
  if (answer.status === 404) return null;
  if (answer.status !== 200) throw new Error(`the network answered ${answer.status}`);
  const enrollment = answer.body?.enrollment;
  return enrollment?.status === "active" ? enrollment.tokenId : null;
}

/** Sepolia: a testnet coin is earned, never ready to claim, since claiming it is worth nothing. */
const TESTNETS = new Set([11155111]);

/**
 * What a wallet has ready to claim and what that is worth, as the explorer's Earned box says it: a
 * total only once every reward has a value, since a sum of the first few read looks final and is not.
 */
export async function readyToClaim(wallet: string, rewards: Earning[]): Promise<{ count: number; usd: number | null } | null> {
  const [claim, value] = await Promise.all([
    invoke<Answer<{ claimable: string[] | null }>>("explorer_get", { path: `/api/earned?wallet=${wallet}` }),
    invoke<Answer<{ values: Record<string, RewardValue> | null; missing?: number }>>("explorer_get", { path: `/api/earned/value?wallet=${wallet}` }),
  ]);
  const ids = claim.status === 200 ? claim.body?.claimable : null;
  if (!ids) return null;
  const testnet = new Set(rewards.filter((r) => TESTNETS.has(r.chainId)).map((r) => r.launchId));
  const ready = ids.filter((id) => !testnet.has(id));
  const values = value.status === 200 ? value.body?.values : null;
  const complete = values && !(value.body?.missing ?? 0);
  return { count: ready.length, usd: complete ? sumOf(ready.map((id) => worthOf(values[id])))?.usd ?? 0 : null };
}

export async function earnings(wallet: string): Promise<Earning[]> {
  const answer = await get<{ earnings: Earning[] }>(`/wallets/${wallet}/earnings?limit=50`);
  // a launch still on its way has no coin yet (its token address is null): it shows once it launches
  return answer.status === 200 ? (answer.body?.earnings ?? []).filter((e) => e.token?.address) : [];
}

export const agentSvg = (tokenId: string) => invoke<string | null>("agent_svg", { tokenId });

export const boxState = async (): Promise<Box> => {
  const raw = await invoke<{ state: Box["state"]; installed: boolean; device_key: string | null }>("box_state");
  return { state: raw.state, installed: raw.installed, deviceKey: raw.device_key };
};
export const boxStart = (runtime: string) => invoke<void>("box_start", { runtime });
export const boxStop = () => invoke<void>("box_stop");
/** Takes this computer off its seat: its box removed, then `imd unlink`, signed with its own key. */
export const boxUnlink = () => invoke<void>("box_unlink");
export const boxRestart = (runtime: string) => invoke<void>("box_restart", { runtime });

/** How far setting this computer's box up has got. On Windows Docker can wait on a restart, which finishes installing WSL. */
export type Setup = { docker: "missing" | "stopped" | "running" | "restart" | "restart-wsl"; restart_ahead: boolean; image: boolean; worker: boolean; claude: boolean; device_key: string | null };
export const boxSetupState = () => invoke<Setup>("box_setup_state");
/** Docker Desktop: its download page if it is not installed, the app if it is not running. */
export const dockerOpen = () => invoke<void>("docker_open");
export const boxPull = () => invoke<void>("box_pull");
/** Docker Desktop installed for this computer: downloaded, checked and installed by Docker's own installer on a Mac and on
 * Windows, where WSL comes first. True when Windows needs a restart before Docker. */
export const dockerInstall = () => invoke<boolean>("docker_install");
/** Windows restarted, while the restart WSL needs is still to come; setup opens again after it. */
export const restartPc = () => invoke<void>("restart_pc");
/** Open at login, on or off. */
export const setOpenAtLogin = (on: boolean) => invoke<void>("set_open_at_login", { on });
/** The setup window: opened, or brought to the front; closed when setup is done, onto the panel. */
export const openSetup = () => invoke<void>("open_setup");
export const setupDone = () => invoke<void>("setup_done");
export const openDockerTerms = () => invoke<void>("open_docker_terms");
export const fitSetup = (height: number) => invoke<void>("fit_setup", { height });
export const openSetupHelp = () => invoke<void>("open_setup_help");
/** imd.fun's page of agent seats, for someone who doesn't hold one yet. */
export const openSeats = () => invoke<void>("open_seats");
/** The sound for an agent taking a job, or for one accepted. */
export const playSound = (kind: "taken" | "paid") => invoke<void>("play_sound", { kind });
/** The app's look: light, dark, or the computer's own. */
export const setTheme = (theme: Theme) => invoke<void>("set_theme", { theme });
export type Theme = "system" | "light" | "dark";
/** Claude's plans: every paid one comes with Claude Code, which the box thinks with. */
export const openClaudePlans = () => invoke<void>("open_claude_plans");
/** Bytes free on the disk Docker and the box will use, or null where the app can't tell. */
export const freeSpace = () => invoke<number | null>("free_space");
export const boxInstall = () => invoke<void>("box_install");
export const boxSignIn = () => invoke<void>("box_sign_in");
/** Pairs the box, then starts it; its code arrives first as the `box-pairing` event, and its end as `box-pair-ended`. */
export const boxPair = (runtime: string) => invoke<{ token_id: string | null; register: string | null }>("box_pair", { runtime });
/** The pairing under way, if setup is opened again while its code waits. */
export const pairingPending = () => invoke<{ code: string; url: string } | null>("pairing_pending");
export const boxPairCancel = () => invoke<void>("box_pair_cancel");
export const openPairing = (url: string) => invoke<void>("open_pairing", { url });
/** The network's pairing link onto the clipboard, for whoever holds the seat to approve from their own wallet. */
export const copyPairing = (url: string) => invoke<void>("copy_pairing", { url });
/** When a pairing code runs out, from the network's record of it, or null where it can't say. */
export async function pairingExpires(code: string): Promise<number | null> {
  const answer = await get<{ expiresAt?: string }>(`/pair/${code}`);
  const at = answer.status === 200 ? Date.parse(answer.body?.expiresAt ?? "") : Number.NaN;
  return Number.isFinite(at) ? at : null;
}
/**
 * imdLend, where seats are lent, which the network doesn't run: its pairing page, taking the code from its link; a new
 * listing for a seat; the lender's vaults; the borrower's lendings; or its rewards, claimed for a vault's owner and
 * operator at once.
 */
export const openLend = (page: "pair" | "list" | "vaults" | "run" | "rewards", of: { code?: string; seat?: string } = {}) =>
  invoke<void>("open_lend", { page, code: of.code ?? null, seat: of.seat ?? null });

/**
 * Whether a seat's holder is one of imdLend's vaults, from its code, checked against imdLend's market: its terms if so,
 * null when it isn't one. Neither ever changes. A read that fails throws, which says nothing either way.
 */
export const lendVault = (holder: string) => invoke<Terms | null>("lend_vault", { holder });
/** A seat's latest lending in a vault: null for a seat the vault never lent. A read that fails throws. */
export const lendSpan = (vault: string, seat: string) => invoke<Span | null>("lend_span", { vault, seat });
/** The worker's newest releases, from GitHub, as daemons update from them. */
export const workerReleases = () => invoke<Answer<ReleaseRow[]>>("worker_releases");

export type LinkStart = { code: string; expiresAt: string; relayOrigin: string };
export const linkStart = () => invoke<LinkStart>("link_start");
export const linkPoll = (code: string) => invoke<Answer<{ status: "pending" | "linked" | "expired"; wallet: string | null }>>("link_poll", { code });
export const linkReopen = (code: string) => invoke<void>("link_reopen", { code });
export const seatPause = (tokenId: string, paused: boolean, relayOrigin: string) =>
  invoke<Answer<{ paused?: boolean; error?: string }>>("seat_pause", { tokenId, paused, relayOrigin });
export const unlink = (relayOrigin: string) => invoke<void>("unlink", { relayOrigin });

export const openExplorer = (path: string) => invoke<void>("open_explorer", { path });
export const hidePanel = () => invoke<void>("hide_panel");
export const fitPanel = (height: number) => invoke<void>("fit_panel", { height });
export const quit = () => invoke<void>("quit");
/** A newer release's version, if there is one, and installing it now. */
export const updateCheck = () => invoke<string | null>("update_check");
export const updateInstall = () => invoke<void>("update_install");

/** An ENS name's wallet, as the explorer's own search finds it: null when it finds none, "unreached" when the read failed. */
export async function ensWallet(name: string): Promise<string | null | "unreached"> {
  const answer = await invoke<Answer<{ groups?: Array<{ key: string; hits?: Array<{ meta?: string; href?: string }> }> }>>("explorer_get", { path: `/api/search?q=${name}` }).catch(() => null);
  // 400 is this app's own refusal of what isn't a name: nothing found, not a read that failed
  if (answer?.status === 400) return null;
  if (answer?.status !== 200) return "unreached";
  const hit = answer.body?.groups?.find((g) => g.key === "go")?.hits?.find((h) => h.meta === "wallet" && h.href?.startsWith("/wallet/"));
  const wallet = hit?.href?.slice("/wallet/".length).toLowerCase();
  return wallet && /^0x[0-9a-f]{40}$/.test(wallet) ? wallet : null;
}
export const setTrayState = (state: string) => invoke<void>("set_tray_state", { state });
