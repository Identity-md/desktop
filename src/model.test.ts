import { describe, expect, it } from "vitest";
import { acceptedPerDay, acceptedToday, addDays, amountWords, behindWords, currentWorker, failureWords, jailWords, judgedRate, modelName, newerRelease, phaseOf, runLength, setupErrorWords, statusLine, stepTitle, sumOf, trayState, upSince, usdText, worthOf, type Agent, type Standing } from "./model";

const standing = (over: Partial<Standing["standing"]> = {}, presence: Partial<NonNullable<Standing["presence"]>> | null = {}): Standing => ({
  enrollment: { status: "active", tokenId: "12" },
  presence: presence === null ? null : { connected: true, stale: false, lastHeartbeatAt: "2026-10-13T00:00:00Z", runtimes: [{ id: "claude" }], ...presence },
  standing: { working: 0, pausedUntil: null, pausedFor: null, pausedByOwnerAt: null, running: [], ...over },
});
const agent = (s: Standing | null, online = true): Agent => ({ tokenId: "12", wallet: "0xabc", online, standing: s, today: 0, accepted: 0 });
const NOW = new Date("2026-10-13T12:00:00Z");

describe("an agent's state", () => {
  it("reads ready, working, paused by its holder, paused by the network and offline in that order", () => {
    expect(phaseOf(agent(standing()), NOW).kind).toBe("ready");
    expect(phaseOf(agent(standing({ working: 1, running: [{ jobId: "j", objective: "o", nodeKey: "oracle_assess", since: "2026-10-13T11:51:00Z" }] })), NOW).kind).toBe("working");
    expect(phaseOf(agent(standing({ pausedByOwnerAt: "2026-10-13T11:00:00Z" })), NOW).kind).toBe("held");
    expect(phaseOf(agent(standing({ pausedUntil: "2026-10-13T12:10:00Z" })), NOW).kind).toBe("paused");
    expect(phaseOf(agent(standing({}, { connected: false })), NOW).kind).toBe("ready");
    expect(phaseOf(agent(standing({}, { connected: false }), false), NOW).kind).toBe("offline");
  });

  it("finishes its running work before it reads as paused", () => {
    expect(phaseOf(agent(standing({ working: 1, pausedByOwnerAt: "2026-10-13T11:00:00Z" })), NOW).kind).toBe("working");
  });

  it("says what it is doing in words", () => {
    const working = agent(standing({ working: 1, running: [{ jobId: "j", objective: "o", nodeKey: "site_content_check", since: "2026-10-13T11:51:00Z" }] }));
    expect(statusLine(phaseOf(working, NOW), working, NOW)).toBe("Working on Site content check · 9 min");
    expect(statusLine({ kind: "held" }, null)).toBe("Paused · takes no new work");
    expect(stepTitle("audit_permissions")).toBe("Permissions audit");
  });
});

describe("the menu bar icon", () => {
  it("asks for attention before it shows work, and rests when everything is off", () => {
    expect(trayState([{ kind: "working", jobs: 1 }, { kind: "offline", seen: null }])).toBe("attention");
    expect(trayState([{ kind: "working", jobs: 1 }, { kind: "ready" }])).toBe("working");
    expect(trayState([{ kind: "off" }, { kind: "held" }])).toBe("off");
    expect(trayState([{ kind: "ready" }])).toBe("idle");
    expect(trayState([{ kind: "ready" }], true)).toBe("attention");
  });

  it("knows the current worker as the explorer does, giving a new release two hours", () => {
    const rows = [
      { tag_name: "worker-v0.1.0-f0753cb7ef61", published_at: "2026-10-12T22:22:40Z", draft: false, prerelease: false },
      { tag_name: "worker-v0.1.0-aca0ff06b928", published_at: "2026-10-12T21:18:05Z", draft: false, prerelease: false },
      { tag_name: "worker-v0.2.0-0000000000aa", published_at: "2026-10-12T23:00:00Z", draft: false, prerelease: true },
    ];
    expect(currentWorker(rows, new Date("2026-10-12T23:00:00Z"))).toMatchObject({ newest: "0.1.0+f0753cb7", accepted: ["0.1.0+f0753cb7", "0.1.0+aca0ff06"] });
    const later = currentWorker(rows, new Date("2026-10-13T12:00:00Z"))!;
    expect(later.accepted).toEqual(["0.1.0+f0753cb7"]);
    expect(behindWords("0.1.0+aca0ff06", later.order)).toBe("1 update behind");
    expect(behindWords("0.1.0+00000000", later.order)).toBe("Many updates behind");
    expect(currentWorker([], new Date())).toBeNull();
    // the release list is read every half hour: a worker already on the next release is ahead of it
    expect(newerRelease("0.1.2+d1681b55", "0.1.1+c23cfac6")).toBe(true);
    expect(newerRelease("0.1.1+c23cfac6", "0.1.1+aaaaaaaa")).toBe(false);
    expect(newerRelease("0.1.0+00000000", "0.1.1+c23cfac6")).toBe(false);
    expect(newerRelease("0.10.0", "0.9.9")).toBe(true);
    expect(failureWords({ at: "x", reason: "claude: please run /login\nmore" })).toBe("claude: please run /login");
  });
});

