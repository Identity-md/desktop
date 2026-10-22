/** What the app knows about one agent, gathered from the public API. Pure, so it can be tested. */

export type Standing = {
  enrollment: { status: string; tokenId: string } | null;
  presence: { connected: boolean; stale: boolean; connectedAt?: string; lastHeartbeatAt: string; daemonVersion?: string; runtimes?: Array<{ id: string }>; jail?: { ok: boolean; detail: string } | null } | null;
  standing: {
    working: number;
    pausedUntil: string | null;
    pausedFor?: string | null;
    pausedByOwnerAt?: string | null;
    running: Array<{ jobId: string; objective: string; nodeKey: string | null; since: string }>;
    consecutiveFailures?: number;
    recentFailures?: Array<Record<string, unknown>>;
  };
};

export type Agent = {
  tokenId: string;
  /** The wallet that holds it, of those this app watches. */
  wallet: string;
  online: boolean;
  standing: Standing | null;
  today: number | null;
  accepted: number | null;
};

/** The box on this computer, as the app reads it from Docker. */
export type Box = { state: "running" | "stopped" | "docker-down" | "no-docker" | "starting" | "stopping"; installed: boolean; deviceKey: string | null };

export type Phase =
  | { kind: "working"; jobs: number }
  | { kind: "ready" }
  | { kind: "held" }
  | { kind: "paused"; until: Date }
  | { kind: "offline"; seen: Date | null }
  | { kind: "off" }
  | { kind: "changing"; words: string }
  | { kind: "docker-down" };

/** One agent's state, in the order that matters: away, held by its holder, paused by the network, at work, ready. */
export function phaseOf(agent: Agent, now = new Date()): Phase {
  const s = agent.standing;
  const presence = s?.presence ?? null;
  if (!presence || presence.stale || !presence.connected) {
    if (!agent.online) return { kind: "offline", seen: presence ? new Date(presence.lastHeartbeatAt) : null };
  }
  const working = s?.standing.working ?? 0;
  if (s?.standing.pausedByOwnerAt && working === 0) return { kind: "held" };
  const until = s?.standing.pausedUntil ? new Date(s.standing.pausedUntil) : null;
  if (until && until > now && working === 0) return { kind: "paused", until };
  if (working > 0) return { kind: "working", jobs: working };
  return { kind: "ready" };
}

/** The box's own state wins for this computer's agent: Docker closed, the box off, or between the two. */
export function localPhase(box: Box, agent: Agent | null, now = new Date()): Phase {
  if (box.state === "docker-down") return { kind: "docker-down" };
  if (box.state === "starting") return { kind: "changing", words: "Starting…" };
  if (box.state === "stopping") return { kind: "changing", words: "Stopping…" };
  if (box.state !== "running") return { kind: "off" };
  return agent ? phaseOf({ ...agent, online: true }, now) : { kind: "changing", words: "Connecting…" };
}

const STEP_NAMES: Record<string, string> = {
  oracle_assess: "Oracle question", design_critic: "Design review", site_content_check: "Site content check",
  adversarial_review: "Adversarial review", audit_judge: "Audit judging", build_contract_project: "Contract build",
  frontend_for_contract: "Frontend build", research_report: "Research report", manifest: "Launch manifest",
  build_website: "Website build", implement_contract: "Contract build", write_foundry_tests: "Contract tests",
  fix_findings: "Fixing findings", create_image: "Image", create_video: "Video",
};

/** A step's key in words: `site_content_check` is "Site content check". */
export function stepTitle(nodeKey: string | null): string {
  if (!nodeKey) return "A job";
  if (STEP_NAMES[nodeKey]) return STEP_NAMES[nodeKey]!;
  if (nodeKey.startsWith("audit_")) return capitalize(nodeKey.slice(6).replace(/_/g, " ")) + " audit";
  return capitalize(nodeKey.replace(/_/g, " "));
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** How long, in the largest unit that says it: "4 min", "2 hr 5 min", "3 days". */
export function elapsed(from: Date, now = new Date()): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - from.getTime()) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 48 * 60) return `${Math.floor(minutes / 60)} hr`;
  return `${Math.floor(minutes / 1440)} days`;
}

