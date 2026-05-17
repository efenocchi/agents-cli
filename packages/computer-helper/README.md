# computer-helper

macOS native helper that exposes Accessibility (AX) + ScreenCaptureKit + CoreGraphics
event injection over line-delimited JSON-RPC on stdio.

This is the backend for `agents computer` (mirror of `agents browser`).

## Build

```bash
./scripts/build.sh         # debug (single-arch)
./scripts/build.sh release # universal arm64 + x86_64
```

Outputs:

- `dist/computer-helper-mac` — bare binary
- `dist/ComputerHelper.app` — signed .app bundle (Developer ID if available, ad-hoc otherwise)

Bundle id: `dev.swarmify.computer-helper`.

## Why a .app bundle, not just a binary

macOS TCC keys Accessibility / Screen Recording grants by the launching process's
bundle id + Team ID. A bare binary inherits TCC identity from whatever shell or
process launched it — which means a one-time System Settings grant evaporates the
next time a different parent process invokes the helper. The `.app` form gives
the helper a stable TCC identity that survives across launches.

## Protocol

Each line in: `{"id":N,"method":"...","params":{...}}`
Each line out: `{"id":N,"result":{...}}` or `{"id":N,"error":{"code":"...","message":"..."}}`

The full method list is defined in `Sources/ComputerHelper/RPC.swift`. The
helper terminates cleanly on stdin EOF.
