/** What the app knows about one agent, gathered from the public API. Pure, so it can be tested. */

export type Standing = {
  enrollment: { status: string; tokenId: string } | null;
  presence: { connected: boolean; stale: boolean; lastHeartbeatAt: string; runtimes?: Array<{ id: string }> } | null;
  standing: {
    working: number;
    pausedUntil: string | null;
    pausedFor?: string | null;
    pausedByOwnerAt?: string | null;
    running: Array<{ jobId: string; objective: string; nodeKey: string | null; since: string }>;
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
      return ["Working", stepTitle(job.nodeKey), elapsed(new Date(job.since), now)].join(" · ");
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

/** What the menu bar icon says for all of them together. */
export function trayState(phases: Phase[]): "working" | "attention" | "off" | "idle" {
  if (phases.some((p) => p.kind === "paused" || p.kind === "docker-down" || p.kind === "offline")) return "attention";
  if (phases.some((p) => p.kind === "working")) return "working";
  if (phases.length > 0 && phases.every((p) => p.kind === "off" || p.kind === "held")) return "off";
  return "idle";
}

/** Today's work from a seat record's rows: what was submitted since local midnight. */
export function countToday(work: Array<{ submittedAt?: string }>, now = new Date()): number {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  return work.filter((row) => row.submittedAt && new Date(row.submittedAt) >= midnight).length;
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
