import config from "@echristian/eslint-config"

export default config({
  ignores: [
    ".opencode/**",
    "docs/**",
    "scripts/**",
    "shell/**",
    "site/**",
    "src/pages/**",
    ".dependency-cruiser.cjs",
    "landing/**",
  ],
  prettier: {
    plugins: ["prettier-plugin-packagejson"],
  },
})
