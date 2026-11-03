# Validation scope — 0.9.4-win.9 public preview

Test date:2026-11-03. Test computer:Windows11 x64, Node.js24, .NET Framework, OpenAI.Codex Store package26.1027.6604.0.

## Public installer validation

- 26 Node tests passed, including unsupported runtime errors, explicit consent before restart, and an actual native windowless host starting Node from a Chinese path containing spaces.
- 10 native isolated lifecycle/guard checks passed. New tests prove the installer restart requires fresh process-specific approval, consumes it only after accepted normal exit, and preserves application refusal. TEST_BRIDGE cannot target Codex.
- The Windows PowerShell5.1 Check entry point passed dependency discovery and real read-only signed-in quota access from an extracted Chinese/space directory.
- Both production helper sources compiled successfully in that extracted directory with UTF-8 ownership metadata.
- In a separate test namespace, the real installer created its native scheduled-task host in an independent Chinese/space installation root. A heartbeat-only worker became healthy, then uninstalled successfully. The test task and empty test folder were removed. This test intentionally used a dummy worker and did not control the desktop app.

## Inherited application-core validation

The UI54 renderer and original ring appearance are unchanged from the working win.8 core. That core passed11 isolated browser checks, a real original-identity unflagged native startup handoff, and actual unique-sidebar verification. A55-second live freshness sample captured six updates, all verified, maximum interval12.36seconds. These real application tests were on the same computer, not an independent fresh Windows machine.

## Privacy and limits

Screenshots use fixture data. Personal paths, real quota values, process IDs, tokens and raw private diagnostic receipts are excluded from the public package.

There is no separate clean-OS or second-computer login validation in this report. Other Windows configurations and future internal UI/protocol changes require further testing; the first public release should be a pre-release. Installation requires its documented prerequisites and may be restricted by managed-device policy.

## Reproducing

Run: node --test tests/core.test.cjs tests/native-startup.test.cjs tests/distribution.test.cjs

Browser tests additionally require Playwright and Edge. Native tests compile StartupBridge.cs with TEST_BRIDGE and LifecycleFixture.cs in a separate test directory; set WSC_NATIVE_TEST_ROOT and run tests/native-lifecycle.cjs. Never substitute a production app as a test fixture.
