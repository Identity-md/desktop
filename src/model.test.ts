import { describe, expect, it } from "vitest";
import { limitOf, liftsAt, holdingLine, holdingWords, holdOf, dotOf, localPhase, tookJob, watchKind, watchParts, acceptedPerDay, acceptedToday, addDays, amountWords, behindWords, boxDue, currentWorker, failureWords, jailFix, jailWords, judgedRate, modelName, newerRelease, phaseOf, runLength, setupErrorWords, statusLine, stepTitle, sumOf, trayState, upSince, usdText, worthOf, type Agent, type Standing } from "./model";

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

describe("an agent holding its own work", () => {
  const held = (presence: Partial<NonNullable<Standing["presence"]>> = {}, over: Partial<Standing["standing"]> = {}) => agent(standing(over, { acceptingWork: false, ...presence }));
  // what Taylor's own agent's log and the network said on 2026-11-10 03:23Z, at Claude's weekly limit
  const WEEKLY = "self-test: You've hit your weekly limit · resets Nov 13, 4am (UTC). Holding work for 16m";
  const THEN = new Date("2026-11-10T03:23:00Z");

  it("reads as holding, not ready, when its worker turns work away and the network pauses nothing", () => {
    expect(phaseOf(held(), NOW)).toEqual({ kind: "holding", hold: null });
    expect(phaseOf(agent(standing({}, { acceptingWork: true })), NOW).kind).toBe("ready");
    expect(phaseOf(agent(standing()), NOW).kind).toBe("ready");
    // a job on it, a pause, or being away each say more than that
    expect(phaseOf(held({}, { working: 1 }), NOW).kind).toBe("working");
    expect(phaseOf(held({}, { pausedUntil: "2026-10-13T12:10:00Z" }), NOW).kind).toBe("paused");
    expect(phaseOf(held({}, { pausedByOwnerAt: "2026-10-13T11:00:00Z" }), NOW).kind).toBe("held");
    expect(phaseOf(agent(standing({}, { acceptingWork: false, connected: false }), false), NOW).kind).toBe("offline");
    expect(phaseOf(agent(standing({}, { acceptingWork: false, stale: true })), NOW).kind).toBe("ready");
    expect(dotOf({ kind: "holding", hold: null })).toBe("warn");
    expect(trayState([{ kind: "holding", hold: null }])).toBe("idle");
  });

  it("is this computer's to say why, from its box's log", () => {
    const box = { state: "running" as const, installed: true, deviceKey: "k" };
    expect(localPhase(box, held(), NOW, holdOf(WEEKLY))).toEqual({ kind: "holding", hold: { kind: "limit", said: "You've hit your weekly limit · resets Nov 13, 4am (UTC)" } });
    // a worker that takes work is ready whatever an old line of its log says
    expect(localPhase(box, agent(standing()), NOW, holdOf(WEEKLY)).kind).toBe("ready");
  });

  it("reads the worker's newest self-test line for what holds it", () => {
    expect(holdOf(WEEKLY)).toEqual({ kind: "limit", said: "You've hit your weekly limit · resets Nov 13, 4am (UTC)" });
    expect(holdOf("self-test failed, taking no work: Not logged in · Please run /login. Checking again in 10m, or at once on a restart")).toEqual({ kind: "fault", said: "Not logged in · Please run /login", signedOut: true });
    // a login past its time limit, word for word as a box said it on 2026-11-11: signed out, and Sign in fixes it
    const ranOut = holdOf("self-test failed, taking no work: Failed to authenticate: this login reached its time limit and cannot be renewed. Run `claude auth login` to sign in again, or use `claude setup-token` and set CLAUDE_CODE_OAUTH_TOKEN for unattended jobs. Checking again in 11m, or at once on a restart");
    expect(ranOut).toMatchObject({ kind: "fault", signedOut: true });
    expect(holdingLine(ranOut, null)).toBe("Not taking jobs · Claude is signed out");
    expect(holdingWords(ranOut, null)).toBe("Claude's sign-in in this box ran out, so it takes no jobs. Sign in again, and it takes jobs at once.");
    // any other failed check is still only that
    const other = holdOf("self-test failed, taking no work: the runtime answered nothing within a minute. Checking again in 10m");
    expect(other).toEqual({ kind: "fault", said: "the runtime answered nothing within a minute" });
    expect(holdingLine(other, null)).toBe("Not taking jobs · its runtime failed its check");
    expect(holdOf("self-test: asking the runtime to run one shell command on claude-fable-5-1 within a minute, before taking work")).toEqual({ kind: "checking" });
    // a pass holds nothing, and neither does no line
    expect(holdOf("self-test passed: ran one shell command; taking work again")).toBeNull();
    expect(holdOf("self-test: passed 2m ago with 2.1.319 (Claude Code) on claude-fable-5-1; taking work, and checking again a day after that pass")).toBeNull();
    expect(holdOf(null)).toBeNull();
    expect(holdOf("")).toBeNull();
    expect(holdOf(`self-test: ${"x".repeat(400)}. Holding work for 5m`)).toEqual({ kind: "limit", said: "x".repeat(160) });
  });

  it("reads which limit and when it lifts, from a time said in UTC", () => {
    expect(limitOf("You've hit your weekly limit · resets Nov 13, 4am (UTC)", THEN)).toEqual({ which: "weekly", lifts: new Date("2026-11-13T04:00:00Z") });
    expect(limitOf("You've hit your session limit · resets 11pm (UTC)", THEN)).toEqual({ which: "session", lifts: new Date("2026-11-10T23:00:00Z") });
    // an hour already past today is tomorrow's, and a day already past this year is next year's
    expect(limitOf("You've hit your session limit · resets 2am (UTC)", THEN).lifts).toEqual(new Date("2026-11-11T02:00:00Z"));
    expect(limitOf("You've hit your weekly limit · resets Jan 2, 9am (UTC)", new Date("2026-12-30T00:00:00Z")).lifts).toEqual(new Date("2027-01-02T09:00:00Z"));
    expect(limitOf("5-hour limit reached ∙ resets 3:30pm (UTC)", THEN)).toEqual({ which: "5-hour", lifts: new Date("2026-11-10T15:30:00Z") });
    expect(limitOf("You've hit your weekly limit · resets 12am (UTC)", THEN).lifts).toEqual(new Date("2026-11-11T00:00:00Z"));
    expect(limitOf("You've hit your weekly limit · resets 12pm (UTC)", THEN).lifts).toEqual(new Date("2026-11-10T12:00:00Z"));
    // no time, a time in another zone's words, or a month that is none: the limit, and no hour made up for it
    expect(limitOf("You've hit your usage limit. Try again later.", THEN)).toEqual({ which: null, lifts: null });
    expect(limitOf("You've hit your weekly limit · resets Nov 13, 4am (America/New_York)", THEN)).toEqual({ which: "weekly", lifts: null });
    expect(limitOf("You've hit your weekly limit · resets Foo 13, 4am (UTC)", THEN).lifts).toBeNull();
    expect(limitOf("rate limited", THEN)).toEqual({ which: null, lifts: null });
  });

  it("says it under the agent and in its tray", () => {
    const limit = holdOf(WEEKLY);
    const lifts = new Date("2026-11-13T04:00:00Z");
    expect(statusLine({ kind: "holding", hold: limit }, held(), THEN)).toBe(`At Claude's limit · back ${liftsAt(lifts, THEN)}`);
    expect(holdingWords(limit, held(), THEN)).toBe(`Claude's weekly limit is used up. It takes jobs again ${liftsAt(lifts, THEN, true)}.`);
    // once its hour has passed, or where it names none, only what it is
    expect(statusLine({ kind: "holding", hold: limit }, held(), new Date("2026-11-13T05:00:00Z"))).toBe("At Claude's limit");
    expect(statusLine({ kind: "holding", hold: { kind: "limit", said: "You've hit your usage limit." } }, held(), THEN)).toBe("At Claude's limit");
    expect(holdingWords({ kind: "limit", said: "You've hit your usage limit." }, held(), THEN)).toBe("Claude's limit is used up. It takes jobs again once that lifts. Claude said: You've hit your usage limit.");
    expect(statusLine({ kind: "holding", hold: limit }, held({ runtimes: [{ id: "codex" }] }), THEN)).toMatch(/^At Codex's limit · back /);
    expect(statusLine({ kind: "holding", hold: limit }, held({ runtimes: [] }), THEN)).toMatch(/^At its limit · back /);
    expect(holdingWords(limit, held({ runtimes: [] }), THEN)).toMatch(/^Its runtime's weekly limit is used up\. It takes jobs again /);
    // a row has room for it at its longest: a day, and an hour with its minutes
    expect(statusLine({ kind: "holding", hold: { kind: "limit", said: "You've hit your weekly limit · resets Nov 12, 11:30pm (UTC)" } }, held(), THEN).length).toBeLessThanOrEqual(37);
    // a provider with no room is not its owner's limit, and says so
    const full = { kind: "limit" as const, said: "API Error: 529 Overloaded" };
    expect(statusLine({ kind: "holding", hold: full }, held(), THEN)).toBe("Claude is at capacity");
    expect(holdingWords(full, held(), THEN)).toBe("Claude is at capacity. It asks again every few minutes, and takes jobs once it answers. Claude said: API Error: 529 Overloaded");
    expect(statusLine({ kind: "holding", hold: { kind: "limit", said: "rate limited" } }, held(), THEN)).toBe("At Claude's limit");
    // a failed check, a check still out, and an agent whose log is another machine's
    expect(statusLine({ kind: "holding", hold: { kind: "fault", said: "Not logged in" } }, held(), THEN)).toBe("Not taking jobs · Claude failed its check");
    expect(holdingWords({ kind: "fault", said: "Not logged in · Please run /login" }, held(), THEN)).toBe("Claude failed the check a worker runs before taking jobs: Not logged in · Please run /login");
    expect(statusLine({ kind: "holding", hold: { kind: "checking" } }, held(), THEN)).toBe("Checking Claude before taking jobs");
    expect(statusLine({ kind: "holding", hold: null }, held(), THEN)).toBe("Not taking jobs right now");
    expect(holdingWords(null, held(), THEN)).toBe("Its worker is connected but turning jobs away: at a limit, updating, or checking itself. Its log says which.");
  });

  it("says when in the words of someone here: the hour today, the day this week, the date past it", () => {
    const now = new Date(2026, 10, 9, 22, 23);
    const [tonight, halfPast, thursday, later] = [new Date(2026, 10, 9, 23, 0), new Date(2026, 10, 9, 23, 30), new Date(2026, 10, 12, 23, 0), new Date(2026, 10, 21, 23, 0)];
    const hour = (at: Date) => at.toLocaleTimeString([], { hour: "numeric" });
    const day = (at: Date, weekday: "short" | "long") => at.toLocaleDateString([], { weekday });
    const date = (at: Date) => at.toLocaleDateString([], { month: "short", day: "numeric" });
    expect(liftsAt(tonight, now)).toBe(hour(tonight));
    expect(liftsAt(halfPast, now)).toBe(halfPast.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }));
    expect(liftsAt(thursday, now)).toBe(`${day(thursday, "short")} ${hour(thursday)}`);
    expect(liftsAt(later, now)).toBe(date(later));
    // at length, for a sentence that ends "again …"
    expect(liftsAt(tonight, now, true)).toBe(`at ${hour(tonight)}`);
    expect(liftsAt(thursday, now, true)).toBe(`${day(thursday, "long")} at ${hour(thursday)}`);
    expect(liftsAt(later, now, true)).toBe(`${date(later)} at ${hour(later)}`);
    // a day already gone is said by its date, never as a weekday to come
    expect(liftsAt(new Date(2026, 10, 7, 23, 0), now)).toBe(date(new Date(2026, 10, 7, 23, 0)));
    // and in this country's words, where the computer speaks them
    if (new Intl.DateTimeFormat().resolvedOptions().locale === "en-US") {
      expect(liftsAt(thursday, now)).toMatch(/^Thu 11\sPM$/);
      expect(liftsAt(thursday, now, true)).toMatch(/^Thursday at 11\sPM$/);
      expect(liftsAt(halfPast, now)).toMatch(/^11:30\sPM$/);
      expect(liftsAt(later, now)).toBe("Nov 21");
    }
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

  it("hears a job taken only when one appears on an agent read before", () => {
    const before = new Map([["12", []], ["22", ["a"]]]);
    expect(tookJob(null, new Map([["12", ["x"]]]))).toBe(false);
    expect(tookJob(before, new Map([["12", []], ["22", ["a"]]]))).toBe(false);
    expect(tookJob(before, new Map([["12", ["b"]], ["22", ["a"]]]))).toBe(true);
    expect(tookJob(before, new Map([["12", []], ["22", []]]))).toBe(false);
    expect(tookJob(before, new Map([["12", []], ["56", ["c"]]]))).toBe(false);
  });

  it("reads wallets, ENS names and seat numbers to watch, however they are apart", () => {
    const seats = { parts: ["14", "24", "56"], odd: null };
    expect(watchParts("14,24,56")).toEqual(seats);
    expect(watchParts("14, 24, 56")).toEqual(seats);
    expect(watchParts("14 24 56")).toEqual(seats);
    expect(watchParts(" #14\n24,,56 014 ")).toEqual(seats);
    expect(watchParts("0xFE35e15bE885750D9b2363cbB6aBDd57AC9C4c40 taylor.eth 12")).toEqual({ parts: ["0xfe35e15be885750d9b2363cbb6abdd57ac9c4c40", "taylor.eth", "12"], odd: null });
    expect(watchParts("14 25 vitalik").odd).toBe("vitalik");
    expect(watchParts("0").odd).toBe("0");
    expect(watchParts("  ").parts).toEqual([]);
    // a name that starts like an address is still a name
    expect(watchParts("0xminion.eth 0xE085327c5AD2F77147F10973Fed45Fb19d734F7e")).toEqual({ parts: ["0xminion.eth", "0xe085327c5ad2f77147f10973fed45fb19d734f7e"], odd: null });
    expect(watchKind("0xminion.eth")).toBe("name");
    expect(watchKind("0xe085327c5ad2f77147f10973fed45fb19d734f7e")).toBe("wallet");
    expect(watchKind("14")).toBe("seat");
    expect(watchKind("0xe085")).toBe(null);
  });

  it("names the command that fixes an agent's sandbox on its machine, from what the fleet's workers said", () => {
    const fix = (detail: string) => jailFix(detail).command;
    expect(fix("Claude's sandbox needs socat: run sudo imd sandbox once (it installs bubblewrap and socat), or install them yourself")).toBe("sudo imd sandbox");
    expect(fix("apparmor_restrict_unprivileged_userns is 1, so Claude's sandbox cannot start. Run sudo imd sandbox once")).toBe("sudo imd sandbox");
    expect(fix("bubblewrap cannot start here: bwrap: No permissions to create new namespace, likely because the kernel does not allow non-privileged user namespaces.")).toBe("sudo imd sandbox");
    expect(fix("bubblewrap cannot start here: bwrap: Creating new namespace failed: Permission denied")).toBe("sudo imd sandbox");
    expect(fix("Claude 2.1.280 predates the jail's settings; 2.1.299 or newer is needed")).toBe("claude update");
    expect(fix("bubblewrap cannot start here: bwrap: Can't mount proc on /newroot/proc: Operation not permitted The worker runs in a container that hides /proc; run it on the host or a VM.")).toBeNull();
    expect(fix("claude's sandbox cannot jail reads on Windows; run the worker under WSL")).toBeNull();
    expect(fix("codex sandbox did not hold the jail (exit 1): bwrap: execvp codex-linux-sandbox: No such file or directory")).toBe("imd update");
    expect(jailFix("claude's sandbox cannot jail reads on Windows").why).toMatch(/WSL/);
  });

  it("makes a box again only without today's flags, and only when the network says it holds no job", () => {
    const box = { state: "running" as const, installed: true, deviceKey: null, current: false };
    expect(boxDue(box, agent(standing()))).toBe(true);
    // made with them, or a read that doesn't say
    expect(boxDue({ ...box, current: true }, agent(standing()))).toBe(false);
    expect(boxDue({ state: "running", installed: true, deviceKey: null }, agent(standing()))).toBe(false);
    // at work
    expect(boxDue(box, agent(standing({ working: 1 })))).toBe(false);
    // not known to be idle: no read yet, or the network doesn't have it
    expect(boxDue(box, undefined)).toBe(false);
    expect(boxDue(box, agent(null))).toBe(false);
    expect(boxDue(box, agent(standing({}, null)))).toBe(false);
    expect(boxDue(box, agent(standing({}, { connected: false })))).toBe(false);
    expect(boxDue(box, agent(standing({}, { stale: true })))).toBe(false);
    // off, or already changing
    expect(boxDue({ ...box, state: "stopped" }, agent(standing()))).toBe(false);
    expect(boxDue({ ...box, state: "starting" }, agent(standing()))).toBe(false);
    expect(boxDue(null, agent(standing()))).toBe(false);
  });

  it("says Docker is starting only when the switch had to start it", () => {
    const box = { installed: true, deviceKey: null };
    expect(localPhase({ ...box, state: "starting", dockerClosed: true }, null)).toEqual({ kind: "changing", words: "Starting Docker…" });
    expect(localPhase({ ...box, state: "starting", dockerClosed: false }, null)).toEqual({ kind: "changing", words: "Starting…" });
  });

  it("says a failed setup step in plain words, from what Docker said", () => {
    expect(setupErrorWords('Error response from daemon: Head "https://ghcr.io/v2/identity-md/box/manifests/latest": denied')).toBe("GitHub refused the box download. Try again in a few minutes.");
    expect(setupErrorWords('Error response from daemon: Get "https://ghcr.io/v2/": dial tcp: lookup ghcr.io: no such host')).toBe("This computer can't reach the internet right now. Check the connection, then try again.");
    expect(setupErrorWords("failed to register layer: write /usr/lib/x86_64-linux-gnu/libLLVM.so: no space left on device")).toMatch(/^Docker is out of disk space/);
    expect(setupErrorWords("Cannot connect to the Docker daemon at unix:///Users/me/.docker/run/docker.sock. Is the docker daemon running?")).toBe("Docker isn't running. Open Docker, then try again.");
    expect(setupErrorWords("permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock")).toMatch(/^This user can't use Docker/);
    // Windows: Docker Desktop not running, and its pipe shut to this user
    expect(setupErrorWords('error during connect: Get "http://%2F%2F.%2Fpipe%2FdockerDesktopLinuxEngine/v1.51/info": open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified.')).toBe("Docker isn't running. Open Docker, then try again.");
    expect(setupErrorWords('error during connect: Get "http://%2F%2F.%2Fpipe%2Fdocker_engine/v1.51/version": open //./pipe/docker_engine: Access is denied.')).toMatch(/^This Windows user can't use Docker/);
    expect(setupErrorWords("identitymd-worker.tgz: FAILED\nsha256sum: WARNING: 1 computed checksum did NOT match")).toMatch(/didn't match its published checksum/);
    expect(setupErrorWords("timed out")).toBe("That took too long. Check the connection, then try again.");
    // pairing's own endings, as `imd pair` writes them
    expect(setupErrorWords("pairing code expired before it was signed")).toBe("The code ran out before it was approved. Connect again for a new one.");
    expect(setupErrorWords("pairing was attempted but not accepted — check the browser tab")).toMatch(/^The approval didn't go through/);
    // Claude Code's sign-in turning down a code, as `claude auth login` writes it; one that can't reach Claude is the network
    expect(setupErrorWords("Login failed: Request failed with status code 400")).toMatch(/^Claude didn't take that code/);
    expect(setupErrorWords("Login failed: getaddrinfo ENOTFOUND platform.claude.com")).toMatch(/^This computer can't reach the internet/);
    // one it does not know: Docker's error, not the line after it
    expect(setupErrorWords("docker: Error response from daemon: range of CPUs is from 0.01 to 2.00, as there are only 2 CPUs available\nRun 'docker run --help' for more information")).toBe("range of CPUs is from 0.01 to 2.00, as there are only 2 CPUs available");
    expect(setupErrorWords("")).toBe("Something went wrong. Try again.");
  });
});
