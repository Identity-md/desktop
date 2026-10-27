/** Seats lent on imdLend, read from their vaults while asking the chain as little as possible. */

/** What imdLend fixed when it made a vault: who lent the seat, who runs it, and the lender's share in basis points. */
export type Terms = { owner: string; operator: string; owner_bps: number };
/** When a seat's latest lending in its vault began and ends (or ended), in seconds. */
export type Span = { started_at: number; ends_at: number };
/** A seat in one of imdLend's vaults: the vault's terms and the seat's latest lending. */
export type Lending = Terms & Span;

/** Whether a lending is on: until its end, as the vault itself counts it (`isNftLent`), so the clock says when it's over. */
export const lendingOn = (span: Span, now = Date.now()) => now / 1000 < span.ends_at;

/** How long a lending read from its vault stands: its borrower can end it early, and nothing else tells the app. */
export const SPAN_STANDS = 6 * 3_600_000;

type Ask = { vault: (holder: string) => Promise<Terms | null>; span: (vault: string, seat: string) => Promise<Span | null> };

/**
 * Reads seats' lendings. A vault's terms never change, so each is asked once and kept in `vaults`, which outlives the
 * app; a holder that isn't a vault is asked once a run. A seat's dates are asked again only when its holder changed,
 * after it was seen out of its vault (`keep`), or `SPAN_STANDS` on: a lending ends by the clock, which needs no asking.
 * `read` answers null when the holder isn't a vault or never lent the seat, and undefined when the chain couldn't be read.
 */
export function lendReader(ask: Ask, vaults: Record<string, Terms>, kept: () => void, now = () => Date.now()) {
  const notVaults = new Set<string>();
  const spans = new Map<string, { vault: string; at: number; span: Span }>();
  return {
    async read(holder: string, seat: string): Promise<Lending | null | undefined> {
      if (notVaults.has(holder)) return null;
      let terms = vaults[holder];
      if (!terms) {
        const read = await ask.vault(holder).catch(() => undefined);
        if (read === undefined) return undefined;
        if (read === null) { notVaults.add(holder); return null; }
        terms = vaults[holder] = read;
        kept();
      }
      const last = spans.get(seat);
      const known = last?.vault === holder ? last : undefined;
      if (known && now() - known.at < SPAN_STANDS) return { ...terms, ...known.span };
      const span = await ask.span(holder, seat).catch(() => undefined);
      if (span === undefined) return known ? { ...terms, ...known.span } : undefined;
      if (span === null) { spans.delete(seat); return null; }
      spans.set(seat, { vault: holder, at: now(), span });
      return { ...terms, ...span };
    },
    /** Forgets the dates of every seat but these, the ones in vaults now: one seen out of its vault is asked afresh. */
    keep(seats: Iterable<string>): void {
      const now = new Set(seats);
      for (const seat of spans.keys()) if (!now.has(seat)) spans.delete(seat);
    },
  };
}
