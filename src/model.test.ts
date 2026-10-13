import { describe, expect, it } from "vitest";
import { amountWords, countToday, phaseOf, statusLine, stepTitle, trayState, type Agent, type Standing } from "./model";

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
    expect(statusLine(phaseOf(working, NOW), working, NOW)).toBe("Working · Site content check · 9 min");
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
  });
});

describe("numbers", () => {
  it("counts today's work from local midnight", () => {
    const now = new Date(2026, 9, 13, 15, 0);
    expect(countToday([{ submittedAt: new Date(2026, 9, 13, 0, 5).toISOString() }, { submittedAt: new Date(2026, 9, 12, 23, 55).toISOString() }, {}], now)).toBe(1);
  });

  it("writes a reward's amount plainly", () => {
    expect(amountWords("157480314960629921259842", 18)).toBe("157K");
    expect(amountWords("1234560000000000000000000", 18)).toBe("1.2M");
    expect(amountWords("1500000000000000000", 18)).toBe("1.5");
    expect(amountWords("40000000000000000", 18)).toBe("0.04");
    expect(amountWords("0", 18)).toBe("0");
  });
});
