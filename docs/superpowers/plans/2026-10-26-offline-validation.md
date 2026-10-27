# End-to-End Offline Validation Plan

**Goal:** exercise the desktop agent against the existing native firmware core before any physical installation.

**Scope:** the maintainer's 2026-10-26 request authorizes PC-only integration and regression testing. Physical Phase 4 acceptance, LAN deployment, installation packages, flashing, and distribution remain pending.

## Design

Use a C++17 process with simulated storage, time, display, and startup services. A test-only Node HTTP adapter binds to an ephemeral `127.0.0.1` port and forwards HTTP headers and bytes over private process pipes. The native process runs `HttpHeaders`, `ProtocolHandler`, `SceneManager`, `Transfer`, `HashJob`, `AnimationReader`, `AtomicFileBackend`, and `SafeStartup`. Temporary disk files survive actual process restarts. OpenSSL supplies host-only SHA-256; no target dependency changes.

An in-process C++ unit fixture cannot exercise the TypeScript transport. Reimplementing firmware behavior in TypeScript would miss core integration defects. The process adapter reuses the core and keeps test controls out of protocol v1. It does not exercise the ESP8266 TCP, LittleFS, LCD, or SDK adapters.

Add an explicitly constructed agent HTTP client/synchronizer, with no production CLI activation or physical address configuration. Each synchronization reads compatibility status, sends fresh poller state independently of change notifications, and sends heartbeats. Metadata precedes track-bound artwork. Cover failures retain text updates; failed uploads retry on a later cycle. No automatic network discovery or environment-based connection is added.

## Constraints and Review Focus

- Preserve protocol v1 schemas and deployment protections.
- English-only files, source, tests, and documentation; no real credentials.
- All test networking stays on loopback; Spotify and decoded artwork are mocked.
- Catch deduplicated metadata becoming stale under continued heartbeat.
- Catch old artwork associated with a new track, retry suppression, and reboot cache loss.
- Catch partial writes, checksum failures, and promotion failures destroying installed assets.
- Catch provisioning persisting before confirmation or losing maintenance on storage failure.
- Report SDK, rendering, flash durability, timing, and actual hardware evidence separately.

## Tasks

- [x] Add behavior-first tests for native v1 playback, artwork, progress, modes, and freshness; observe missing implementation failures.
- [x] Build the host adapters and serialized native process bridge without compiling a board profile.
- [x] Implement the reusable agent v1 client and synchronization cycle using current snapshots and media converters.
- [x] Exercise disconnection, reconnect, incompatible versions, upload failures, disk persistence, actual restarts, and maintenance/provisioning faults.
- [x] Fix confirmed integration defects with failing regression evidence.
- [x] Run repository checks, all native suites, offline integration tests, sanitizers, and deployment-guard tests; document exact results and gaps.

## Execution Notes

Work proceeds in the user-specified checkout. No branch integration, commit, publication, or device operation is part of this task. The maintainer's detailed request supplies the scope; implementation choices above are agent decisions within that scope.

The [validation report](../../offline-validation.md) records final evidence. Independent review found no critical defect, identified strict status validation and premature fixture storage access (corrected), and confirmed that the initial-null clearing behavior is a v1 limitation requiring explicit documentation. The runner drives synchronization cycles with a simulated clock; production CLI activation and scheduling remain outside this authorization.
