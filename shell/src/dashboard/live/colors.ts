// Series colors for the live sessions: which `--series-n` each session's
// trace and table swatch use. Pure, so the root test suite can import it.

/** How many sessions get a color of their own; the rest draw in neutral ink. */
export const SERIES_SLOTS = 6;

/**
 * Hands out the six series colors by first appearance. A session keeps its
 * slot while it stays live; the slot is freed only once the session drops out
 * of the live set (its cache went cold), so a color never jumps between two
 * sessions that are both on screen.
 */
export class SeriesColors {
  /** Session id → slot (1-based). */
  private slots = new Map<string, number>();
  /** Live sessions waiting for a slot, in the order they first appeared. */
  private waiting: Array<string> = [];

  /**
   * The slot for each live session id, or `null` (neutral) when all six are
   * taken. Ids that are no longer live give their slots back first.
   */
  assign(liveIds: Array<string>): Map<string, number | null> {
    const live = new Set(liveIds);
    for (const id of this.slots.keys()) {
      if (!live.has(id)) this.slots.delete(id);
    }
    this.waiting = this.waiting.filter((id) => live.has(id));
    for (const id of liveIds) {
      if (!this.slots.has(id) && !this.waiting.includes(id)) this.waiting.push(id);
    }

    const taken = new Set(this.slots.values());
    for (let slot = 1; slot <= SERIES_SLOTS && this.waiting.length > 0; slot++) {
      if (taken.has(slot)) continue;
      const id = this.waiting.shift();
      if (id !== undefined) this.slots.set(id, slot);
    }

    return new Map(liveIds.map((id) => [id, this.slots.get(id) ?? null]));
  }
}
