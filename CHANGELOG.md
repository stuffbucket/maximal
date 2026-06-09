# Changelog

## [0.4.20](https://github.com/stuffbucket/maximal/compare/v0.4.19...v0.4.20) (2026-06-09)


### Features

* **release:** build signed macOS .dmg via private macos-builder ([#89](https://github.com/stuffbucket/maximal/issues/89)) ([041678c](https://github.com/stuffbucket/maximal/commit/041678ccb4690e283f768d95e89bbaa8c707a3d7))

## [0.4.19](https://github.com/stuffbucket/maximal/compare/v0.4.18...v0.4.19) (2026-06-09)


### Bug Fixes

* **settings:** make the Copilot error banner say what actually went wrong ([#87](https://github.com/stuffbucket/maximal/issues/87)) ([c6db3c8](https://github.com/stuffbucket/maximal/commit/c6db3c8253e7b14572fea93c1c02f9c40c2c23fd))

## [0.4.18](https://github.com/stuffbucket/maximal/compare/v0.4.17...v0.4.18) (2026-06-09)


### Features

* **shell:** notify when not signed in, with a click path to sign-in ([#85](https://github.com/stuffbucket/maximal/issues/85)) ([fa2663e](https://github.com/stuffbucket/maximal/commit/fa2663e489536315e3bdfa7eb005cd5621502ad0))

## [0.4.17](https://github.com/stuffbucket/maximal/compare/v0.4.16...v0.4.17) (2026-06-09)


### Bug Fixes

* **site:** authenticate release lookup + fail closed so downloads stay live ([#83](https://github.com/stuffbucket/maximal/issues/83)) ([e86be81](https://github.com/stuffbucket/maximal/commit/e86be81b02f0a1e558f6abc8b60b90eccb4260bd))

## [0.4.16](https://github.com/stuffbucket/maximal/compare/v0.4.15...v0.4.16) (2026-06-09)


### Features

* **shell:** live splash status + show the reason when startup fails ([#81](https://github.com/stuffbucket/maximal/issues/81)) ([a5f07f6](https://github.com/stuffbucket/maximal/commit/a5f07f66d996f869927b2d62b8aa3d70b70ce6c5))

## [0.4.15](https://github.com/stuffbucket/maximal/compare/v0.4.14...v0.4.15) (2026-06-08)


### Bug Fixes

* **shell:** evict stale port holder + surface a notification on failed start ([#79](https://github.com/stuffbucket/maximal/issues/79)) ([680c640](https://github.com/stuffbucket/maximal/commit/680c640c72c723d5bbc4550dee899c6b0e683a9f))

## [0.4.14](https://github.com/stuffbucket/maximal/compare/v0.4.13...v0.4.14) (2026-06-08)


### Bug Fixes

* **shell:** close the remaining startup recovery dead-ends ([#77](https://github.com/stuffbucket/maximal/issues/77)) ([7a9713d](https://github.com/stuffbucket/maximal/commit/7a9713d424403f0e413b9c56b6f1e1e32e7c3a5c))

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
