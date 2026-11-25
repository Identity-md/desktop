import { describe, expect, it } from "vitest";
import linkSaid from "./github-link.fixture.txt?raw";
import { DESK_NEEDS, boxPlatform, deskNeeds, githubJobs, githubLine, memoryGb, memoryLine, noticeBlocks, noticeFacts, type Desk, type GithubSays, type MemorySays } from "./model";

const GIB = 2 ** 30;
const says = (over: Partial<GithubSays> = {}): GithubSays => ({ arch: "x86_64", gh: true, signed_in: null, linked: null, repos: [], ...over });
const memory = (over: Partial<MemorySays> = {}): MemorySays => ({ on: false, docker_bytes: 32 * GIB, box_bytes: 6 * GIB, ...over });
/** The plane's one desk, as `GET /github/desks` lists it on 2026-11-24: no `requires`, so the plane's default. */
const PEQUALNP: Desk = { name: "pequalnp", kind: "pequalnp-v1", repo: "brilliant-hq/pequalnp-proofs", path: "lean/PEqualNP/Outside/L_<gap>.lean" };
const linked = (over: Partial<GithubSays> = {}) => says({ linked: "octocat", signed_in: "octocat", repos: [PEQUALNP.repo], ...over });

describe("the Memory line", () => {
  it("is off, 6 GB, until its holder turns it on", () => {
    expect(memoryLine(memory())).toEqual({ kind: "off" });
    // a box that couldn't be read is no box at 16 GB to bring back
    expect(memoryLine(memory({ box_bytes: null }))).toEqual({ kind: "off" });
  });

  it("asks Docker for room first, then waits for the box to be made with it", () => {
    // this Mac's Docker, 7.7 GiB
    expect(memoryLine(memory({ on: true, docker_bytes: 8_318_976_000 }))).toEqual({ kind: "docker" });
    // Docker given 16 GB says about 15.6 GiB, which counts as 16
    expect(memoryLine(memory({ on: true, docker_bytes: 15.6 * GIB }))).toEqual({ kind: "moving", on: true });
    expect(memoryLine(memory({ on: true, box_bytes: 16 * GIB }))).toEqual({ kind: "on" });
    // turned off, a 16 GB box goes back to 6 as it's made again
    expect(memoryLine(memory({ box_bytes: 16 * GIB }))).toEqual({ kind: "moving", on: false });
  });
});

describe("the GitHub line", () => {
  it("shows nowhere the desks would never send work, until something is linked", () => {
    expect(githubLine(says({ arch: "aarch64" }), [PEQUALNP])).toEqual({ kind: "none" });
    expect(githubLine(says({ arch: "aarch64" }), null)).toEqual({ kind: "none" });
    // linked from a terminal, an Arm box still gets its line, to disconnect
    expect(githubLine(linked({ arch: "aarch64" }), [PEQUALNP])).toEqual({ kind: "linked", login: "octocat" });
    expect(githubLine(null, [PEQUALNP])).toEqual({ kind: "none" });
  });

  it("takes an Arm box once a desk says it takes one", () => {
    const arm = { ...PEQUALNP, requires: { platform: ["linux-x64", "linux-arm64"], minMemoryGb: 16 } };
    expect(githubLine(says({ arch: "aarch64" }), [arm])).toEqual({ kind: "link" });
  });

  it("connects whatever the memory: each desk says what it needs", () => {
    expect(githubLine(says({ gh: false }), [PEQUALNP])).toEqual({ kind: "update" });
    expect(githubLine(says(), [PEQUALNP])).toEqual({ kind: "link" });
  });

  it("says as whom it's connected, or that gh isn't", () => {
    expect(githubLine(linked({ signed_in: null }), [PEQUALNP])).toEqual({ kind: "signin", login: "octocat" });
    expect(githubLine(linked({ signed_in: "someone" }), [PEQUALNP])).toEqual({ kind: "signin", login: "octocat" });
    expect(githubLine(linked({ linked: "Octocat" }), [PEQUALNP])).toEqual({ kind: "linked", login: "Octocat" });
  });
});

