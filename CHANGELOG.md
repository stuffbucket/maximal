# Changelog

## [0.4.24](https://github.com/stuffbucket/maximal/compare/v0.4.23...v0.4.24) (2026-06-11)


### Features

* **auth:** /accounts routes — list, switch, remove (slice 3, PR 2/3) ([#116](https://github.com/stuffbucket/maximal/issues/116)) ([547b993](https://github.com/stuffbucket/maximal/commit/547b993cd0aa4ce7516edba25458320afeb4fbf0))
* **auth:** detect the local gh CLI + its accounts (Phase 4) ([#107](https://github.com/stuffbucket/maximal/issues/107)) ([f25f6fa](https://github.com/stuffbucket/maximal/commit/f25f6fa7e05e49e06d603dca4213b50d533480e8))
* **auth:** multi-account registry store + migration (slice 3, PR 1/3) ([#115](https://github.com/stuffbucket/maximal/issues/115)) ([2862b3c](https://github.com/stuffbucket/maximal/commit/2862b3c23aa2b9fc4d8e75b936db4ff270d3026d))
* **auth:** reuse a GitHub CLI account to sign in (Phase 4) ([#108](https://github.com/stuffbucket/maximal/issues/108)) ([6bead6f](https://github.com/stuffbucket/maximal/commit/6bead6fba68123926ba16533c5969ab45822c15b))
* **shell:** ambient in-progress indicator (accent chase bar) ([#111](https://github.com/stuffbucket/maximal/issues/111)) ([dc0dcf0](https://github.com/stuffbucket/maximal/commit/dc0dcf0371ba417ecc1a9546f20f90307831d20c))
* **shell:** multi-account quick-switch UI (slice 3, PR 3/3) ([#117](https://github.com/stuffbucket/maximal/issues/117)) ([937818c](https://github.com/stuffbucket/maximal/commit/937818c34a9e4a75fa490d4a213129bfcd22bad1))
* **shell:** sign out by rebooting the sidecar, not editing it ([#106](https://github.com/stuffbucket/maximal/issues/106)) ([96341ae](https://github.com/stuffbucket/maximal/commit/96341aef686ed8fea85ad09849070ba961710281))


### Bug Fixes

* **auth:** allowlist the gh runner to read-only commands (isolation by construction) ([#112](https://github.com/stuffbucket/maximal/issues/112)) ([6294ff7](https://github.com/stuffbucket/maximal/commit/6294ff7a4eb1f3732db916ee56aa3c7fbe26527d))
* **auth:** gh-reuse — validate before reboot + refresh discovery on focus ([#113](https://github.com/stuffbucket/maximal/issues/113)) ([33ab9e7](https://github.com/stuffbucket/maximal/commit/33ab9e73804a3776e529a1bcceeb53c36a144ec9))
* **auth:** guard-timer every auth/token fetch (incl. the refresh self-loop) ([#110](https://github.com/stuffbucket/maximal/issues/110)) ([2c74667](https://github.com/stuffbucket/maximal/commit/2c74667f232e6e9478c08a9bb24424176b091370))
* **auth:** self-heal the Copilot host + clear the deprecation warning ([#101](https://github.com/stuffbucket/maximal/issues/101)) ([3ee2d7e](https://github.com/stuffbucket/maximal/commit/3ee2d7e6d1718c12f40dc9b6a04c8f5191767aae))
* **auth:** surface fatal Copilot rejection on device-code sign-in; add cancel + busy feedback ([#114](https://github.com/stuffbucket/maximal/issues/114)) ([0041f2e](https://github.com/stuffbucket/maximal/commit/0041f2e25d01c56b10132e9775f0eeff4b1dd879))
* **release:** poll for the builder's actual dmg name (Maximal.dmg) ([#98](https://github.com/stuffbucket/maximal/issues/98)) ([77bbf2e](https://github.com/stuffbucket/maximal/commit/77bbf2ebaac616d312a79e2441328578344cf93d))
* **release:** ship the macOS dmg under the versioned name pattern ([#100](https://github.com/stuffbucket/maximal/issues/100)) ([7de0cda](https://github.com/stuffbucket/maximal/commit/7de0cdaf67faae236fa33be12fef1322076e43ce))
* **shell:** poll for the reboot result after 'use a gh account' ([#109](https://github.com/stuffbucket/maximal/issues/109)) ([f96c852](https://github.com/stuffbucket/maximal/commit/f96c8521e2089645369cdf93a883cb84cb76f701))

## [0.4.23](https://github.com/stuffbucket/maximal/compare/v0.4.22...v0.4.23) (2026-06-09)


### Bug Fixes

* **release:** attach the macOS .dmg before publish (immutable-release safe) ([#96](https://github.com/stuffbucket/maximal/issues/96)) ([54f5e5d](https://github.com/stuffbucket/maximal/commit/54f5e5d0b5f01d8e5981d3e20778aee1a4842d16))

## [0.4.22](https://github.com/stuffbucket/maximal/compare/v0.4.21...v0.4.22) (2026-06-09)


### Bug Fixes

* **release:** onboard to the refreshed macos-builder (producer contract) ([#94](https://github.com/stuffbucket/maximal/issues/94)) ([8707d2a](https://github.com/stuffbucket/maximal/commit/8707d2a2cfe3663f50a503e49b3b0acff4bac3c7))

## [0.4.21](https://github.com/stuffbucket/maximal/compare/v0.4.20...v0.4.21) (2026-06-09)


### Bug Fixes

* **release:** stamp + verify the macOS bundle version (was shipping stale) ([#92](https://github.com/stuffbucket/maximal/issues/92)) ([2b36018](https://github.com/stuffbucket/maximal/commit/2b36018eae6c43f7e07eec6ed8fea68374f02bb2))

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
