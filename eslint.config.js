import config from "@echristian/eslint-config"

export default config({
  ignores: [".opencode/**", "contrib/**", "docs/**", "scripts/**"],
  prettier: {
    plugins: ["prettier-plugin-packagejson"],
  },
})
