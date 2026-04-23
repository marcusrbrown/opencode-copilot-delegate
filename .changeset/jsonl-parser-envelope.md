---
"opencode-copilot-delegate": minor
---

Add JSONL parser and envelope builder for Copilot CLI output processing

- `parseJsonlLine()` normalizes Copilot CLI JSONL events into typed `ParsedEvent` objects with defensive handling of malformed input
- `buildEnvelope()` folds parsed events into the structured `copilot_output` response shape with graceful degradation for missing fields
- Live JSONL fixtures captured from `copilot` CLI v1.0.34 for regression testing
