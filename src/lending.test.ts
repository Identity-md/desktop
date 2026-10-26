import { describe, expect, it } from "vitest";
import { lendingOn, lendReader, SPAN_STANDS, type Span, type Terms } from "./lending";

// seat #494's vault and lending, as they are onchain
const VAULT = "0x251a8fe7b3f712716c0e5206d0aec17a68cc4d83";
const WALLET = "0x047f606fd5b2baa5f5c6c4ab8958e45cb6b054b7";
const TERMS: Terms = { owner: WALLET, operator: "0x56fb0edf4e2fdfa3d82c5707312ed3d2a6ff5c24", owner_bps: 3000 };
const SPAN: Span = { started_at: 1792269179, ends_at: 1792873979 };

/** A chain that answers as seat #494's does, counting what it's asked; `down` makes every read fail. */
function chain(vaults: Record<string, Terms> = {}) {
  const asked = { vault: 0, span: 0, down: false };
  let at = 0;
  const reader = lendReader(
    {
      vault: async (holder) => { asked.vault++; if (asked.down) throw new Error("down"); return holder.startsWith("0x25") ? TERMS : null; },
      span: async () => { asked.span++; if (asked.down) throw new Error("down"); return SPAN; },
    },
    vaults,
    () => {},
    () => at,
  );
  return { reader, asked, wait: (ms: number) => { at += ms; } };
}

describe("reading a lent seat", () => {
  it("asks for the vault and the dates once, then nothing until they've stood six hours", async () => {
    const { reader, asked, wait } = chain();
    // a read every five minutes, as the panel does
    for (let i = 0; i < 71; i++) {
      expect(await reader.read(VAULT, "494")).toEqual({ ...TERMS, ...SPAN });
      wait(300_000);
    }
    expect(asked).toMatchObject({ vault: 1, span: 1 });
    wait(SPAN_STANDS - 71 * 300_000);
    await reader.read(VAULT, "494");
    expect(asked).toMatchObject({ vault: 1, span: 2 });
  });

  it("keeps a vault's terms for good, so a new run asks only for the dates", async () => {
    const vaults: Record<string, Terms> = {};
    await chain(vaults).reader.read(VAULT, "494");
    const { reader, asked } = chain(vaults);
    await reader.read(VAULT, "494");
    expect(asked).toMatchObject({ vault: 0, span: 1 });
  });

  it("asks once a run about a holder that isn't a vault", async () => {
    const { reader, asked } = chain();
    for (let i = 0; i < 100; i++) expect(await reader.read(WALLET, "494")).toBeNull();
    expect(asked).toMatchObject({ vault: 1, span: 0 });
  });

  it("asks for the dates afresh once the seat was seen out of its vault, or in another", async () => {
    const { reader, asked } = chain();
    await reader.read(VAULT, "494");
    reader.keep([]);
    await reader.read(VAULT, "494");
    expect(asked.span).toBe(2);
    await reader.read("0x25" + "0".repeat(38), "494");
    expect(asked).toMatchObject({ vault: 2, span: 3 });
  });

  it("says nothing when the chain can't be read, and keeps the dates it had", async () => {
    const { reader, asked, wait } = chain();
    asked.down = true;
    expect(await reader.read(VAULT, "494")).toBeUndefined();
    asked.down = false;
    await reader.read(VAULT, "494");
    asked.down = true;
    wait(SPAN_STANDS);
    expect(await reader.read(VAULT, "494")).toEqual({ ...TERMS, ...SPAN });
    expect(await reader.read(WALLET, "12")).toBeUndefined();
  });

  it("counts a lending as on until its end", () => {
    expect(lendingOn(SPAN, (SPAN.ends_at - 1) * 1000)).toBe(true);
    expect(lendingOn(SPAN, SPAN.ends_at * 1000)).toBe(false);
  });
});