describe("GitHub's one job switch", () => {
  // connected on worker 0.1.46: it follows the network's desks, none of its own
  const network = (over: Partial<GithubSays> = {}) => linked({ repos: [], mode: "network", network: [PEQUALNP.repo], denied: [], ...over });

  it("is on while it follows the network's desks, the account kept either way", () => {
    expect(githubJobs(network(), [PEQUALNP], memory({ on: true }))).toEqual({ on: true, clear: [], needs: null, memoryGb: 16 });
    // on before the worker has read the network's list: it follows it all the same
    expect(githubJobs(network({ network: [] }), [PEQUALNP], memory({ on: true })).on).toBe(true);
    expect(githubJobs(network({ mode: "mine", network: [] }), [PEQUALNP], memory())).toEqual({ on: false, clear: [], needs: null, memoryGb: 16 });
  });

  it("is on in mine mode while a repository its holder allowed is worked, so it can be turned off", () => {
    expect(githubJobs(linked({ mode: "mine" }), [PEQUALNP], memory({ on: true })).on).toBe(true);
    // a worker before 0.1.46 says no mode: its own list is what it works
    expect(githubJobs(linked(), [PEQUALNP], memory({ on: true })).on).toBe(true);
    expect(githubJobs(linked({ repos: [] }), [PEQUALNP], memory()).on).toBe(false);
  });

  it("clears, when turned on, a denial of each desk this chip takes, each named once", () => {
    const second: Desk = { ...PEQUALNP, name: "other", kind: "other-v1", repo: "someone/other-proofs", requires: { platform: ["linux-arm64"], minMemoryGb: 8 } };
    const off = network({ mode: "mine", network: [], denied: ["Brilliant-HQ/pequalnp-proofs", "someone/other-proofs", "someone/gone"] });
    expect(githubJobs(off, [PEQUALNP, PEQUALNP, second], memory()).clear).toEqual([PEQUALNP.repo]);
    expect(githubJobs({ ...off, arch: "aarch64" }, [PEQUALNP, second], memory())).toEqual({ on: false, clear: [second.repo], needs: null, memoryGb: 8 });
  });

  it("says what stands between it and its jobs: the chip, then the memory", () => {
    expect(githubJobs(network({ arch: "aarch64" }), [PEQUALNP], memory({ on: true })).needs).toBe("platform");
    expect(githubJobs(network(), [PEQUALNP], memory()).needs).toBe("memory");
    expect(githubJobs(network(), [PEQUALNP], memory({ on: true, docker_bytes: 8_318_976_000 })).needs).toBe("memory");
    // More memory on and Docker with room: the box is made with 16 GB, so nothing stands in the way
    expect(githubJobs(network(), [PEQUALNP], memory({ on: true })).needs).toBe(null);
    // off, nothing stands in the way of nothing
    expect(githubJobs(network({ mode: "mine" }), [PEQUALNP], memory()).needs).toBe(null);
    // a desk denied here asks nothing of it while on
    expect(githubJobs(network({ denied: [PEQUALNP.repo] }), [PEQUALNP], memory())).toEqual({ on: true, clear: [PEQUALNP.repo], needs: null, memoryGb: 0 });
  });

  it("shows what's on with the plane unread", () => {
    expect(githubJobs(network(), null, null)).toEqual({ on: true, clear: [], needs: null, memoryGb: 0 });
    expect(githubJobs(network({ mode: "mine" }), null, null)).toEqual({ on: false, clear: [], needs: null, memoryGb: 0 });
  });
});

describe("what a desk needs", () => {
  it("is the plane's own default until the desk says", () => {
    expect(deskNeeds(undefined)).toEqual(DESK_NEEDS);
    expect(deskNeeds(PEQUALNP)).toEqual(DESK_NEEDS);
    expect(deskNeeds({ requires: { platform: ["linux-arm64"], minMemoryGb: 12 } })).toEqual({ platforms: ["linux-arm64"], memoryGb: 12 });
  });

  it("names a box's platform and memory as the network does", () => {
    expect(boxPlatform("x86_64")).toBe("linux-x64");
    expect(boxPlatform("aarch64")).toBe("linux-arm64");
    expect(memoryGb(15.6 * GIB)).toBe(16);
    expect(memoryGb(15.4 * GIB)).toBe(15);
    expect(memoryGb(null)).toBe(0);
  });
});