/** A compact age for a narrow column: "6m", "2h", "3d". */
export function shortAgo(from: Date, now = new Date()): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - from.getTime()) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 48 * 60) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / 1440)}d`;
}

export function ago(from: Date, now = new Date()): string {
  const text = elapsed(from, now);
  return text === "just now" ? text : `${text} ago`;
}

/** The line under an agent's name. */
export function statusLine(phase: Phase, agent: Agent | null, now = new Date()): string {
  switch (phase.kind) {
    case "working": {
      const job = agent?.standing?.standing.running[0];
      if (!job) return phase.jobs === 1 ? "Working" : `Working on ${phase.jobs} jobs`;
      return [job.nodeKey ? `Working on ${stepTitle(job.nodeKey)}` : "Working", elapsed(new Date(job.since), now)].join(" · ");
    }
    case "ready": {
      const runtime = agent?.standing?.presence?.runtimes?.[0]?.id;
      return runtime ? `Ready · ${capitalize(runtime)}` : "Ready";
    }
    case "held": return "Paused · takes no new work";
    case "paused": return `Paused by the network until ${phase.until.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
    case "offline": return phase.seen ? `Offline · last seen ${ago(phase.seen, now)}` : "Offline";
    case "off": return "Off";
    case "changing": return phase.words;
    case "docker-down": return "Docker isn't running";
  }
}

/** The dot on the mask: green on, blue changing, orange held up by the network, grey off or away. */
export function dotOf(phase: Phase): "on" | "changing" | "warn" | "off" {
  switch (phase.kind) {
    case "working": case "ready": return "on";
    case "changing": return "changing";
    case "paused": case "docker-down": return "warn";
    default: return "off";
  }
}

/** What the menu bar icon says for all of them together: an outdated worker wants its owner too. */
export function trayState(phases: Phase[], outdated = false): "working" | "attention" | "off" | "idle" {
  if (outdated || phases.some((p) => p.kind === "paused" || p.kind === "docker-down" || p.kind === "offline")) return "attention";
  if (phases.some((p) => p.kind === "working")) return "working";
  if (phases.length > 0 && phases.every((p) => p.kind === "off" || p.kind === "held")) return "off";
  return "idle";
}

/** Local midnight, `back` days before today's. */
export function dayStart(now: Date, back = 0): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - back);
}

const DAY = 86_400_000;

export type WorkRow = { jobId?: string; objective?: string; nodeKey?: string | null; status?: string; submittedAt?: string; acceptedAt?: string | null };

/**
 * Work accepted per day for the last `days` days, oldest first: each day the 24 hours that end that many
 * days before now, as the explorer counts them, so the two agree. When the rows stopped at the `cap`
 * asked for, the days they no longer reach whole are unknown: null, not zero.
 */
export function acceptedPerDay(rows: WorkRow[], days: number, now = new Date(), cap = Infinity): Array<number | null> {
  const counts: Array<number | null> = new Array(days).fill(0);
  const end = now.getTime();
  let oldest = Infinity;
  for (const row of rows) {
    const submitted = row.submittedAt ? Date.parse(row.submittedAt) : NaN;
    if (!Number.isNaN(submitted)) oldest = Math.min(oldest, submitted);
    const at = row.acceptedAt ? Date.parse(row.acceptedAt) : NaN;
    if (Number.isNaN(at) || at > end) continue;
    const back = Math.floor((end - at) / DAY);
    if (back < days) counts[days - 1 - back]! += 1;
  }
  if (rows.length >= cap && oldest !== Infinity) {
    // a day that began before the oldest row read may be missing rows older than it
    for (let i = 0; i < days; i++) if (end - (days - i) * DAY < oldest) counts[i] = null;
  }
  return counts;
}

/** Work accepted in the last 24 hours: the explorer's "accepted today". */
export function acceptedToday(rows: WorkRow[], now = new Date()): number {
  return rows.filter((row) => {
    const at = row.acceptedAt ? Date.parse(row.acceptedAt) : NaN;
    return at > now.getTime() - DAY && at <= now.getTime();
  }).length;
}

