# Changelog

## [0.4.42](https://github.com/stuffbucket/maximal/compare/v0.4.41...v0.4.42) (2026-07-23)


### Features

* add "menu bar only" setting; show in Dock/taskbar by default ([#304](https://github.com/stuffbucket/maximal/issues/304)) ([a6029bf](https://github.com/stuffbucket/maximal/commit/a6029bf58e31ca0d932bfbd37e94f304783fbdc4))
* **auth:** diagnose transport-layer network failures on the Copilot auth path ([#347](https://github.com/stuffbucket/maximal/issues/347)) ([ca1dcc4](https://github.com/stuffbucket/maximal/commit/ca1dcc4d839b12a47eeca568cb9b3116cab0fd49))
* **auth:** persist the GitHub refresh token and token expiry (previously discarded) ([#390](https://github.com/stuffbucket/maximal/issues/390)) ([eb375ed](https://github.com/stuffbucket/maximal/commit/eb375ed47c24022259b631c6eee957fcfc5d4fb1))
* **auth:** renew an expired GitHub token via its refresh token before degrading ([#391](https://github.com/stuffbucket/maximal/issues/391)) ([60fb33c](https://github.com/stuffbucket/maximal/commit/60fb33c88242ebc26d6a284dc8a05d1ec94e19e1))
* **design:** enforce theme.ts as the single token source in CI ([#371](https://github.com/stuffbucket/maximal/issues/371)) ([40340f4](https://github.com/stuffbucket/maximal/commit/40340f4f4ebe18483f14295ae626b3bc224fdc62)), refs [#352](https://github.com/stuffbucket/maximal/issues/352) [#354](https://github.com/stuffbucket/maximal/issues/354)
* **models:** ModelProfile resolver + fix pdf_input and reasoning-model sampling strip ([#350](https://github.com/stuffbucket/maximal/issues/350)) ([cc6c8de](https://github.com/stuffbucket/maximal/commit/cc6c8de1ae8e11d55e7dc5b381f8e4fdf8bb22bf))
* network-issue banner + account-type glyph (Settings) ([#359](https://github.com/stuffbucket/maximal/issues/359)) ([9ed94a1](https://github.com/stuffbucket/maximal/commit/9ed94a175a5f92df18f92f11db90f98686e45639))
* **ops:** add --fix autonomous-bump path to the drift watcher ([#325](https://github.com/stuffbucket/maximal/issues/325)) ([77dfb64](https://github.com/stuffbucket/maximal/commit/77dfb64ed9777036d9805ab4995802d39bf2be32))
* **ops:** add drift watch for the anthropic-version + x-github-api-version header pins ([#313](https://github.com/stuffbucket/maximal/issues/313)) ([9467704](https://github.com/stuffbucket/maximal/commit/94677041ce1ff701bb589eb389f34bd26d606b51)), refs [#307](https://github.com/stuffbucket/maximal/issues/307)
* **ops:** external-surface drift watcher with repoman triage handoff ([#310](https://github.com/stuffbucket/maximal/issues/310)) ([db940ce](https://github.com/stuffbucket/maximal/commit/db940ce7dc9bbd2ddb4866d8d1bb920eae1145d1))
* **ops:** OpenAPI proof-of-shape for /setup-status product endpoint ([#328](https://github.com/stuffbucket/maximal/issues/328)) ([aba42fb](https://github.com/stuffbucket/maximal/commit/aba42fb6ef64ebb97ae3f8b059e74372270c6e8b))
* **self-update:** land in-place self-updater consistent with the single-window redesign ([#367](https://github.com/stuffbucket/maximal/issues/367)) ([9fc46f9](https://github.com/stuffbucket/maximal/commit/9fc46f9db938498599c2070f832fcac024a86768))
* **shell:** restore section + scroll when a tray click reopens the tab ([#382](https://github.com/stuffbucket/maximal/issues/382)) ([b7effef](https://github.com/stuffbucket/maximal/commit/b7effef2b2a17d01de8f0bc694846b843ffadccc))
* **single-window:** land the single-window redesign (browser-tab delivery) ([#343](https://github.com/stuffbucket/maximal/issues/343)) ([f72996d](https://github.com/stuffbucket/maximal/commit/f72996d692f70960364ae6b6cede8d6d2105d85e))
* **token-usage:** bound the events table with a retention window ([#387](https://github.com/stuffbucket/maximal/issues/387)) ([3e04d19](https://github.com/stuffbucket/maximal/commit/3e04d19e07ee6ff32b4c8cf80667b714a7f8be4f))
* **usage:** live token-type trackers and dual traffic graphs ([#386](https://github.com/stuffbucket/maximal/issues/386)) ([a3106e0](https://github.com/stuffbucket/maximal/commit/a3106e09d5fcfa392a44f540e4c06e4ff5d428c7))
* **usage:** rework the usage view into a live, provider-forward dashboard ([#383](https://github.com/stuffbucket/maximal/issues/383)) ([520ff28](https://github.com/stuffbucket/maximal/commit/520ff28b4034482b993e1e2e792c0c0aa5ecc073))


### Bug Fixes

* **apps:** correct apiKeyHelper invocation under a runtime + mint a default endpoint key ([#388](https://github.com/stuffbucket/maximal/issues/388)) ([f116d4f](https://github.com/stuffbucket/maximal/commit/f116d4f08d8053a603653976d64a3082cfe62c7e))
* **auth:** recover sessions on wake and self-heal stale bearers, mint failures, and the model cache ([#389](https://github.com/stuffbucket/maximal/issues/389)) ([d35da0d](https://github.com/stuffbucket/maximal/commit/d35da0d3869c394f4be620e2dc19e40221dcd6b8))
* **auth:** validate GitHub/Copilot response boundaries; make the device-code poll cancellable ([#361](https://github.com/stuffbucket/maximal/issues/361)) ([052fdd6](https://github.com/stuffbucket/maximal/commit/052fdd63cff21ff1f4a96f9da73831925d255c5e))
* **cli:** make check-usage resilient to a missing premium_interactions quota key ([#311](https://github.com/stuffbucket/maximal/issues/311)) ([388f2ae](https://github.com/stuffbucket/maximal/commit/388f2ae39d278fce15ddc8ad66d4f13401b3be1d)), refs [#308](https://github.com/stuffbucket/maximal/issues/308)
* **deps:** bump serde_with to 3.21.0 (GHSA-7gcf-g7xr-8hxj) ([#362](https://github.com/stuffbucket/maximal/issues/362)) ([8d0f464](https://github.com/stuffbucket/maximal/commit/8d0f464089055f73e999df5a951339c57295caa0))
* **design:** remove dead focus-ring dashboardExpr, document single treatment ([#369](https://github.com/stuffbucket/maximal/issues/369)) ([d4bc753](https://github.com/stuffbucket/maximal/commit/d4bc7535537e40c56ee37993cbef66245284ba96)), refs [#356](https://github.com/stuffbucket/maximal/issues/356)
* **ops:** reconcile anthropic SDK spec drift baseline ([#316](https://github.com/stuffbucket/maximal/issues/316)) ([b8a013c](https://github.com/stuffbucket/maximal/commit/b8a013c746c3eb75c83f9ec444bb4aeef32dab0a))
* **release:** make release-notes step idempotent for a published release ([#302](https://github.com/stuffbucket/maximal/issues/302)) ([1bedb56](https://github.com/stuffbucket/maximal/commit/1bedb5636304632891af71be121f2a4f8c1f7b1f))
* **shell:** make the menu-bar-only toggle work in the browser-tab UI ([#380](https://github.com/stuffbucket/maximal/issues/380)) ([69ddae6](https://github.com/stuffbucket/maximal/commit/69ddae692f13fa123d9001c55d60611e19250eb3))
* **shell:** surface exactly one focused tab on every tray click ([#379](https://github.com/stuffbucket/maximal/issues/379)) ([a151a34](https://github.com/stuffbucket/maximal/commit/a151a34c99e64c23392329e3506cec152731a724))
* **token-usage:** events-page query omits total_nano_aiu and is_premium ([#312](https://github.com/stuffbucket/maximal/issues/312)) ([e6ed44e](https://github.com/stuffbucket/maximal/commit/e6ed44eaf40d853188e5092e8cd54171411b16d1)), refs [#309](https://github.com/stuffbucket/maximal/issues/309)

## [0.4.41](https://github.com/stuffbucket/maximal/compare/v0.4.40...v0.4.41) (2026-07-10)


### Bug Fixes

* **ci:** push updates manifest as app-repoman to clear require-PR ruleset ([#296](https://github.com/stuffbucket/maximal/issues/296)) ([ec7822b](https://github.com/stuffbucket/maximal/commit/ec7822b82f0212e9250c6871c341c5aebc425f7c))
* **i18n:** use "Historique" for French log strings ([#301](https://github.com/stuffbucket/maximal/issues/301)) ([b6d57a0](https://github.com/stuffbucket/maximal/commit/b6d57a0c36da3e47ab901c2e865061bd875b7fe7)), closes [#299](https://github.com/stuffbucket/maximal/issues/299)
* **site:** redirect legacy /maximal/ path to the root ([#294](https://github.com/stuffbucket/maximal/issues/294)) ([c8c4f43](https://github.com/stuffbucket/maximal/commit/c8c4f4313ff12c3a5527262635e60888b33b48f9))
* **site:** serve mxml.sh at root, not the /maximal base path ([#290](https://github.com/stuffbucket/maximal/issues/290)) ([a562cc9](https://github.com/stuffbucket/maximal/commit/a562cc94c1842c7f79e5a6aec1e4589597763689))

## [0.4.40](https://github.com/stuffbucket/maximal/compare/v0.4.39...v0.4.40) (2026-07-08)


### Features

* **billing:** price usage from Copilot token_prices, demote is_premium to legacy fallback ([#259](https://github.com/stuffbucket/maximal/issues/259)) ([#265](https://github.com/stuffbucket/maximal/issues/265)) ([7bcdc70](https://github.com/stuffbucket/maximal/commit/7bcdc706c562b523e705b624f11300910db90ca4))
* **dashboard:** add per-model + total cost column from total_nano_aiu ([#259](https://github.com/stuffbucket/maximal/issues/259)) ([#264](https://github.com/stuffbucket/maximal/issues/264)) ([7c69a9b](https://github.com/stuffbucket/maximal/commit/7c69a9b3e35301e27878a158fc0ab6df6860aed9))
* **dev:** add build-readiness verification (verify:build) + checklist ([#256](https://github.com/stuffbucket/maximal/issues/256)) ([8a3450e](https://github.com/stuffbucket/maximal/commit/8a3450e1840b2fb7f0fec6c736f3036081d2570c))
* **dev:** add dispersion stats + interleaved A/B significance to baseline harness ([#255](https://github.com/stuffbucket/maximal/issues/255)) ([e3fffce](https://github.com/stuffbucket/maximal/commit/e3fffce8038ad6817d0e09d718bdc95a8247fe6f))
* **dev:** add reusable baseline measurement harness for cost/warmup/caching ([#253](https://github.com/stuffbucket/maximal/issues/253)) ([6be5c2a](https://github.com/stuffbucket/maximal/commit/6be5c2a760445f349eaa09d4656eac8de14fbe36))
* **i18n:** add zh, fr, de, ru, ja, it, pt locales ([#285](https://github.com/stuffbucket/maximal/issues/285)) ([4b82922](https://github.com/stuffbucket/maximal/commit/4b82922afc2c02a601d2772d4ec5764360f8a4aa))
* **i18n:** full multi-locale catalog (es, en-GB, es-MX/es-ES) across settings + dashboard ([#282](https://github.com/stuffbucket/maximal/issues/282)) ([e579acb](https://github.com/stuffbucket/maximal/commit/e579acbcf079ec9accde76d99e340e08568f80a5))
* **i18n:** localize OS-conditional UI terminology via an ICU MessageFormat catalog ([#279](https://github.com/stuffbucket/maximal/issues/279)) ([a69be20](https://github.com/stuffbucket/maximal/commit/a69be20c02f7ecf93f099b42fd7173e9024b4fab))
* **i18n:** localize the native shell chrome to the picker locale ([#284](https://github.com/stuffbucket/maximal/issues/284)) ([0abc953](https://github.com/stuffbucket/maximal/commit/0abc953730e19b958c8edd9543622a7f4859d43a))
* **responses:** enable opt-in prompt_cache_retention with safe fallback ([#252](https://github.com/stuffbucket/maximal/issues/252)) ([55d1736](https://github.com/stuffbucket/maximal/commit/55d1736035884001709e7ffdbb14a995e34cbdf9))
* **setup:** add opt-in --deep-smoke for an end-to-end completion check ([#250](https://github.com/stuffbucket/maximal/issues/250)) ([7856b66](https://github.com/stuffbucket/maximal/commit/7856b665f2fa7116e8502bd8052d12af605f9b04)), closes [#227](https://github.com/stuffbucket/maximal/issues/227)
* **shell-ui:** vendor Commissioner + Fraunces web fonts locally (offline/CSP) ([#268](https://github.com/stuffbucket/maximal/issues/268)) ([d1a56df](https://github.com/stuffbucket/maximal/commit/d1a56df30f73802f73cbf5c46761827aa0eb63e7))
* **site:** extend updates manifest to schema 2 with per-channel downloads ([#267](https://github.com/stuffbucket/maximal/issues/267)) ([a21e17e](https://github.com/stuffbucket/maximal/commit/a21e17e0d5989aa263541f4ff1137ebc27ba418f)), closes [#218](https://github.com/stuffbucket/maximal/issues/218) [#219](https://github.com/stuffbucket/maximal/issues/219)
* **site:** hydrate download links + version from manifest at runtime ([#221](https://github.com/stuffbucket/maximal/issues/221)) ([#273](https://github.com/stuffbucket/maximal/issues/273)) ([1bdac36](https://github.com/stuffbucket/maximal/commit/1bdac36fe82031e9cf0113dc0ded631c223b0176)), closes [#218](https://github.com/stuffbucket/maximal/issues/218)


### Bug Fixes

* **apps:** consolidate atomic-JSON writes behind one shared helper ([#245](https://github.com/stuffbucket/maximal/issues/245)) ([d3401d4](https://github.com/stuffbucket/maximal/commit/d3401d4d5a3655ac8d4a4a92ab8162d52aee1f69)), closes [#231](https://github.com/stuffbucket/maximal/issues/231)
* **pages:** prevent duplicate github-pages artifacts on deploy re-run ([#239](https://github.com/stuffbucket/maximal/issues/239)) ([#263](https://github.com/stuffbucket/maximal/issues/263)) ([108d1bb](https://github.com/stuffbucket/maximal/commit/108d1bbc3e9d0aaf300f45f6b2bf5b1bfefc087a))
* **security:** remove /token route that leaked the raw Copilot token ([#240](https://github.com/stuffbucket/maximal/issues/240)) ([43655f9](https://github.com/stuffbucket/maximal/commit/43655f981e0f1376eb020760943c6bd352a8f43d)), closes [#230](https://github.com/stuffbucket/maximal/issues/230)
* **web-tools:** sum usage across agent turns and add keepalive pings ([#246](https://github.com/stuffbucket/maximal/issues/246)) ([7826578](https://github.com/stuffbucket/maximal/commit/78265785bf229e8cfac419d0f25285037c513fb8))
* **web-tools:** sum usage across turns in non-streaming agent path ([#260](https://github.com/stuffbucket/maximal/issues/260)) ([#261](https://github.com/stuffbucket/maximal/issues/261)) ([3f0e6d4](https://github.com/stuffbucket/maximal/commit/3f0e6d44b18ab102a18b4519db387f84e46d48c9))


### Performance Improvements

* **warmup:** short-circuit Claude Code warmup requests locally instead of round-tripping ([#258](https://github.com/stuffbucket/maximal/issues/258)) ([#262](https://github.com/stuffbucket/maximal/issues/262)) ([8d3ee4d](https://github.com/stuffbucket/maximal/commit/8d3ee4d0da288046e575ae7bfa01463bf7b23d79))

## [0.4.39](https://github.com/stuffbucket/maximal/compare/v0.4.38...v0.4.39) (2026-07-03)


### Features

* **server:** stamp x-maximal-version response header on all responses ([#213](https://github.com/stuffbucket/maximal/issues/213)) ([d45bd8e](https://github.com/stuffbucket/maximal/commit/d45bd8e63c99e74e93baccc351808e5f20ea2e25))
* **web-tools:** no-key web_search via Copilot /responses, DuckDuckGo fallback ([#205](https://github.com/stuffbucket/maximal/issues/205)) ([6cbdb36](https://github.com/stuffbucket/maximal/commit/6cbdb36a8bcd96bc015d9ad3999f84ea6f828aa3)), closes [#204](https://github.com/stuffbucket/maximal/issues/204)


### Bug Fixes

* **claude-desktop:** restore MCP/extension keys, fix Artifacts preview ([#203](https://github.com/stuffbucket/maximal/issues/203)) ([4037fe4](https://github.com/stuffbucket/maximal/commit/4037fe427cacf164ff015a0f51ba3470e5ed5cdd)), closes [#188](https://github.com/stuffbucket/maximal/issues/188)
* **thinking:** honor client extended-thinking display and disable on Copilot-served Claude ([#211](https://github.com/stuffbucket/maximal/issues/211)) ([e5510a5](https://github.com/stuffbucket/maximal/commit/e5510a5612236342c8ccd7824e3196439945e022))
* **web-tools:** align web_fetch domain matching with spec-correct web_search matcher ([#209](https://github.com/stuffbucket/maximal/issues/209)) ([0cccb40](https://github.com/stuffbucket/maximal/commit/0cccb40453011960f91c9651c8434cde94e0ce78))

## [0.4.38](https://github.com/stuffbucket/maximal/compare/v0.4.37...v0.4.38) (2026-07-03)


### Bug Fixes

* **auth:** tear down Copilot refresh loop cleanly on abort ([#197](https://github.com/stuffbucket/maximal/issues/197)) ([18ca76e](https://github.com/stuffbucket/maximal/commit/18ca76e1009d254e449a1e58110bca84f2afc0c3))
* **ci:** stop CodeQL Reconcile crashing on alert re-open ([#195](https://github.com/stuffbucket/maximal/issues/195)) ([68620c2](https://github.com/stuffbucket/maximal/commit/68620c2b34dbea5af2f2220eab1c749dea4ab18c))
* **errors:** make model_not_supported advice client-neutral ([#201](https://github.com/stuffbucket/maximal/issues/201)) ([be26b58](https://github.com/stuffbucket/maximal/commit/be26b580b8b5c7a3622687f5a588cee21b8f50fd))
* **messages:** default Claude Code haiku tier to a tool-competent model ([#191](https://github.com/stuffbucket/maximal/issues/191)) ([6df203c](https://github.com/stuffbucket/maximal/commit/6df203c5f6755c6ca1c493442ad526ff16912af3))

## [0.4.37](https://github.com/stuffbucket/maximal/compare/v0.4.36...v0.4.37) (2026-06-30)


### Features

* **apps:** registry-driven app integrations, generic apiKeyHelper, UI harness ([#189](https://github.com/stuffbucket/maximal/issues/189)) ([f714537](https://github.com/stuffbucket/maximal/commit/f714537a6fb39e21b89b03ee1dad71fadf68c739))

## [0.4.36](https://github.com/stuffbucket/maximal/compare/v0.4.35...v0.4.36) (2026-06-25)


### Bug Fixes

* **site:** Windows installer pickup + light-mode god-rays + stale-cache bypass ([#182](https://github.com/stuffbucket/maximal/issues/182)) ([2829bfc](https://github.com/stuffbucket/maximal/commit/2829bfc9301f47e2ad7cd0df1253fed0616c85ae))
* **update:** dev build of current release no longer self-reports an upgrade ([#186](https://github.com/stuffbucket/maximal/issues/186)) ([389d081](https://github.com/stuffbucket/maximal/commit/389d08127b5a9d40dfb33cfeb7f44a7259fb7eb0))

## [0.4.35](https://github.com/stuffbucket/maximal/compare/v0.4.34...v0.4.35) (2026-06-24)


### Features

* **shell:** warn to restart Claude Code when disabling routing on Windows ([c881305](https://github.com/stuffbucket/maximal/commit/c881305e69dd2af6b6e4dd76ae69f357b01acb20))
* Windows tray parity + god-rays site redesign (v0.4.35) ([1164d79](https://github.com/stuffbucket/maximal/commit/1164d7989a64d24af24814624824e6ae8bdb868e))
* Windows tray parity + god-rays site redesign (v0.4.35) ([#181](https://github.com/stuffbucket/maximal/issues/181)) ([1164d79](https://github.com/stuffbucket/maximal/commit/1164d7989a64d24af24814624824e6ae8bdb868e))


### Bug Fixes

* **auth:** prime models cache after device-flow sign-in ([#177](https://github.com/stuffbucket/maximal/issues/177)) ([8259883](https://github.com/stuffbucket/maximal/commit/8259883fdb35520b398bac11595289598191b458))
* **shell:** show splash only once the webview has painted ([6fdb0fc](https://github.com/stuffbucket/maximal/commit/6fdb0fcb17d2202fb901852a1ed619a25702a094))
* **shell:** windows startup notification — system tray + down arrow ([ba14174](https://github.com/stuffbucket/maximal/commit/ba14174c5bbade3c5fbd60f5b79e4befd64e157e))
* **windows:** correct Claude Desktop 3P dir to %LOCALAPPDATA% + fix detection ([f010499](https://github.com/stuffbucket/maximal/commit/f0104990b4f9b81f3f9f6f36d40d3fd8ba6c797d))
* **windows:** detect MSIX/Store Claude Desktop install ([aba5850](https://github.com/stuffbucket/maximal/commit/aba5850cedc8054d5475598c406e6453cd8ce3f1))

## [0.4.34](https://github.com/stuffbucket/maximal/compare/v0.4.33...v0.4.34) (2026-06-24)


### Bug Fixes

* **windows:** slim CLI installers to binary-on-PATH; verify tray launcher ([#176](https://github.com/stuffbucket/maximal/issues/176)) ([db06e44](https://github.com/stuffbucket/maximal/commit/db06e445d1507321448e5c2f23a5c17341c2e05f))

## [0.4.33](https://github.com/stuffbucket/maximal/compare/v0.4.32...v0.4.33) (2026-06-24)


### Features

* **update:** add beta manifest channel ([5b4fb02](https://github.com/stuffbucket/maximal/commit/5b4fb028ebe243952347dfd0475ce214b461eb5c))
* **update:** drive the update channel from the build's MAXIMAL_CHANNEL ([#166](https://github.com/stuffbucket/maximal/issues/166)) ([ae0ca68](https://github.com/stuffbucket/maximal/commit/ae0ca687003c89f171aa03efc97e9e06d4140c3a))
* **windows:** functional parity with macOS — tray app, %APPDATA% paths, Claude discovery, fixed installers ([#172](https://github.com/stuffbucket/maximal/issues/172)) ([708568c](https://github.com/stuffbucket/maximal/commit/708568cba4a3911d00ac09fef73f3640eda3b392))


### Bug Fixes

* **dev:** self-heal the ui-embed stub so fresh worktrees pass the gates ([#161](https://github.com/stuffbucket/maximal/issues/161)) ([baff99e](https://github.com/stuffbucket/maximal/commit/baff99e29b01e3b05901f7a9b5220a880b07b402))
* **update:** compare prerelease versions ([45e63fc](https://github.com/stuffbucket/maximal/commit/45e63fc03329b5beb97977f64712ef4ae1bce41b))

## [0.4.32](https://github.com/stuffbucket/maximal/compare/v0.4.31...v0.4.32) (2026-06-22)


### Features

* detect new versions and surface an in-app upgrade prompt ([#157](https://github.com/stuffbucket/maximal/issues/157)) ([3cd63bb](https://github.com/stuffbucket/maximal/commit/3cd63bb51d1e5d3ec76292720a1eccb4c63f4460))
* **errors:** reframe opaque upstream errors with context + recovery ([#156](https://github.com/stuffbucket/maximal/issues/156)) ([5a03386](https://github.com/stuffbucket/maximal/commit/5a03386c9cb0e889d304a0512fe3d799910523da))
* **shell:** defer first-run Settings + show version on splash and Settings titlebar ([#154](https://github.com/stuffbucket/maximal/issues/154)) ([a9c8aae](https://github.com/stuffbucket/maximal/commit/a9c8aaec79f2b0f2444cd9508fa8fb37943e1fc2))


### Bug Fixes

* **claude-desktop:** wire Cowork 3P at the gateway via Claude-3p config library ([#159](https://github.com/stuffbucket/maximal/issues/159)) ([3a36604](https://github.com/stuffbucket/maximal/commit/3a366047221127ebba9ad34e677f446dd6e9beec))

## [0.4.31](https://github.com/stuffbucket/maximal/compare/v0.4.30...v0.4.31) (2026-06-22)


### Features

* **shell:** in-app uninstall button replacing copy-to-terminal ([#150](https://github.com/stuffbucket/maximal/issues/150)) ([57837e9](https://github.com/stuffbucket/maximal/commit/57837e94583950a1de8a37ea6a1b668202652190))


### Bug Fixes

* **ci:** auto-flip release PR label pending → tagged after tagging ([#152](https://github.com/stuffbucket/maximal/issues/152)) ([3ee9b8c](https://github.com/stuffbucket/maximal/commit/3ee9b8c622f8b628f8535fa2fd1554471b1667b2))

## [0.4.30](https://github.com/stuffbucket/maximal/compare/v0.4.29...v0.4.30) (2026-06-22)


### Bug Fixes

* **ci:** auto-dispatch release.yml for unpublished tagged releases ([#139](https://github.com/stuffbucket/maximal/issues/139)) ([40ab095](https://github.com/stuffbucket/maximal/commit/40ab095459b5fa9a82fc80f91ad52ee06b5fdc4c))
* **ci:** grant actions:write so release-please can dispatch release.yml ([#140](https://github.com/stuffbucket/maximal/issues/140)) ([d700c31](https://github.com/stuffbucket/maximal/commit/d700c313740c8cc6a959758fd9208256d015bde0))
* **ci:** pass required tag input when auto-dispatching release.yml ([#141](https://github.com/stuffbucket/maximal/issues/141)) ([0c41c78](https://github.com/stuffbucket/maximal/commit/0c41c7852c635b6ff8817cfcb5b977cc47fbca7c))
* **cli:** show 'maximal' instead of legacy 'copilot-api' in debug/setup output ([#3](https://github.com/stuffbucket/maximal/issues/3)) ([#145](https://github.com/stuffbucket/maximal/issues/145)) ([6dba335](https://github.com/stuffbucket/maximal/commit/6dba335333e9a1d1872be290b123526589f065fe))
* **messages:** strip unsupported top-level diagnostics field from inbound requests ([#127](https://github.com/stuffbucket/maximal/issues/127)) ([#143](https://github.com/stuffbucket/maximal/issues/143)) ([f301dc1](https://github.com/stuffbucket/maximal/commit/f301dc104ac32692ddf3e266a683a3c74dc6eb22))

## [0.4.29](https://github.com/stuffbucket/maximal/compare/v0.4.28...v0.4.29) (2026-06-18)


### Bug Fixes

* **release:** update stale lockfile and pin bun version in release.yml ([#137](https://github.com/stuffbucket/maximal/issues/137)) ([4bdc182](https://github.com/stuffbucket/maximal/commit/4bdc1824725fb79e6be8fabb72704d79090d0869))

## [0.4.28](https://github.com/stuffbucket/maximal/compare/v0.4.27...v0.4.28) (2026-06-18)


### Features

* **shell:** browser-window UI rewrite — account hero, update alerts, refresh feedback ([#135](https://github.com/stuffbucket/maximal/issues/135)) ([f861a72](https://github.com/stuffbucket/maximal/commit/f861a72e958477c4dc411bbdaf532ffaa4f7e30d))

## [0.4.27](https://github.com/stuffbucket/maximal/compare/v0.4.26...v0.4.27) (2026-06-18)


### Bug Fixes

* **auth:** retain credentials on upstream failure; tolerate sparse model catalog ([#133](https://github.com/stuffbucket/maximal/issues/133)) ([911de65](https://github.com/stuffbucket/maximal/commit/911de65b16ea65cc594d6613657aa9f5d3bc9279))

## [0.4.26](https://github.com/stuffbucket/maximal/compare/v0.4.25...v0.4.26) (2026-06-17)


### Features

* **cli:** symlink DMG CLI onto PATH + show launch path in diagnostics ([#129](https://github.com/stuffbucket/maximal/issues/129)) ([1e70756](https://github.com/stuffbucket/maximal/commit/1e7075695e619e88f459bb675cfc74019e1aac8b))
* **settings:** models section with capabilities + manual refresh ([#130](https://github.com/stuffbucket/maximal/issues/130)) ([1e70756](https://github.com/stuffbucket/maximal/commit/1e7075695e619e88f459bb675cfc74019e1aac8b))

## [0.4.25](https://github.com/stuffbucket/maximal/compare/v0.4.24...v0.4.25) (2026-06-16)


### Bug Fixes

* **auth:** show a readable message when Copilot token mint is rejected ([#124](https://github.com/stuffbucket/maximal/issues/124)) ([59ab92d](https://github.com/stuffbucket/maximal/commit/59ab92da643a19dfb5db5164a25bffe19290c680))
* **claude-desktop:** persist deploymentMode=3p and enable Cowork web search ([#128](https://github.com/stuffbucket/maximal/issues/128)) ([e0599a7](https://github.com/stuffbucket/maximal/commit/e0599a7d0f75870368b03bbc6b8f4975f63ccc47))
* **shell:** show known-account roster in the failed/device-code states ([#125](https://github.com/stuffbucket/maximal/issues/125)) ([abd4df2](https://github.com/stuffbucket/maximal/commit/abd4df2722e137b5d3f832192ab95e76fc87e882))

## [0.4.24](https://github.com/stuffbucket/maximal/compare/v0.4.23...v0.4.24) (2026-06-15)


### Features

* **auth:** /accounts routes — list, switch, remove (slice 3, PR 2/3) ([#116](https://github.com/stuffbucket/maximal/issues/116)) ([547b993](https://github.com/stuffbucket/maximal/commit/547b993cd0aa4ce7516edba25458320afeb4fbf0))
* **auth:** AuthStatus union, live SSE updates, and sign-in/window fixes (ADR-0006/0007) ([#121](https://github.com/stuffbucket/maximal/issues/121)) ([08de601](https://github.com/stuffbucket/maximal/commit/08de601601f5eb3a9f944b6687b756b47bb5e0ac))
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
* **shell:** DEV baseUrl must target the sidecar on :4141, not :4142 ([#119](https://github.com/stuffbucket/maximal/issues/119)) ([f699f28](https://github.com/stuffbucket/maximal/commit/f699f2824c3c25d792d2fb9c7f6e7e710d8bb90d))
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
