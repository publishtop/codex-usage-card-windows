# Validation scope — 0.9.4-win.10 public preview

Test date:2026-11-04. Environment:Windows11 x64, Node.js24, .NET Framework and the OpenAI.Codex Store desktop app. This remains a single-computer report.

## Quota-read repair

The repaired core passed32 Node regressions. All35 current public-tree Node tests passed, including3 distribution checks for unsupported runtimes, restart consent and a real native windowless host launching Node from a Chinese/space path. This includes the code shipped in this release, rather than only the private working tree.

New checks cover a real JSONL response delayed8.5seconds (the previous8s deadline fails; the20s deadline succeeds), single-flight asynchronous reads, heartbeat progress during requests, recent-value retention without changing its timestamp,30s expiry, immediate authentication invalidation,3/6/10s retries,60s authentication/rate-limit backoff, rebuilding a damaged network pool, stale-response isolation and inherited environment/fixed Windows proxy selection. PAC settings are not flattened.

Nine rendered assertions passed on an isolated UI55 page: dual rings, idempotent injection, recent quota retention, retry metadata, unchanged timestamp,30s expiry, authentication invalidation, recovery and text escaping. Fixture values were never used in the actual app.

Earlier live windows still exposed network-send failures after timing or proxy changes alone; a short successful window was not taken as proof of resolution. The final revision also rebuilds the reader on its first network-send failure. Its five-minute actual observation collected300 samples and31 successful read timestamps. Every sample had one placed UI55 card and unexpired data; maximum update interval15.885s and quota age15.925s. The app remained open during worker reloads. This does not establish future network uptime or zero upstream accounting delay.

An additional strict5s heartbeat target was not met: synchronous environment rediscovery produced a maximum6.472s heartbeat gap. The existing30s runtime health limit was met and no UI data expired. Do not describe every optional timing target as passed.

## Prior win.9 installer validation

- 26 Node tests passed, including unsupported runtime errors, explicit consent before restart, and an actual native windowless host starting Node from a Chinese path containing spaces.
- 10 native isolated lifecycle/guard checks passed. New tests prove the installer restart requires fresh process-specific approval, consumes it only after accepted normal exit, and preserves application refusal. TEST_BRIDGE cannot target Codex.
- The Windows PowerShell5.1 Check entry point passed dependency discovery and real read-only signed-in quota access from an extracted Chinese/space directory.
- Both production helper sources compiled successfully in that extracted directory with UTF-8 ownership metadata.
- In a separate test namespace, the real installer created its native scheduled-task host in an independent Chinese/space installation root. A heartbeat-only worker became healthy, then uninstalled successfully. The test task and empty test folder were removed. This test intentionally used a dummy worker and did not control the desktop app.

## Inherited application-core validation

The original ring appearance is retained; UI55 adds retry metadata. The prior UI54 core passed11 isolated browser checks, a real original-identity unflagged native startup handoff, and actual unique-sidebar verification. The native helper and installer sources are unchanged in win.10. All real application tests were on the same computer, not an independent fresh Windows machine.

## Privacy and limits

Screenshots use fixture data. Personal paths, real quota values, process IDs, tokens and raw private diagnostic receipts are excluded from the public package.

There is no separate clean-OS or second-computer login validation in this report. Other Windows configurations and future internal UI/protocol changes require further testing; the first public release should be a pre-release. Installation requires its documented prerequisites and may be restricted by managed-device policy.

## Reproducing

Run: node --test tests/core.test.cjs tests/native-startup.test.cjs tests/distribution.test.cjs tests/usage-reliability.test.cjs

Browser tests additionally require Playwright and Edge. Native tests compile StartupBridge.cs with TEST_BRIDGE and LifecycleFixture.cs in a separate test directory; set WSC_NATIVE_TEST_ROOT and run tests/native-lifecycle.cjs. Never substitute a production app as a test fixture.
