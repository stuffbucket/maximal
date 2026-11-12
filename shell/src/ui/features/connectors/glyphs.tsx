/**
 * Maximal's own line glyphs for the Connectors section, drawn on a 24-unit
 * grid with round caps to sit with the lucide set used elsewhere. All are
 * decorative (`aria-hidden`); the control around each carries the name.
 */
import type { ReactNode } from "react";

function Glyph({ children, className }: { children: ReactNode; className?: string }): JSX.Element {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/** A connector: two nodes joined by a bent link. */
export function ConnectorGlyph(): JSX.Element {
  return (
    <Glyph>
      <rect x="3.5" y="3.5" width="7" height="7" rx="2" />
      <circle cx="17" cy="17" r="3.5" />
      <path d="M10.5 7H14a3 3 0 0 1 3 3v3.5" />
    </Glyph>
  );
}

/** Allowed: a ring with a tick. */
export function AllowGlyph(): JSX.Element {
  return (
    <Glyph>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m8.5 12.25 2.5 2.5 4.75-5" />
    </Glyph>
  );
}

/** Ask: a ring with a question mark. */
export function AskGlyph(): JSX.Element {
  return (
    <Glyph>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M9.75 9.5a2.4 2.4 0 1 1 3.4 2.2c-.7.35-1.15.95-1.15 1.7v.35M12 16.5h.01" />
    </Glyph>
  );
}

/** Blocked: a ring struck through. */
export function BlockGlyph(): JSX.Element {
  return (
    <Glyph>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m6 18 12-12" />
    </Glyph>
  );
}

/** Custom (mixed): three short bars of different lengths. */
export function MixedGlyph(): JSX.Element {
  return (
    <Glyph>
      <path d="M5 8h14M5 12h9M5 16h12" />
    </Glyph>
  );
}

/** Worth knowing: a ring with an exclamation mark. */
export function NoticeGlyph(): JSX.Element {
  return (
    <Glyph>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.75v5M12 16.25h.01" />
    </Glyph>
  );
}

export function CheckGlyph(): JSX.Element {
  return (
    <Glyph>
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </Glyph>
  );
}

export function ChevronGlyph({ className }: { className?: string }): JSX.Element {
  // Points right; CSS turns it down when its twirldown is open.
  return (
    <Glyph className={className}>
      <path d="m9.5 6 6 6-6 6" />
    </Glyph>
  );
}

export function ChevronDownGlyph(): JSX.Element {
  return (
    <Glyph>
      <path d="m6 9.5 6 6 6-6" />
    </Glyph>
  );
}

export function BackGlyph(): JSX.Element {
  return (
    <Glyph>
      <path d="M19 12H5.5M11 6l-6 6 6 6" />
    </Glyph>
  );
}

/** The connector's tile: the glyph in a small rounded square. */
export function ConnectorTile({ size = "md" }: { size?: "md" | "lg" }): JSX.Element {
  return (
    <span className={`connector-tile connector-tile--${size}`} aria-hidden="true">
      <ConnectorGlyph />
    </span>
  );
}
