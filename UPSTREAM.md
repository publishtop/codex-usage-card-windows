# Upstream attribution and Windows modifications

Based on [Lorie7813/codex-usage-card](https://github.com/Lorie7813/codex-usage-card), release `v0.9.4-beta.1`.

- Original archive: `CodexUsageCard-macOS-0.9.4.zip`.
- Original archive SHA-256: `e41cbb00fd01b785eb0cac73a946115a35dd2d9a2410c196ec7287ce4b1737f8`.
- The original MIT license and copyright notice are retained verbatim in `LICENSE`.

This is a community-maintained Windows port, not an official upstream or OpenAI Windows release.

The original UI53 dual-ring appearance is retained. Component version54 adds the last successful read timestamp and a30-second stale-data guard. The port adds Windows per-user task installation, current Store package/CLI discovery, loopback-only CDP validation, explicit UTF-8 transport, read-only usage RPC allowlisting, native startup observation, guarded normal-exit/relaunch, Spotlight target exclusion and live sidebar verification. Quota is actively read every10seconds and updated on notifications.

The package does not bundle the macOS updater, alter the signed Codex application, or forcibly terminate it. Newly launched app instances can be politely closed and reopened once under startup guards. Already-running work windows are baselined. No separate desktop launcher icon is generated.

This distribution intentionally omits local account telemetry, private diagnostic traces, authentication data and machine-specific test receipts.

Public packaging version win.9 adds prerequisite/account checks, readiness verification, an explicit-consent normal-restart command, UTF-8-safe Windows metadata reads and a windowless .NET AgentHost with Unicode path support. Personal migration logic for removing other plugins and old launcher shortcuts is excluded.
