import "../../../shell/src/ui/styles/styles.css";
import "../src/storybook.css";

import type { Preview } from "@storybook/react-vite";

import { availableLocales, localeLabel } from "../../../shell/src/i18n";
import { type MockApiParameters, installMockApi } from "../src/mock/fetch-mock";

/** "system" leaves <html> unpinned so the tokens follow the OS, as in the app. */
function applyTheme(theme: unknown): void {
  const root = document.documentElement;
  if (theme === "dark" || theme === "light") root.dataset.theme = theme;
  else delete root.dataset.theme;
}

const preview: Preview = {
  globalTypes: {
    theme: {
      description: "Color theme: System follows the OS like the app; Dark/Light pin data-theme",
      toolbar: {
        title: "Theme",
        icon: "contrast",
        items: [
          { value: "system", title: "System" },
          { value: "dark", title: "Dark" },
          { value: "light", title: "Light" },
        ],
        dynamicTitle: true,
      },
    },
    locale: {
      description: "Locale for the window stories (React islands are English-only today)",
      toolbar: {
        title: "Locale",
        icon: "globe",
        items: availableLocales().map((tag) => ({ value: tag, title: localeLabel(tag) })),
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: { theme: "system", locale: "en" },

  decorators: [
    (Story, { globals }) => {
      applyTheme(globals.theme);
      return <Story />;
    },
  ],

  // Every story gets a fresh mock sidecar, seeded from
  // `parameters.mockApi` (scenario + per-path overrides).
  beforeEach({ parameters, globals }) {
    applyTheme(globals.theme);
    return installMockApi(window, parameters.mockApi as MockApiParameters | undefined);
  },

  parameters: {
    layout: "padded",
    backgrounds: { disabled: true },
    controls: { expanded: true },
    a11y: { test: "todo" },
    options: {
      storySort: { order: ["Foundations", ["Tokens", "Contrast"], "Components", "Settings", "Windows"] },
    },
  },
};

export default preview;
