---
'opencode-copilot-delegate': minor
---

Add `origin` discriminator (`'spawn' | 'resume' | 'connect'`) to `TaskState`, the `OutputEnvelope` returned by `copilot_output`, and the `EnvelopeInput` builder. Capture the upstream Copilot session UUID from the JSONL `result` event and surface it as `copilot_session_id` on the envelope (omitted when the subprocess never emitted a `result` event).

Existing `copilot_delegate` calls receive `origin: 'spawn'` automatically and continue to behave the same way. The new fields are the substrate the upcoming `copilot_resume` tool builds on; they do not change today's tool surface.
