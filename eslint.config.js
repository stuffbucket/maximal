import config from "@echristian/eslint-config"

export default config({
  ignores: [
    ".opencode/**",
    "contrib/**",
    "docs/**",
    "scripts/**",
    "site/**",
    ".dependency-cruiser.cjs",
  ],
  prettier: {
    plugins: ["prettier-plugin-packagejson"],
  },
})
