import config from "@echristian/eslint-config"

export default [
  ...config({
    ignores: [
      // client/ is a separate Electron package with its own tsconfig + prettier
      // conventions; the root config does not lint it (its own CI is a follow-up).
      "client/**",
      ".opencode/**",
      "contrib/**",
      "docs/**",
      "scripts/**",
      "site/**",
      "landing/**",
    ],
    prettier: {
      plugins: ["prettier-plugin-packagejson"],
    },
  }),
]
