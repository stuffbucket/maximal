import type { Meta, StoryObj } from "@storybook/react-vite";

import { themes } from "../../../../shell/src/ui/styles/theme";
import { type Check, type Theme, matrix, value } from "../contrast";

/**
 * Every color token, in the role the UI uses it for, on every surface it can
 * sit on — both themes side by side, whatever the toolbar says. Ratios are
 * WCAG 2.x: text ≥ 4.5:1, non-text (icons, input borders, focus ring,
 * switches) ≥ 3:1, labels on a fill ≥ 4.5:1.
 *
 * Source of truth: shell/src/ui/styles/theme.ts. The same checks run from
 * the terminal: `bun scripts/contrast-audit.ts` (add `--rendered` to also
 * run axe over every story in both themes).
 */
const meta = {
  title: "Foundations/Contrast",
  parameters: { layout: "padded", a11y: { test: "off" } },
} satisfies Meta;
export default meta;

function Sample({ check }: { check: Check }): JSX.Element {
  const fg = value(check.theme, check.fg);
  const bg = value(check.theme, check.bg);
  if (check.role === "non-text") {
    return (
      <span className="sb-contrast__sample" style={{ background: bg }}>
        <span className="sb-contrast__mark" style={{ background: fg }} />
      </span>
    );
  }
  return (
    <span className="sb-contrast__sample" style={{ background: bg, color: fg }}>
      Aa
    </span>
  );
}

function ThemePanel({ theme, checks }: { theme: Theme; checks: Array<Check> }): JSX.Element {
  const failing = checks.filter((c) => c.ratio < c.min).length;
  return (
    <section className="sb-contrast__panel" style={{ background: themes[theme].surfaceBase, color: themes[theme].textStrong }}>
      <h3 className="sb-contrast__title">
        {theme === "dark" ? "Dark" : "Light"} — {failing === 0 ? "all pass" : `${failing} below minimum`}
      </h3>
      <table className="sb-contrast__table">
        <thead>
          <tr>
            <th scope="col">Sample</th>
            <th scope="col">Token</th>
            <th scope="col">On</th>
            <th scope="col">Ratio</th>
          </tr>
        </thead>
        <tbody>
          {checks.map((c) => (
            <tr key={`${c.fg}-${c.bg}-${c.role}`} title={c.why}>
              <td>
                <Sample check={c} />
              </td>
              <td>
                <code>--{c.fg}</code>
                <div className="sb-contrast__why" style={{ color: themes[theme].textMuted }}>
                  {c.role} · {c.why}
                </div>
              </td>
              <td>
                <code>--{c.bg}</code>
              </td>
              <td className="sb-contrast__ratio">
                {c.ratio.toFixed(2)}
                <span className={c.ratio >= c.min ? "sb-contrast__pass" : "sb-contrast__fail"} style={{ color: c.ratio >= c.min ? themes[theme].statusSuccess : themes[theme].statusError }}>
                  {c.ratio >= c.min ? ` ✓ ≥${c.min}` : ` ✗ <${c.min}`}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export const AllPairings: StoryObj = {
  render: () => {
    const checks = matrix();
    return (
      <div className="sb-contrast">
        {(["light", "dark"] as const).map((theme) => (
          <ThemePanel key={theme} theme={theme} checks={checks.filter((c) => c.theme === theme)} />
        ))}
      </div>
    );
  },
};
