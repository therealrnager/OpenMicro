# Security notes for this fork

Reviewed on 2026-11-05 against upstream commit `fcde3a14ec8476c4d4bd66031f97c28f524dd6a5` (v1.4.3). This is a focused source review and automated regression pass, not a security certification or a guarantee that all vulnerabilities have been found.

## Privileges and controller access

OpenMicro runs as your normal user. The desktop harness requests macOS Accessibility/Automation access to activate Codex and send keyboard events. Those permissions are powerful: software running in the same trusted terminal context may also be able to automate your desktop. There is no need to run OpenMicro with sudo.

The GameSir/DS4 path in `src/controller/raw-hid-driver.ts` opens the controller and reads HID reports. It contains no controller-output or firmware-writing path. DualSense support uses `dualsense-ts` to send lightbar and player-LED output. This review did not audit native dependency internals, macOS HID drivers, Bluetooth security, or controller firmware. A malicious HID device can still simulate valid physical inputs.

## Local communication

The host binds only to `127.0.0.1`. All state-changing routes and keystroke streams require a random credential stored in `~/.openmicro/auth-token`, owned by the current user with private permissions. Symlinked credentials and unsafe credential directories are rejected. Hook settings contain an absolute path to a Node helper, not the secret.

Clients and hooks first verify an HMAC proof for a fresh random challenge. An unrelated process merely returning `{ "app": "openmicro" }` cannot pass that check. Redirects are rejected. This proof is a preflight check, not a cryptographic channel binding: the protocol uses loopback HTTP, and port ownership must remain trustworthy between requests. An attacker already able to run code as your user can read the credential, modify this program, or exercise your existing permissions; this mechanism does not isolate mutually hostile processes under the same account.

Browser-origin requests and foreign Host headers are refused. Bodies are limited to 1 MiB. Stream IDs are random, require registration, and cannot replace an existing active stream. The desktop executor accepts only its fixed shortcut vocabulary and supported Codex deep-link forms, including encoded prompt text. Terminal mode intentionally forwards keyboard input to the selected agent process; it is not a sandbox for that agent.

## Hook files and migration

Stop old OpenMicro instances before using this fork. The protocol is incompatible with unauthenticated upstream clients. Startup migrates OpenMicro's existing hooks to the new helper. Unrelated hooks in the same group are retained. Invalid JSON structures or symlinked settings files are left untouched; the installer logs a failure instead of replacing them. Valid changes use an atomic file replacement. Concurrent manual edits to the same settings file are not coordinated.

## Input cleanup and validation

Layer changes and disconnects release repeating actions and dictation, and reconnects clear stale held-button state. Shutdown invalidates queued AppleScript and kills the active script before releasing modifiers; the process-exit callback repeats cleanup to cover a late key-down. Cleanup is best-effort if macOS automation is unavailable, the process is forcibly terminated, or the machine crashes.

Regression tests cover command rejection, encoded prompts, authentication, spoofed hosts, credential permissions, browser-origin/Host defenses, stream ownership, oversized requests, hook preservation, malformed configuration, and input/shutdown cleanup. Existing recorded-controller fixtures are replayed. No physical GameSir Cyclone test or live Accessibility/AppleScript execution was performed in this pass.

`npm audit` checks published dependency advisories, not application logic or every possible supply-chain issue. Re-run it with `npm ci`, `npm run verify`, and `npm run build` as dependencies change. The scoped minimatch override can be removed once typescript-eslint adopts a fixed version itself. Forks cannot invoke the inherited upstream npm publishing job.
