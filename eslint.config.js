import config from "@echristian/eslint-config"

export default config({
  ignores: [
    ".opencode/**",
    "contrib/**",
    "docs/**",
    "scripts/**",
    "shell/**",
    "site/**",
  ],
  prettier: {
    plugins: ["prettier-plugin-packagejson"],
  },
})
