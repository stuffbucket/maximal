# Changelog

## [0.4.13](https://github.com/stuffbucket/maximal/compare/v0.4.12...v0.4.13) (2026-06-08)


### Features

* Claude Code routing — lifecycle reconciler + Apps card rework ([#75](https://github.com/stuffbucket/maximal/issues/75)) ([58e1baa](https://github.com/stuffbucket/maximal/commit/58e1baae6b2cfeb603567a95b43e04a6af268bbc))
* **claude-code:** route via ~/.claude/settings.json instead of a PATH shim ([#74](https://github.com/stuffbucket/maximal/issues/74)) ([cf0f578](https://github.com/stuffbucket/maximal/commit/cf0f57809888b3f81c739b80374307c59a012c6a))
* **status:** add GET /status health endpoint + strip orphaned installer PATH block on uninstall ([#72](https://github.com/stuffbucket/maximal/issues/72)) ([9431730](https://github.com/stuffbucket/maximal/commit/9431730b4f334641c238b33e139ee9eec2e19b10))


### Bug Fixes

* **messages:** emit a terminal error event when an upstream stream drops ([#76](https://github.com/stuffbucket/maximal/issues/76)) ([1d7b0e1](https://github.com/stuffbucket/maximal/commit/1d7b0e1d9207e9b83de9fd2de728f7c18946e21e))

## [0.4.12](https://github.com/stuffbucket/maximal/compare/v0.4.11...v0.4.12) (2026-06-05)


### Bug Fixes

* **shim:** complete the Claude Code shim lifecycle (uninstall cleanup + macOS path bugs); drop max wrapper ([#67](https://github.com/stuffbucket/maximal/issues/67)) ([b465ea1](https://github.com/stuffbucket/maximal/commit/b465ea1ec03df2bc3959a7d9d5e9ef3834d0d038))

## [0.4.11](https://github.com/stuffbucket/maximal/compare/v0.4.10...v0.4.11) (2026-06-04)


### Features

* **apps:** Claude Code/Desktop integration panel + secure shim + log PII redaction ([#50](https://github.com/stuffbucket/maximal/issues/50)) ([a1abcee](https://github.com/stuffbucket/maximal/commit/a1abceedb555ee3b3bb1c07594ff48eecaa43015))

## [0.4.10](https://github.com/stuffbucket/maximal/compare/v0.4.8...v0.4.10) (2026-06-04)


### Bug Fixes

* **release-please:** accept REPOMAN_APP_ID from a variable or a secret ([#58](https://github.com/stuffbucket/maximal/issues/58)) ([bd11175](https://github.com/stuffbucket/maximal/commit/bd11175845cb37a27d399206a5a8e3d664e7e564))
