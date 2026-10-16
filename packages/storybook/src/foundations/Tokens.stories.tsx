import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect, useState } from "react";

import tokensCss from "../../../../shell/src/ui/styles/tokens.css?raw";

/**
 * Every token declared in shell/src/ui/styles/tokens.css (generated from
 * theme.ts), read live, so this page can't drift from the source. Values
 * are the computed ones for the current theme — flip the toolbar to compare.
 *
 * The Dashboard redeclares its own tokens in shell/ui/dashboard/style.css
 * (see docs/design/failure-modes.md → drift table); this page shows the
 * Settings side only.
 */
const TOKEN_NAMES = [...new Set([...tokensCss.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]))];

const GROUPS: Array<{ title: string; match: (name: string) => boolean; kind: "color" | "size" | "text" | "plain" }> = [
  { title: "Brand, accent, link", match: (n) => /^--(brand|accent|link)/.test(n), kind: "color" },
  { title: "Status", match: (n) => n.startsWith("--status-"), kind: "color" },
  { title: "Surfaces, text, borders", match: (n) => /^--(surface|text-(strong|base-color|muted)|border-(subtle|strong))/.test(n), kind: "color" },
  { title: "Spacing", match: (n) => n.startsWith("--space-"), kind: "size" },
  { title: "Sizing", match: (n) => n.startsWith("--size-"), kind: "size" },
  { title: "Type ramp", match: (n) => /^--text-(xs|sm|base|md|lg|xl|[234]xl)$/.test(n), kind: "text" },
  { title: "Radii, borders, elevation, focus", match: (n) => /^--(radius|border-width|elevation|focus)/.test(n), kind: "plain" },
  { title: "Fonts, weights, leading, tracking, layout", match: (n) => /^--(font|weight|leading|tracking|sidebar|content)/.test(n), kind: "plain" },
];

function TokenRow({ name, kind, theme }: { name: string; kind: string; theme: string }): JSX.Element {
  const [value, setValue] = useState("");
  useEffect(() => {
    setValue(getComputedStyle(document.documentElement).getPropertyValue(name).trim());
  }, [name, theme]);

  return (
    <div className="sb-tokens__row">
      {kind === "color" ? (
        <span className="sb-tokens__swatch" style={{ background: `var(${name})` }} />
      ) : kind === "size" ? (
        <span className="sb-tokens__bar" style={{ width: `var(${name})` }} />
      ) : kind === "text" ? (
        <span style={{ fontSize: `var(${name})` }}>Aa</span>
      ) : (
        <span />
      )}
      <code>{name}</code>
      <span className="sb-tokens__value">{value}</span>
    </div>
  );
}

function Tokens({ theme }: { theme: string }): JSX.Element {
  return (
    <div className="sb-tokens">
      {GROUPS.map((group) => (
        <section key={group.title} className="sb-tokens__group">
          <h3>{group.title}</h3>
          {TOKEN_NAMES.filter(group.match).map((name) => (
            <TokenRow key={name} name={name} kind={group.kind} theme={theme} />
          ))}
        </section>
      ))}
    </div>
  );
}

const meta = {
  title: "Foundations/Tokens",
  parameters: { a11y: { test: "off" } },
} satisfies Meta;
export default meta;

export const AllTokens: StoryObj = {
  render: (_args, { globals }) => <Tokens theme={globals.theme as string} />,
};
