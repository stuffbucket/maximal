import type { ReactNode } from "react";

function Glyph({ children }: { children: ReactNode }): JSX.Element {
  return (
    <svg
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

/** Lucide-style terminal window used for command-line harnesses. */
export function TerminalGlyph(): JSX.Element {
  return (
    <Glyph>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="m7 9 2 2-2 2" />
      <path d="M11 13h4" />
    </Glyph>
  );
}

/** Lucide-style application window used for desktop harnesses. */
export function WindowGlyph(): JSX.Element {
  return (
    <Glyph>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 8h18" />
      <path d="M7 6h.01" />
    </Glyph>
  );
}
