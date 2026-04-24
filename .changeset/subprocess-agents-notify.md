---
"opencode-copilot-delegate": minor
---

Add subprocess wrapper, task registry, notification injection, and agent discovery

- Subprocess spawning with line-buffered JSONL parsing, auth token env precedence, and abort-based cancellation via fkill process group kills
- In-memory task registry with cleanup-all lifecycle
- Notification injection using noReply semantics with per-session in-flight counters
- Agent discovery scanning builtin, user, and repo directories with override semantics
- ANSI escape sequence stripping for clean error/message text
