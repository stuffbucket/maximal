/**
 * Bounded rail slice for the Projects nav group (spec §2.2–§2.3).
 *
 * The rail is a shortcut bar, never an index: projects are an open, unbounded set,
 * but the rail shows a hard-capped curated slice (pinned first, then recent) plus
 * an "All projects" entry; completeness lives in the content-pane master-detail.
 * The rail height must stay constant whether there are 3 projects or 50.
 *
 * Pure function — the §10 verification anchor: "`curateProjectSlice` caps the rail
 * at N=0/3/6/7/50". No DOM, no I/O.
 */

/** The durable project key is the API-key label, never the ephemeral session_id (§5). */
export interface Project {
  /** Stable slug derived from the API-key label (used in `?project=<slug>`). */
  readonly slug: string
  readonly label: string
  readonly pinned: boolean
  /** For recency ordering when there are more than the cap. */
  readonly lastActiveAt: number
}

export interface CuratedSlice {
  /** At most `cap` projects: all pinned (capped), then most-recent to fill. */
  readonly items: ReadonlyArray<Project>
  /** True when the full set exceeds the slice, so the rail shows "All projects". */
  readonly hasOverflow: boolean
}

/** Default rail cap (~6, §2.3). */
export const DEFAULT_PROJECT_SLICE_CAP = 6

/**
 * Reduce the full project set to the rail slice. Rules (§2.3):
 *   - `total <= cap` → show all, no overflow.
 *   - `total > cap`  → pinned first, then recent, truncated to `cap`; overflow true.
 */
export function curateProjectSlice(
  projects: ReadonlyArray<Project>,
  cap: number = DEFAULT_PROJECT_SLICE_CAP,
): CuratedSlice {
  // Pinned first, each group most-recent-first, so a truncation to `cap` keeps the
  // pinned shortcuts and the freshest recents (§2.3). filter() copies, so sorting
  // never mutates the caller's array.
  const byRecency = (a: Project, b: Project): number =>
    b.lastActiveAt - a.lastActiveAt
  const ordered = [
    ...projects.filter((p) => p.pinned).sort(byRecency),
    ...projects.filter((p) => !p.pinned).sort(byRecency),
  ]
  if (ordered.length <= cap) {
    return { items: ordered, hasOverflow: false }
  }
  // The rail height stays constant: the >cap tail lives in the content-pane
  // master-detail behind "All projects" (hasOverflow drives that entry).
  return { items: ordered.slice(0, cap), hasOverflow: true }
}
