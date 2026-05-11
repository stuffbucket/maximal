import config from "@echristian/eslint-config"

export default config({
  ignores: [
    ".opencode/**",
    "contrib/**",
    "docs/**",
    "scripts/**",
    "shell/**",
    "site/**",
    "src/pages/vendor/**",
    ".dependency-cruiser.cjs",
  ],
  prettier: {
    plugins: ["prettier-plugin-packagejson"],
  },
})