/** Of the work judged, the share accepted, as the explorer writes it: "94% of judged". */
export function judgedRate(accepted: number, rejected: number, failed: number): number | null {
  const judged = accepted + rejected + failed;
  return judged ? Math.round((accepted / judged) * 100) : null;
}

/** A model's id in words: `claude-fable-5-1` is "Claude Fable 5.1". Others as they are. */
export function modelName(id: string): string {
  const match = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(id);
  if (!match) return id;
  return `Claude ${capitalize(match[1]!)} ${match[2]}${match[3] ? `.${match[3]}` : ""}`;
}

/** A dollar or ether amount and what a reward is worth, as the explorer prices it (its `lib/money.ts`). */
export type Money = { eth: number; usd: number | null };
export type RewardValue = { now?: Money; sells?: Money; noBids?: true; atClaim?: Money };

/**
 * What a reward is worth as it can be had: nothing where nobody has bought into its pool, what selling
 * it all fetches where that is under four fifths of its price, else its price. Claimed, what it was
 * worth when claimed.
 */
export function worthOf(v: RewardValue | undefined): Money | undefined {
  if (!v) return undefined;
  if (v.noBids) return { eth: 0, usd: v.now?.usd === null ? null : 0 };
  if (v.atClaim) return v.atClaim;
  const thin = v.now && v.sells && v.now.usd && v.sells.usd !== null && v.sells.usd < v.now.usd * 0.8 ? v.sells : null;
  return thin ?? v.now;
}

export function sumOf(list: Array<Money | undefined>): Money | null {
  const known = list.filter((m): m is Money => Boolean(m));
  if (!known.length) return null;
  return known.reduce<Money>((a, m) => ({ eth: a.eth + m.eth, usd: a.usd === null || m.usd === null ? null : a.usd + m.usd }), { eth: 0, usd: 0 });
}

/** Dollars to read: cents under a thousand, whole dollars over, and a floor for dust. */
export function usdText(usd: number): string {
  if (usd < 0.01) return "<$0.01";
  if (usd < 1000) return `$${usd.toFixed(2)}`;
  return `$${Math.round(usd).toLocaleString("en-US")}`;
}

/** Several agents' days added up: a day unknown for one is unknown for all. */
export function addDays(series: Array<Array<number | null>>, days: number): Array<number | null> {
  return Array.from({ length: days }, (_, i) =>
    series.reduce<number | null>((sum, one) => (sum === null || one[i] === null || one[i] === undefined ? null : sum + one[i]!), 0));
}

/** Since when every agent that is up has been up: the newest connection among them. Null when none is. */
export function upSince(agents: Array<{ standing: Standing | null }>, phases: Phase[]): Date | null {
  let newest: number | null = null;
  agents.forEach((agent, i) => {
    const presence = agent.standing?.presence;
    const kind = phases[i]?.kind;
    if (!presence?.connectedAt || !presence.connected || presence.stale) return;
    if (kind === undefined || kind === "offline" || kind === "off" || kind === "docker-down" || kind === "changing") return;
    const at = new Date(presence.connectedAt).getTime();
    if (!Number.isNaN(at)) newest = newest === null ? at : Math.max(newest, at);
  });
  return newest === null ? null : new Date(newest);
}

/** How long a run has lasted, in two units at most: "12m", "5h 24m", "3d 4h". */
export function runLength(from: Date, now = new Date()): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - from.getTime()) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export type Earning = {
  launchId: string;
  at: string;
  chainId: number;
  amount: string;
  token: { address: string; symbol: string; name: string; decimals: number };
  launch?: { logo?: string | null } | null;
};

