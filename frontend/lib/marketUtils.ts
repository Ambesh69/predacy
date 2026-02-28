/**
 * Shared market display utilities used by both EventCard (homepage cards)
 * and EventPageClient (event detail page). Keeping them in one place ensures
 * cards and detail pages always show the same outcomes with the same formatting.
 */
import type { Market } from "@/lib/polymarket";

// Polymarket uses "Individual A / B / …" as anonymous placeholder slots for
// future nominees. They have no real price or volume and must be hidden.
const ANON_PLACEHOLDER = /^Individual\s+[A-Z]$/i;

/** Short display label for an outcome row. */
export function outcomeLabel(m: Market): string {
  if (m.groupItemTitle) return m.groupItemTitle;
  return m.question
    .replace(/^Will\s+/i, "")
    .replace(/\s+as\s+the\s+next\s+.*\?$/i, "?")
    .replace(/\s+win\s+.*\?$/i, "?")
    .replace(/\s+become\s+.*\?$/i, "?");
}

/**
 * Remove phantom placeholder slots and deduplicate same-name entries.
 * - Strips "Individual A / B / …" markets with no price or volume.
 * - When two markets have the same label (e.g. two "Rick Rieder" entries),
 *   keeps the one with higher volume; ties broken by higher YES probability.
 */
export function filterAndDeduplicateMarkets(markets: Market[]): Market[] {
  // Step 1 — remove phantom placeholders
  const active = markets.filter((m) => {
    const label = (m.groupItemTitle ?? m.question ?? "").trim();
    if (ANON_PLACEHOLDER.test(label)) return false;
    // Drop markets with literally no price AND no volume (pure ghost slots)
    const yp  = parseFloat(m.outcomePrices?.[0] ?? "0");
    const np  = parseFloat(m.outcomePrices?.[1] ?? "0");
    const vol = m.volumeNum || parseFloat(m.volume ?? "0");
    if (yp === 0 && np === 0 && vol === 0) return false;
    return true;
  });

  // Step 2 — deduplicate by label, keeping highest-volume entry
  const seen = new Map<string, Market>();
  for (const m of active) {
    const key  = outcomeLabel(m).trim().toLowerCase();
    const prev = seen.get(key);
    if (!prev) { seen.set(key, m); continue; }
    const prevVol = prev.volumeNum || parseFloat(prev.volume ?? "0");
    const curVol  = m.volumeNum    || parseFloat(m.volume    ?? "0");
    if (
      curVol > prevVol ||
      (curVol === prevVol &&
        parseFloat(m.outcomePrices?.[0] ?? "0") >
        parseFloat(prev.outcomePrices?.[0] ?? "0"))
    ) {
      seen.set(key, m);
    }
  }
  return Array.from(seen.values());
}

/**
 * Format probability as an integer % like Polymarket.
 * Guards against NaN / negative / non-finite values from Gamma API quirks.
 * Examples: 0.924 → "92%", 0.004 → "<1%", 0.996 → ">99%"
 */
export function fmtPct(p: number): string {
  if (!isFinite(p) || p <= 0) return "<1%";
  const pct = Math.round(p * 100);
  if (pct < 1)  return "<1%";
  if (pct > 99) return ">99%";
  return `${pct}%`;
}

/**
 * Format a price in cents, always showing 1 decimal like Polymarket.
 * Also handles the Gamma API quirk where outcomePrices[1] = "1" exactly
 * for illiquid markets — callers should invert (1 - np) before passing when
 * np >= 0.999, so "100¢" is never shown for a near-zero NO price.
 * Examples: 0.924 → "92.4¢", 0.048 → "4.8¢", 0.004 → "0.4¢", 0 → "0¢"
 */
export function fmtCents(p: number): string {
  const c = p * 100;
  if (c <= 0)     return "0¢";
  if (c >= 99.95) return "100¢"; // caps true 100¢ cleanly
  return `${c.toFixed(1)}¢`;    // always 1 decimal for everything else
}
