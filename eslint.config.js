import config from "@echristian/eslint-config"

export default config({
  ignores: [
    ".opencode/**",
    "contrib/**",
    "docs/**",
    "scripts/**",
    "shell/**",
    "site/**",
    ".dependency-cruiser.cjs",
    "landing/**",
  ],
  prettier: {
    plugins: ["prettier-plugin-packagejson"],
  },
})