/** A reward's amount in plain words: 157,480 or 1.2M or 0.04, never a wall of digits. */
export function amountWords(raw: string, decimals: number): string {
  let value: number;
  try {
    const big = BigInt(raw);
    const scale = 10n ** BigInt(Math.max(0, decimals - 6));
    value = Number(big / scale) / 10 ** Math.min(6, decimals);
  } catch {
    return "0";
  }
  if (value >= 1e9) return `${trim(value / 1e9)}B`;
  if (value >= 1e6) return `${trim(value / 1e6)}M`;
  if (value >= 1e4) return `${trim(value / 1e3)}K`;
  if (value >= 1) return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return value === 0 ? "0" : String(Number(value.toPrecision(2)));
}

const trim = (n: number) => (n >= 100 ? Math.round(n).toString() : n.toFixed(1).replace(/\.0$/, ""));

export type ReleaseRow = { tag_name: string; published_at: string | null; draft: boolean; prerelease: boolean };

/** How long a new release is given before a machine still on the one before counts as behind: workers on auto-update take it within about half an hour. */
const GRACE = 2 * 3_600_000;

/**
 * The worker's current release, as a daemon reports one (`0.1.0+f0753cb7`), and every version that does
 * not count as behind: the newest, and for its first two hours the one before, as the explorer reckons it.
 */
export function currentWorker(rows: ReleaseRow[], now = new Date()): { newest: string; accepted: string[]; order: string[] } | null {
  const releases = rows
    .filter((r) => !r.draft && !r.prerelease && r.published_at)
    .flatMap((r) => {
      const m = /^worker-v(.+)-([0-9a-f]{8,})$/.exec(r.tag_name);
      return m ? [{ version: `${m[1]}+${m[2]!.slice(0, 8)}`, at: Date.parse(r.published_at!) }] : [];
    })
    .sort((a, b) => b.at - a.at);
  const [newest, before] = releases;
  if (!newest) return null;
  const fresh = now.getTime() - newest.at < GRACE;
  return { newest: newest.version, accepted: fresh && before ? [newest.version, before.version] : [newest.version], order: releases.map((r) => r.version) };
}

/** Whether release `a` ("0.1.2" of "0.1.2+d1681b55") is above `b`, as the explorer's `newerRelease` reads them. */
export function newerRelease(a: string, b: string): boolean {
  const parts = (version: string) => (version.split("+")[0] ?? "").split(".").map((part) => Number.parseInt(part, 10) || 0);
  const [left, right] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    if ((left[i] ?? 0) !== (right[i] ?? 0)) return (left[i] ?? 0) > (right[i] ?? 0);
  }
  return false;
}

/** How far behind the newest worker a version is, in releases, as a person says it: "2 updates behind". */
export function behindWords(version: string, order: string[]): string {
  const behind = order.indexOf(version);
  if (behind < 0) return "Many updates behind";
  return behind === 1 ? "1 update behind" : `${behind} updates behind`;
}

/** Why an agent's last job failed, in a line, from whatever its standing calls it. */
export function failureWords(failure: Record<string, unknown> | undefined): string | null {
  if (!failure) return null;
  for (const key of ["reason", "error", "message", "detail"]) {
    const value = failure[key];
    if (typeof value === "string" && value.trim()) return value.trim().split("\n")[0]!.slice(0, 140);
  }
  return null;
}

/**
 * Why an agent takes no oracle, research or contract jobs, in its worker's own words: where its read jail
 * does not hold, the worker withholds that work rather than run it unjailed. Null when the jail holds, or
 * when the network did not say.
 */
export function jailWords(standing: Standing | null): string | null {
  const jail = standing?.presence?.jail;
  if (!jail || jail.ok) return null;
  return jail.detail.trim() || "its sandbox cannot start";
}

/**
 * Whether an agent took a job since the last read: a job on its list that wasn't there before. An agent
 * not read before has nothing to compare, so a newly watched one never counts.
 */
export function tookJob(before: Map<string, string[]> | null, now: Map<string, string[]>): boolean {
  if (!before) return false;
  return [...now].some(([tokenId, jobs]) => before.has(tokenId) && jobs.some((job) => !before.get(tokenId)!.includes(job)));
}

