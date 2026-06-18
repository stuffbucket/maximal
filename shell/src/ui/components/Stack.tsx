import type { CSSProperties, HTMLAttributes, ReactNode } from "react";

export type RelationalProximity = "tight" | "group" | "section" | "region" | "window";

/**
 * Maps the semantic relationship to our continuous Euclidean spatial curve.
 * S(n) = 4 * 1.5^(n-1) -> snapped to the nearest CSS token to obey the DOM boundary.
 */
function getProximityVar(proximity?: RelationalProximity): string | undefined {
  switch (proximity) {
    case "tight":   return "var(--space-1)"; // ~4px
    case "group":   return "var(--space-2)"; // ~8px
    case "section": return "var(--space-4)"; // ~16px
    case "region":  return "var(--space-5)"; // ~24px
    case "window":  return "var(--space-6)"; // ~32px
    default:        return undefined;
  }
}

export interface StackProps extends HTMLAttributes<HTMLDivElement> {
  proximity?: RelationalProximity;
  direction?: "horizontal" | "vertical";
  align?: "start" | "center" | "end" | "stretch";
  justify?: "start" | "center" | "end" | "space-between";
  wrap?: boolean;
  children: ReactNode;
}

/**
 * The fundamental layout primitive. 
 * Prevents developers from writing `gap: 13px` by enforcing a semantic Proximity binding.
 */
export function Stack({
  proximity,
  direction = "vertical",
  align = "stretch",
  justify = "start",
  wrap = false,
  style,
  className,
  children,
  ...rest
}: StackProps) {
  const gap = getProximityVar(proximity);

  const internalStyle: CSSProperties = {
    display: "flex",
    flexDirection: direction === "horizontal" ? "row" : "column",
    alignItems: align,
    justifyContent: justify,
    flexWrap: wrap ? "wrap" : "nowrap",
    ...(gap && { gap }),
    ...style, // Escape hatch for topological overrides
  };

  return (
    <div style={internalStyle} className={className} {...rest}>
      {children}
    </div>
  );
}
