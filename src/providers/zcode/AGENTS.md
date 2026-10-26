# ZCode constraints

- One workspace-owned `ZCodeRuntime` runs a single `zcode app-server` for every ZCode session, history read and catalog read. Only it starts and restarts the process; sessions attach by native session id and resume their session after a restart.
- The protocol is newline-delimited JSON without a `jsonrpc` member; native rejects unknown keys. Live output arrives only through `session/subscribe` with `deliveryKind: 'desktop-continuous'`; `v4/telemetry/event` carries lengths, never text.
- Native sessions are stored only after their first message, so model discovery may create a blank session. `session/messages` needs an active session; history otherwise resumes it, which is safe to repeat.
- `session/setModel` requires `options.reasoningLevel`. Native modes are `build` (ask), `edit`, `yolo` (never asks) and `plan`; read-only and passive tool policies run in `plan`.
- Permission and question prompts are server requests (`interaction/requestPermission`, `interaction/requestUserInput`). Answer permissions with the chosen native option's `response`, never a reconstructed one.
- Claudian instructions travel inside the first user message as `<claudian_instructions>`; history hydration strips that wrapper.
- Verify protocol changes with `ZCODE_E2E=1` against a real, signed-in `zcode`; it spends model quota.
