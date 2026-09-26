# Changelog

All notable changes to this project will be documented in this file.

The format follows [Conventional Commits](https://www.conventionalcommits.org/) and is generated with [cocogitto](https://docs.cocogitto.io/).

<!-- next-header -->

## Unreleased ([3886bac..4e6910c](https://github.com/codefuturist/email-mcp/compare/3886bac..4e6910c))

#### ✨ Features

- **(alerts)** add notification setup diagnostics and AI-configurable alerts - ([34e288a](https://github.com/codefuturist/email-mcp/commit/34e288acb3a3330fd4eca0a583540ec877d9912c))
- **(alerts)** add urgency-based multi-channel notification system - ([b2425df](https://github.com/codefuturist/email-mcp/commit/b2425df6c917436e056e5cc8002ce684fc898694))
- **(cli)** add notify command for testing desktop notifications - ([687f7d2](https://github.com/codefuturist/email-mcp/commit/687f7d26449d97d56bd9d94b7e67f3b798b8e13e))
- **(cli)** add interactive MCP client installation command - ([e2369c7](https://github.com/codefuturist/email-mcp/commit/e2369c7f03df1e506b0bb11e0e5c471a0313ec6b))
- **(cli)** add interactive account CRUD and config edit commands - ([aaa8af5](https://github.com/codefuturist/email-mcp/commit/aaa8af501e7738cf049bd0b4a29ee74f0dbee3bb))
- **(hooks)** add customizable presets and static rule matching - ([138c08e](https://github.com/codefuturist/email-mcp/commit/138c08e0708f49e795e036e2245022fe060a0950))
- **(watcher)** add IMAP IDLE monitoring with AI triage - ([5ed0388](https://github.com/codefuturist/email-mcp/commit/5ed0388ccb0a781220407b3800723bf8191eb2f9))
- add AI-optimised email tools and context improvements - ([d7b01a4](https://github.com/codefuturist/email-mcp/commit/d7b01a48e57491d68ac605583ede6c1a92b2b70d))
- add provider-aware label management (ProtonMail/Gmail/IMAP keywords) - ([85609e5](https://github.com/codefuturist/email-mcp/commit/85609e5f181ea3c01ef26b4fe27a69bafb549141))
- add IMAP move/delete reliability and find_email_folder tool - ([3886bac](https://github.com/codefuturist/email-mcp/commit/3886bacc83eb8b4200f16695468e9029ade32c40))

#### 🐛 Bug Fixes

- **(cli)** add TTY guard and fix IMAP STARTTLS display - ([d9bca69](https://github.com/codefuturist/email-mcp/commit/d9bca695af07e311ec249379827c175e8dac483b))
- virtual folder detection and find_email_folder reliability - ([3c44c22](https://github.com/codefuturist/email-mcp/commit/3c44c226e7b3bf2666479e4d5761c8777d8c5e9c))

#### 📚 Documentation

- update tool count to 42 in README - ([4e6910c](https://github.com/codefuturist/email-mcp/commit/4e6910c04a8dd46efc739079c8e6aa613a7edfaf))
- add pnpm install and usage instructions - ([13c8d4b](https://github.com/codefuturist/email-mcp/commit/13c8d4bf3006fa4fb5f014eb630006a478082a23))

- - -
## [v0.4.1](https://github.com/codefuturist/email-mcp/compare/bae1bb7d5c6f603e34166c702eccaf190c0915a0..v0.4.1) - 2026-09-26
#### Build
- (**deps**) upgrade all dependencies to latest stable - ([bae1bb7](https://github.com/codefuturist/email-mcp/commit/bae1bb7d5c6f603e34166c702eccaf190c0915a0)) - Kithrian, Claude Fable 5

- - -

## [v0.4.0](https://github.com/codefuturist/email-mcp/compare/03b3b0233e5e65b1fa30324f3859860e061b364d..v0.4.0) - 2026-09-26
#### ✨ Features
- (**cache**) add offline-capable local mirror - ([29106e8](https://github.com/codefuturist/email-mcp/commit/29106e8059fb86d9b94bfdaa4640ffdd66d994d3)) - Kithrian, Claude Opus 5 (1M context)
- (**cli**) server lifecycle commands for an always-on HTTP daemon - ([755eb39](https://github.com/codefuturist/email-mcp/commit/755eb3900bcdb7c11550a98aaf74b9671dce5711)) - Kithrian, Claude Fable 5
- (**cli**) section editor for config edit + full config show - ([17efd45](https://github.com/codefuturist/email-mcp/commit/17efd45bfa6f90208fe47ef14f4828b9d03d4080)) - Kithrian, Claude Fable 5
- (**cli**) settings field catalog - ([00d559b](https://github.com/codefuturist/email-mcp/commit/00d559bd43de94ad0f859463d2b9b0e61ff8b40f)) - Kithrian, Claude Fable 5
- (**clipboard**) add zero-dep clipboard service with concealed writes - ([dad7045](https://github.com/codefuturist/email-mcp/commit/dad70451898f85f4f097c789b4b2a70edc1c6274)) - Kithrian, Claude Fable 5
- (**config**) saveConfigValidated with backup - ([c2d0a9d](https://github.com/codefuturist/email-mcp/commit/c2d0a9d144d6531d2e70bbb5799532f9648c964d)) - Kithrian, Claude Fable 5
- (**goreleaser**) use base.yaml + monorepo config - ([45beb34](https://github.com/codefuturist/email-mcp/commit/45beb34666e227909fda75e77a8677029ddbbe79)) - Colin, Copilot
- (**notifier**) add notifyRaw for caller-controlled notifications - ([c688f60](https://github.com/codefuturist/email-mcp/commit/c688f600516ff0139a7bb3ea773f207fccab8fa2)) - Kithrian, Claude Fable 5
- (**sdk**) migrate to MCP SDK v2 and modernize tooling - ([a309a67](https://github.com/codefuturist/email-mcp/commit/a309a6704ad1cd737d087f1e7ab57bb344156e79)) - Kithrian, Claude Opus 5 (1M context)
- (**verification**) configure_verification tool with live catcher toggle - ([f9c8434](https://github.com/codefuturist/email-mcp/commit/f9c843468aaee2e2af027c9c0a1b91b69bd051da)) - Kithrian, Claude Fable 5
- (**verification**) add confirm-before-copy and open-in-browser for links - ([6cd81e2](https://github.com/codefuturist/email-mcp/commit/6cd81e2b8bb4ad454b54f099e98ea91813bf2493)) - Kithrian, Claude Fable 5
- (**verification**) expose get_verification_code and check_clipboard_setup - ([2d5b862](https://github.com/codefuturist/email-mcp/commit/2d5b8626624a6db3b77d4effa345fea2cad0036d)) - Kithrian, Claude Fable 5
- (**verification**) add ambient catcher service and scanRecent - ([20e2da8](https://github.com/codefuturist/email-mcp/commit/20e2da80e74d6cd29f6ca8f3fdd45a5296c3dce0)) - Kithrian, Claude Fable 5
- (**verification**) add one-shot dedup state with pruning - ([0f3f04f](https://github.com/codefuturist/email-mcp/commit/0f3f04f4fa4c5c3c6bfef600197502b0cb5f3fe2)) - Kithrian, Claude Fable 5
- (**verification**) add [settings.verification] config section - ([c45f354](https://github.com/codefuturist/email-mcp/commit/c45f354df3ef3c4c8ea70b994c3e906f5e9bbd61)) - Kithrian, Claude Fable 5
- (**verification**) add magic-link extractor - ([321dc80](https://github.com/codefuturist/email-mcp/commit/321dc8010b562d09dbd147391a3c1b73fd3923a5)) - Kithrian, Claude Fable 5
- (**verification**) add scored OTP code extractor - ([4862d5f](https://github.com/codefuturist/email-mcp/commit/4862d5fa6ebc6c0f0bd570d19f395d135309b739)) - Kithrian, Claude Fable 5
#### 🐛 Bug Fixes
- (**hooks**) detach only own email:new listener on stop - ([d5ace5e](https://github.com/codefuturist/email-mcp/commit/d5ace5e3a4664c962f1b21a930f0bf03eadefc38)) - Kithrian, Claude Fable 5
- (**imap**) report server rejections and stop deadlocking get_thread - ([7fe8916](https://github.com/codefuturist/email-mcp/commit/7fe8916b90fba852267894091a5e6d3ca1bf168d)) - Kithrian, Claude Opus 5 (1M context)
- (**imap**) decode message bodies instead of returning raw source - ([439a1e5](https://github.com/codefuturist/email-mcp/commit/439a1e547cc24eed91b9acfada620065ff859283)) - Kithrian, Claude Opus 5 (1M context)
- (**imap**) correct MIME and UID handling - ([5bd96af](https://github.com/codefuturist/email-mcp/commit/5bd96afdb65660e21acfd3386a11a9e81b7348f2)) - Kithrian, Claude Opus 5 (1M context)
- (**release**) stage manifests in bump commit and push v-prefixed tag - ([57905c4](https://github.com/codefuturist/email-mcp/commit/57905c4751d58f746445e2a4e0dc12bec2d74f6d)) - Kithrian, Claude Fable 5
- (**watcher,hooks**) repair flag writes and surface mailbox changes - ([606b1b5](https://github.com/codefuturist/email-mcp/commit/606b1b540c8afd582544290ec00e1ca2aa2789ee)) - Kithrian, Claude Opus 5 (1M context)
- correct goreleaser base path - ([c24dd3e](https://github.com/codefuturist/email-mcp/commit/c24dd3e56fdfa71a11ee433e8edb11afda0302c9)) - Kithrian, Copilot
- exclude lock files from biome pre-commit check - ([1e51628](https://github.com/codefuturist/email-mcp/commit/1e5162839fd007a7af0a68151f08236f2f32edaf)) - Colin, Copilot
#### 📚 Documentation
- (**config**) document interactive editor, backups, and 52 tools - ([944f9cf](https://github.com/codefuturist/email-mcp/commit/944f9cf941628b16f0d2d4e2e6db1539e8ce8979)) - Kithrian, Claude Fable 5
- (**verification**) document instant OTP catch and update tool counts - ([dd251f7](https://github.com/codefuturist/email-mcp/commit/dd251f7cbbfa46b74033fbcf9be39500d18cc7d3)) - Kithrian, Claude Fable 5
- add Mistral Vibe MCP client installation instructions - ([643fb18](https://github.com/codefuturist/email-mcp/commit/643fb18b9e0c3c241143991db6825d7ca174921a)) - Colin
- add scheduler daemon setup instructions and delivery requirements - ([cbc3042](https://github.com/codefuturist/email-mcp/commit/cbc3042bcc4ae8c33e7586519b7065ba2b0f264d)) - Colin
- expand VS Code Copilot setup (all 3 methods) and add Zed client - ([9e1f785](https://github.com/codefuturist/email-mcp/commit/9e1f78518833048c9fd56a37110d0dc54da538ce)) - Colin
#### Tests
- (**verification**) add GreenMail integration coverage - ([fdf8b7d](https://github.com/codefuturist/email-mcp/commit/fdf8b7d127b412cd57a555fdab32a126ad6086a9)) - Kithrian, Claude Fable 5
#### ♻️ Refactoring
- (**cli**) move cancel helpers into guard - ([060702d](https://github.com/codefuturist/email-mcp/commit/060702d613f7d261ab09a5efc9446e7a264d6fcf)) - Kithrian, Claude Fable 5
- (**config**) route config writes through validated save - ([c45c7bf](https://github.com/codefuturist/email-mcp/commit/c45c7bfa01769b3a3c0d19a95e9fab75639f95b4)) - Kithrian, Claude Fable 5
- (**utils**) extract glob matching and reply-chain stripping - ([d7ae7ca](https://github.com/codefuturist/email-mcp/commit/d7ae7cac8464aed0db12fcafde6a94e81d718ca8)) - Kithrian, Claude Fable 5
#### Chores
- normalize server.json formatting - ([4034b78](https://github.com/codefuturist/email-mcp/commit/4034b78715f1ab20306f969ec963b9f0df0aae4d)) - Colin, Copilot
- fix cog post_bump_hooks to sync package.json and server.json versions - ([03b3b02](https://github.com/codefuturist/email-mcp/commit/03b3b0233e5e65b1fa30324f3859860e061b364d)) - Colin

- - -

## [v0.2.1](https://github.com/codefuturist/email-mcp/compare/bd6f94d6f0d1f7f4beca5aa8061f2892a40f0ce0..v0.2.1) - 2026-02-20
#### 🐛 Bug Fixes
- (**labels**) fix critical parameter swap and multiple label bugs - ([bd6f94d](https://github.com/codefuturist/email-mcp/commit/bd6f94d6f0d1f7f4beca5aa8061f2892a40f0ce0)) - Colin
- defer post-connect work until MCP handshake completes - ([7847da0](https://github.com/codefuturist/email-mcp/commit/7847da07b4241e73282b2a36a9dd1a362dfb8656)) - Colin
#### Tests
- (**integration**) expand plain connection tests to match STARTTLS and SSL coverage - ([8bd3d77](https://github.com/codefuturist/email-mcp/commit/8bd3d7752ca18037ca899899a1e14688b961c0b1)) - Colin
- (**integration**) add connection mode tests for plain, STARTTLS, and implicit SSL - ([ccbefb7](https://github.com/codefuturist/email-mcp/commit/ccbefb78248f0f08d31c5b227347f286f350c9f9)) - Colin
- (**integration**) add integration test suite with GreenMail and Testcontainers - ([1cc72fe](https://github.com/codefuturist/email-mcp/commit/1cc72fec8166842fa92ad8c7957c2ec28df327ac)) - Colin
#### Build
- (**docker**) add OCI manifest annotations for GHCR multi-arch images - ([2aeb938](https://github.com/codefuturist/email-mcp/commit/2aeb93857e95d99b2cf4435e4eee7cd7a47aecdc)) - Colin
- (**docker**) add docker and goreleaser scripts, fix build for dockers_v2 context - ([56102f4](https://github.com/codefuturist/email-mcp/commit/56102f42ce81bba8c9ab8f442926d1b9704d2ab4)) - Colin
- (**docker**) add GoReleaser dockers_v2 for GHCR and Docker Hub publishing - ([83483a8](https://github.com/codefuturist/email-mcp/commit/83483a8879228b3ec213414f2f7c53e9cce3f497)) - Colin
- (**docker**) add Dockerfile, docker-compose, and CI docker build - ([e9f0a9f](https://github.com/codefuturist/email-mcp/commit/e9f0a9f2179a59de064879456204c8c3b4f3945b)) - Colin
- add lefthook git hooks, report output, upgrade actions and node to v24 - ([8665419](https://github.com/codefuturist/email-mcp/commit/86654197b1a1f252d6c67d8a5fd67f09100f4fd4)) - Colin
#### CI
- (**docker**) enable docker hub publishing - ([f2a8d44](https://github.com/codefuturist/email-mcp/commit/f2a8d44fb8e503a0ef053a716e00b5814625daf8)) - Colin
- refactor workflows to use codefuturist/shared-workflows@v1 - ([815292c](https://github.com/codefuturist/email-mcp/commit/815292c91e6215592cd3172a91600cf42b2224e0)) - Colin
- add docker-sha workflow, workflow_dispatch, action upgrades and lint fixes - ([ddfbcdc](https://github.com/codefuturist/email-mcp/commit/ddfbcdc27af83175c3fec3c666ebd1f23d0631f4)) - Colin
- improve Docker tag strategy - ([99785a0](https://github.com/codefuturist/email-mcp/commit/99785a0ea5c01579046783c3fdf7347932e77fdb)) - Colin
- add weekly Docker rebuild workflow for base image updates - ([08f77f9](https://github.com/codefuturist/email-mcp/commit/08f77f9d06c8fd5b6de65a08c9ff89b556e7f2c0)) - Colin
#### Chores
- (**eslint**) exclude integration tests from eslint - ([e3bcc12](https://github.com/codefuturist/email-mcp/commit/e3bcc122bb9d71bfdfd77040d4419b96296a162d)) - Colin
- (**gitignore**) update .gitignore to include comprehensive rules for various environments and tools - ([4c55dea](https://github.com/codefuturist/email-mcp/commit/4c55dea709e592f3e9f8b01d449846742774c07f)) - Colin
- fix changelog separator for cocogitto - ([55510c3](https://github.com/codefuturist/email-mcp/commit/55510c34bb44ac377e91e1c628d7a810ed2e6d6e)) - Colin

- - -


## [v0.1.0](https://github.com/codefuturist/email-mcp/releases/tag/v0.1.0) — Initial Release

First public release of email-mcp.

#### ✨ Features

- Full IMAP + SMTP email server for MCP clients
- 42 tools, 7 prompts, 6 resources
- Multi-account support with XDG-compliant TOML config
- Guided interactive setup wizard with provider auto-detection
- Gmail, Outlook, Yahoo, iCloud, Fastmail, ProtonMail, Zoho, GMX support
- OAuth2 XOAUTH2 for Gmail and Microsoft 365 _(experimental)_
- Email scheduling with OS-level scheduler integration
- Real-time IMAP IDLE watcher with AI-powered triage
- Urgency-based desktop / webhook alerts
- Provider-aware label management
- ICS/iCalendar extraction from emails
- Email analytics (volume, top senders, daily trends)
- Token-bucket rate limiter and audit trail
- MCP client auto-installer (Claude Desktop, VS Code, Cursor, Windsurf)
