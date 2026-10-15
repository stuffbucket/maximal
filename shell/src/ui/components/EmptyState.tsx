import type { ReactNode } from "react";

import { cx } from "./cx";

interface EmptyStateProps {
  /** What isn't here yet, as a short statement ("No MCP servers yet"). */
  title: string;
  /** How to get something here. */
  children?: ReactNode;
  /** The one action that fills it, if the user can take it from here. */
  action?: ReactNode;
  compact?: boolean;
}

/**
 * The placeholder where a list will be: says what's missing and how to
 * get it, instead of a lone line of muted text. Dashed, not a card — it
 * holds no entity (docs/design/aesthetic.md → When to use a card).
 */
export function EmptyState({ title, children, action, compact = false }: EmptyStateProps): JSX.Element {
  return (
    <div className={cx("empty", compact && "empty--compact")}>
      <p className="empty__title">{title}</p>
      {children && <div className="empty__body">{children}</div>}
      {action && <div className="empty__action">{action}</div>}
    </div>
  );
}
