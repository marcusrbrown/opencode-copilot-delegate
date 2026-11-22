# Security Policy

## Supported versions

Only the latest published release of `opencode-copilot-delegate` gets security fixes. The project is in the `0.x` series, so a fix ships as a new minor or patch release, not as a backport.

## Reporting a vulnerability

Report it privately through GitHub: on this repository, open **Security → Report a vulnerability** (private vulnerability reporting). Do not open a public issue, pull request, or discussion for a suspected vulnerability.

Include:

- the affected version, and the OpenCode host and version (1.x or 2.x)
- what an attacker can do, and the steps or a proof of concept to reproduce it
- any logs, with tokens, PATs, and other secrets removed

Reports are handled by the maintainer on a best-effort basis. You'll get an acknowledgement on the advisory, and the fix and disclosure timing are coordinated there.

## Scope

In scope is the code in this repository, which runs inside the OpenCode host process:

- spawning and cancelling GitHub Copilot CLI subprocesses (`src/runtime/subprocess.ts`, the PID ledger, orphan reaping)
- the localhost RPC server for the TUI and its port file and token (`src/runtime/rpc-*.ts`)
- tool inputs and outputs, including any leak of secrets or PII into tool results or logs
- the published npm package contents

Out of scope, so report these upstream instead:

- the GitHub Copilot CLI itself: [github/copilot-cli](https://github.com/github/copilot-cli)
- the OpenCode host: [anomalyco/opencode](https://github.com/anomalyco/opencode)
- advisories in development-only dependencies, or in host packages the plugin declares only as optional peers