describe("the worker's own words", () => {
  it("are rejoined where it broke them for a terminal", () => {
    const text = [
      "This links this machine to the GitHub account octocat for outside proof desks: public proof efforts whose steps the",
      "network works and submits as pull requests, each to a repository you allow here, one by one.",
      "",
      "What becomes public, for each proof this machine writes that passes its checks:",
      "  - a pull request opened by octocat on a public repository you allowed here, showing your handle and avatar, and a",
      "    fork of that repository in your account if you have none;",
      "  - one commit on it, authored and committed as octocat <1+octocat@users.noreply.github.com>.",
      "",
      "It is opened by this worker through your own gh, which keeps your token.",
      "Nothing is ever opened under anyone else's account.",
    ].join("\n");
    expect(noticeBlocks(text)).toEqual([
      { item: false, text: "This links this machine to the GitHub account octocat for outside proof desks: public proof efforts whose steps the network works and submits as pull requests, each to a repository you allow here, one by one." },
      { item: false, text: "What becomes public, for each proof this machine writes that passes its checks:" },
      { item: true, text: "a pull request opened by octocat on a public repository you allowed here, showing your handle and avatar, and a fork of that repository in your account if you have none;" },
      { item: true, text: "one commit on it, authored and committed as octocat <1+octocat@users.noreply.github.com>." },
      { item: false, text: "It is opened by this worker through your own gh, which keeps your token. Nothing is ever opened under anyone else's account." },
    ]);
  });
});

describe("what the panel says of the worker's words", () => {
  it("name the one repository a desk's switch would allow, as imd github allow says it", () => {
    // worker 0.1.43, `imd github allow brilliant-hq/pequalnp-proofs` with no terminal, in a throwaway box on 2026-11-24
    const text = "The desks this plane works now, each allowed here only if you say yes to it:\n  - brilliant-hq/pequalnp-proofs (desk pequalnp, kind pequalnp-v1): Lean 4 proofs against Mathlib, one file a step, held to pequalnp.com's contributing rules.\n    Each proof goes at lean/PEqualNP/Outside/L_<gap>.lean, <gap> being the step. Lean and Mathlib take about 10 GB of disk here, fetched once and kept.\n\nPull requests there are opened from your account octocat, showing your handle and avatar, from a fork in your account.";
    expect(noticeFacts(text)).toEqual({ repos: ["brilliant-hq/pequalnp-proofs"], diskGb: 10 });
    expect(noticeBlocks(text).at(-1)).toEqual({ item: false, text: "Pull requests there are opened from your account octocat, showing your handle and avatar, from a fork in your account." });
  });

  it("names the repositories it would allow and the disk Lean takes", () => {
    const text = "This links this machine to the GitHub account octocat for outside proof desks.\n\nThe desks this plane works now, each allowed here only if you say yes to it:\n  - brilliant-hq/pequalnp-proofs (desk pequalnp, kind pequalnp-v1): Lean 4 proofs against Mathlib.\n    Each proof goes at lean/PEqualNP/Outside/L_<gap>.lean, <gap> being the step. Lean and Mathlib take about 10 GB of disk here, fetched once and kept.\n";
    expect(noticeFacts(text)).toEqual({ repos: ["brilliant-hq/pequalnp-proofs"], diskGb: 10 });
    expect(noticeFacts("The plane names no desk now: nothing to allow.")).toEqual({ repos: [], diskGb: null });
  });
});

describe("worker 0.1.47's words", () => {
  // what `imd github link` says before it asks, from worker 0.1.47's own linkNotice and desksNotice (protocol master
  // 3f4a5f05f, 2026-11-25) for a gh that answered "octocat" and the plane's one desk, then "not linked." with no one to answer
  const said = linkSaid.replace(/\nnot linked\.\n?$/, "");

  it("read as the panel reads them", () => {
    expect(noticeFacts(said)).toEqual({ repos: ["open-goat/pequalnp-proofs"], diskGb: 10 });
    const blocks = noticeBlocks(said);
    // the desks head a block of their own, though no blank line comes before them
    expect(blocks.find((block) => block.text.startsWith("The desks this plane works now"))?.item).toBe(false);
    expect(blocks.filter((block) => block.item).map((block) => block.text.slice(0, 30))).toEqual([
      "The network takes a desk's ste", "It runs on this machine and us", "The network may add the public",
      "a pull request opened by octoc", "one commit on it, authored and", "open-goat/pequalnp-proofs (des",
    ]);
    expect(blocks.some((block) => block.text.includes("every task on this machine runs jailed"))).toBe(true);
  });
});
