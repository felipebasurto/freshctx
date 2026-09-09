# Bridges

The sidecar stays at the repo root. Each host lives in `bridges/<host>/`
with its own manifest and `file:../..` on the product. Bridges are not in
the npm tarball.

Maintained: [Pi](pi) (`openai-completions`) and [OpenHands](openhands)
(`condense_then_freshctx`). A rejected plan must cancel dispatch, not send
the original request.

Install from this checkout. Both bridge packages stay `private: true`.