describe("numbers", () => {
  it("counts work accepted in the 24-hour days the explorer counts, and leaves unknown what a cut-off page does not reach", () => {
    const now = new Date("2026-10-13T15:00:00Z");
    const row = (submitted: string, accepted: string | null) => ({ submittedAt: submitted, acceptedAt: accepted });
    const rows = [
      row("2026-10-13T14:00:00Z", null),
      row("2026-10-13T13:00:00Z", "2026-10-13T13:30:00Z"),
      row("2026-10-12T16:00:00Z", "2026-10-12T16:10:00Z"),
      row("2026-10-12T14:00:00Z", "2026-10-12T14:30:00Z"),
      row("2026-10-10T10:00:00Z", "2026-10-10T11:00:00Z"),
    ];
    expect(acceptedPerDay(rows, 4, now)).toEqual([1, 0, 1, 2]);
    expect(acceptedToday(rows, now)).toBe(2);
    // the page stops at 14:00 on the 12th: the day that began at 15:00 on the 11th may be missing rows
    expect(acceptedPerDay(rows.slice(0, 4), 4, now, 4)).toEqual([null, null, null, 2]);
    expect(addDays([[1, 2, 3], [null, 1, 1]], 3)).toEqual([null, 3, 4]);
  });

  it("rates judged work and names a model as the explorer does", () => {
    expect(judgedRate(286, 12, 7)).toBe(94);
    expect(judgedRate(0, 0, 0)).toBeNull();
    expect(modelName("claude-fable-5-1")).toBe("Claude Fable 5.1");
    expect(modelName("gpt-6")).toBe("gpt-6");
  });

  it("prices rewards as the explorer does: thin pools at what they sell for, untraded ones at nothing", () => {
    expect(worthOf({ now: { eth: 1, usd: 100 }, sells: { eth: 0.5, usd: 50 } })).toEqual({ eth: 0.5, usd: 50 });
    expect(worthOf({ now: { eth: 1, usd: 100 }, sells: { eth: 0.9, usd: 90 } })).toEqual({ eth: 1, usd: 100 });
    expect(worthOf({ now: { eth: 1, usd: 100 }, noBids: true })).toEqual({ eth: 0, usd: 0 });
    expect(sumOf([{ eth: 1, usd: 2 }, undefined, { eth: 1, usd: 3 }])).toEqual({ eth: 2, usd: 5 });
    expect(usdText(503.531)).toBe("$503.53");
    expect(usdText(1503.5)).toBe("$1,504");
  });

  it("times the uptime from the newest connection among the agents that are up", () => {
    const up = (connectedAt: string, over: Partial<NonNullable<Standing["presence"]>> = {}) => agent(standing({}, { connectedAt, ...over }));
    const agents = [up("2026-10-10T08:00:00Z"), up("2026-10-13T06:36:00Z"), up("2026-10-13T11:59:00Z", { stale: true })];
    const since = upSince(agents, [{ kind: "ready" }, { kind: "working", jobs: 1 }, { kind: "ready" }]);
    expect(since?.toISOString()).toBe("2026-10-13T06:36:00.000Z");
    expect(runLength(since!, NOW)).toBe("5h 24m");
    expect(runLength(new Date("2026-10-10T08:00:00Z"), NOW)).toBe("3d 4h");
    expect(upSince(agents, [{ kind: "off" }, { kind: "offline", seen: null }, { kind: "ready" }])).toBeNull();
  });

  it("writes a reward's amount plainly", () => {
    expect(amountWords("157480314960629921259842", 18)).toBe("157K");
    expect(amountWords("1234560000000000000000000", 18)).toBe("1.2M");
    expect(amountWords("1500000000000000000", 18)).toBe("1.5");
    expect(amountWords("40000000000000000", 18)).toBe("0.04");
    expect(amountWords("0", 18)).toBe("0");
  });

  it("says why an agent takes no oracle, research or contract jobs, only when its jail does not hold", () => {
    const detail = "Claude's sandbox needs socat: run sudo imd sandbox once";
    expect(jailWords(standing({}, { jail: { ok: false, detail } }))).toBe(detail);
    expect(jailWords(standing({}, { jail: { ok: false, detail: " " } }))).toBe("its sandbox cannot start");
    expect(jailWords(standing({}, { jail: { ok: true, detail: "bubblewrap" } }))).toBeNull();
    expect(jailWords(standing({}, { jail: null }))).toBeNull();
    expect(jailWords(standing())).toBeNull();
    expect(jailWords(null)).toBeNull();
  });

  it("says a failed setup step in plain words, from what Docker said", () => {
    expect(setupErrorWords('Error response from daemon: Head "https://ghcr.io/v2/identity-md/box/manifests/latest": denied')).toBe("GitHub refused the box download. Try again in a few minutes.");
    expect(setupErrorWords('Error response from daemon: Get "https://ghcr.io/v2/": dial tcp: lookup ghcr.io: no such host')).toBe("This computer can't reach the internet right now. Check the connection, then try again.");
    expect(setupErrorWords("failed to register layer: write /usr/lib/x86_64-linux-gnu/libLLVM.so: no space left on device")).toMatch(/^Docker is out of disk space/);
    expect(setupErrorWords("Cannot connect to the Docker daemon at unix:///Users/me/.docker/run/docker.sock. Is the docker daemon running?")).toBe("Docker isn't running. Open Docker, then try again.");
    expect(setupErrorWords("permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock")).toMatch(/^This user can't use Docker/);
    expect(setupErrorWords("identitymd-worker.tgz: FAILED\nsha256sum: WARNING: 1 computed checksum did NOT match")).toMatch(/didn't match its published checksum/);
    expect(setupErrorWords("timed out")).toBe("That took too long. Check the connection, then try again.");
    // one it does not know: Docker's error, not the line after it
    expect(setupErrorWords("docker: Error response from daemon: range of CPUs is from 0.01 to 2.00, as there are only 2 CPUs available\nRun 'docker run --help' for more information")).toBe("range of CPUs is from 0.01 to 2.00, as there are only 2 CPUs available");
    expect(setupErrorWords("")).toBe("Something went wrong. Try again.");
  });
});