/**
 * What was typed to watch, in pieces: wallets, ENS names and seat numbers, in any mix, apart by commas
 * or spaces ("14,25", "14, 25", "14 25", "#14"), each once; and the first piece that is none of them.
 */
export function watchParts(value: string): { parts: string[]; odd: string | null } {
  const pieces = value.toLowerCase().split(/[\s,]+/).map((part) => part.replace(/^#/, "")).filter(Boolean);
  const parts = [...new Set(pieces.map((part) => (/^\d+$/.test(part) ? String(Number(part)) : part)))];
  const odd = parts.find((part) => !/^[1-9]\d{0,5}$/.test(part) && !/^0x[0-9a-f]{40}$/.test(part) && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(part)) ?? null;
  return { parts, odd };
}

/**
 * Why an agent's sandbox won't start, and the one command that fixes it on its machine, from the
 * worker's own words: the explorer's notice reads them the same way. `imd sandbox` installs what is
 * missing and lifts the kernel's restriction for bubblewrap alone, so it answers most of them.
 */
export function jailFix(detail: string): { why: string; command: string | null } {
  if (/predates the jail/.test(detail)) return { why: "Its Claude Code is too old for the sandbox these jobs run in.", command: "claude update" };
  if (/needs (bwrap|socat)/.test(detail)) return { why: "Its machine is missing the sandbox these jobs run in.", command: "sudo imd sandbox" };
  if (/apparmor_restrict_unprivileged_userns|unprivileged_userns_clone|RTM_NEWADDR|new namespace|setting up uid map|nested userns/.test(detail)) {
    return { why: "Its machine blocks the sandbox these jobs run in.", command: "sudo imd sandbox" };
  }
  if (/hides \/proc|mount proc/.test(detail)) return { why: "Its worker runs in a container, where the sandbox these jobs run in can't start. Run it on the machine itself or in a VM.", command: null };
  if (/Windows/.test(detail)) return { why: "The sandbox these jobs run in doesn't work on Windows. Run the worker under WSL.", command: null };
  return { why: "The sandbox these jobs run in won't start on its machine.", command: "imd update" };
}

/**
 * A failed setup step in plain words: what happened and what to do, from what Docker or the worker said.
 * A failure it does not know keeps Docker's own most telling line, the error and not its "Run 'docker run
 * --help'" after it.
 */
export function setupErrorWords(raw: string): string {
  const text = raw.trim();
  const known: Array<[RegExp, string]> = [
    // Windows: the engine's pipe shut to this user, or not there while Docker isn't running
    [/pipe.*access is denied/i, "This Windows user can't use Docker. Add it to the docker-users group, sign out and in again, then try again."],
    [/permission denied.*docker daemon socket/i, "This user can't use Docker. Add it to the docker group, log in again, then try again."],
    [/cannot connect to the docker daemon|is the docker daemon running|docker is not installed|error during connect.*pipe/i, "Docker isn't running. Open Docker, then try again."],
    [/no space left on device/i, "Docker is out of disk space. Raise its disk limit in Docker's settings or delete images you don't use, then try again."],
    [/computed checksum did not match|sha256sums?: .*failed|: FAILED$/im, "The worker's download didn't match its published checksum, so nothing was installed. Try again."],
    [/no such host|could not resolve|network is unreachable|i\/o timeout|tls handshake timeout|connection reset|eai_again|enotfound|etimedout/i, "This computer can't reach the internet right now. Check the connection, then try again."],
    [/\bdenied\b|unauthorized|authentication required/i, "GitHub refused the box download. Try again in a few minutes."],
    [/^timed out$/i, "That took too long. Check the connection, then try again."],
  ];
  for (const [pattern, words] of known) if (pattern.test(text)) return words;
  const lines = text.split("\n").map((line) => line.trim()).filter((line) => line && !/^Run '.*--help'/.test(line));
  const telling = lines.find((line) => /error|denied|failed|cannot|can't|unable/i.test(line)) ?? lines[lines.length - 1] ?? "Something went wrong. Try again.";
  return telling.replace(/^docker: /, "").replace(/^Error response from daemon: /i, "").slice(0, 200);
}
