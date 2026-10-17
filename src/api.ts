import { invoke } from "@tauri-apps/api/core";
export { getVersion as appVersion } from "@tauri-apps/api/app";
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

/** Something that just happened in the swarm: a step started or accepted, a job posted, an agent joined, a site went up. */
export type SwarmEvent = { kind: string; at: string; tokenId?: number | null; step?: string; state?: string; jobId?: string; objective?: string; ensName?: string };

/** The whole swarm right now: agents online, agents at work, and what just happened, newest first. */
export async function swarm(): Promise<{ online: number; working: number; events: SwarmEvent[] } | null> {
  const answer = await get<{ health?: { agentsOnline: number; workingNow: number }; events?: SwarmEvent[] }>("/swarm");
  const health = answer.status === 200 ? answer.body?.health : null;
  return health ? { online: health.agentsOnline, working: health.workingNow, events: answer.body?.events ?? [] } : null;
}

/** Which seat a device serves, from the network's own record of it. */
export async function deviceSeat(deviceKey: string): Promise<string | null> {
  const answer = await get<Standing>(`/workers/${deviceKey}/standing?queue=0`);
  return answer.status === 200 ? answer.body?.enrollment?.tokenId ?? null : null;
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
  return answer.status === 200 ? answer.body?.earnings ?? [] : [];
}

export const agentSvg = (tokenId: string) => invoke<string | null>("agent_svg", { tokenId });

export const boxState = async (): Promise<Box> => {
  const raw = await invoke<{ state: Box["state"]; installed: boolean; device_key: string | null }>("box_state");
  return { state: raw.state, installed: raw.installed, deviceKey: raw.device_key };
};
export const boxStart = (runtime: string) => invoke<void>("box_start", { runtime });
export const boxStop = () => invoke<void>("box_stop");
export const boxRestart = () => invoke<void>("box_restart");

/** How far setting this computer's box up has got. */
export type Setup = { docker: "missing" | "stopped" | "running"; image: boolean; worker: boolean; claude: boolean; device_key: string | null };
export const boxSetupState = () => invoke<Setup>("box_setup_state");
/** Docker Desktop: its download page if it is not installed, the app if it is not running. */
export const dockerOpen = () => invoke<void>("docker_open");
export const boxPull = () => invoke<void>("box_pull");
/** Docker Desktop installed for this computer: downloaded, checked and installed by Docker's own installer on a Mac. */
export const dockerInstall = () => invoke<void>("docker_install");
/** The setup window: opened, or brought to the front; closed when setup is done, onto the panel. */
export const openSetup = () => invoke<void>("open_setup");
export const setupDone = () => invoke<void>("setup_done");
export const openDockerTerms = () => invoke<void>("open_docker_terms");
export const boxInstall = () => invoke<void>("box_install");
export const boxSignIn = () => invoke<void>("box_sign_in");
/** Pairs the box; its code arrives first as the `box-pairing` event. */
export const boxPair = () => invoke<{ token_id: string | null; register: string | null }>("box_pair");
export const boxPairCancel = () => invoke<void>("box_pair_cancel");
export const openPairing = (url: string) => invoke<void>("open_pairing", { url });
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

/** An ENS name's wallet, as the explorer's own search finds it: null when it finds none. */
export async function ensWallet(name: string): Promise<string | null> {
  const answer = await invoke<Answer<{ groups?: Array<{ key: string; hits?: Array<{ meta?: string; href?: string }> }> }>>("explorer_get", { path: `/api/search?q=${name}` });
  const hit = answer.body?.groups?.find((g) => g.key === "go")?.hits?.find((h) => h.meta === "wallet" && h.href?.startsWith("/wallet/"));
  const wallet = hit?.href?.slice("/wallet/".length).toLowerCase();
  return wallet && /^0x[0-9a-f]{40}$/.test(wallet) ? wallet : null;
}
export const setTrayState = (state: string) => invoke<void>("set_tray_state", { state });
