import { invoke } from "@tauri-apps/api/core";
import type { Box, Earning, Standing } from "./model";

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

export type SeatRecord = { owner: string | null; accepted: number; work: Array<{ submittedAt?: string }> };

/** The seat's record with its newest work, enough to count today's. */
export async function seatRecord(tokenId: string): Promise<SeatRecord | null> {
  const answer = await get<SeatRecord>(`/seats/${tokenId}?work=200&reviews=0&collaborators=0`);
  return answer.status === 200 ? answer.body : null;
}

/** Which seat a device serves, from the network's own record of it. */
export async function deviceSeat(deviceKey: string): Promise<string | null> {
  const answer = await get<Standing>(`/workers/${deviceKey}/standing?queue=0`);
  return answer.status === 200 ? answer.body?.enrollment?.tokenId ?? null : null;
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

export type LinkStart = { code: string; expiresAt: string; relayOrigin: string };
export const linkStart = () => invoke<LinkStart>("link_start");
export const linkPoll = (code: string) => invoke<Answer<{ status: "pending" | "linked" | "expired"; wallet: string | null }>>("link_poll", { code });
export const linkReopen = (code: string) => invoke<void>("link_reopen", { code });
export const seatPause = (tokenId: string, paused: boolean, relayOrigin: string) =>
  invoke<Answer<{ paused?: boolean; error?: string }>>("seat_pause", { tokenId, paused, relayOrigin });
export const unlink = (relayOrigin: string) => invoke<void>("unlink", { relayOrigin });

export const openExplorer = (path: string) => invoke<void>("open_explorer", { path });
export const hidePanel = () => invoke<void>("hide_panel");
export const quit = () => invoke<void>("quit");
export const setTrayState = (state: string) => invoke<void>("set_tray_state", { state });
