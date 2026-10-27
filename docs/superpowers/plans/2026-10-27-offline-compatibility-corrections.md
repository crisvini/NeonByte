# Offline Compatibility Corrections Implementation Plan

**Goal:** Fix the reviewed display and recovery AP boundaries, and provide an explicit maintenance-on-boot policy without device access.

**Architecture:** Retain the pinned display library and profile; override its virtual initialization frequency. Isolate AP startup and exact network readback behind a testable adapter. Select maintenance-on-boot explicitly at build time, defaulting to the existing automatic policy; do not invent a durable first-boot marker in unverified flash.

**Constraints:** Preserve OTA validators, credentials, deployment guards, existing default behavior, and the NO-GO decision. Tests and target builds are local only.

1. Add failing host tests for the display initialization frequency, profile commands and drawing windows; implement the virtual frequency override and update the pinned-library probe.
2. Add failing injected AP tests for existing addresses, failed start/configuration/readback, network mismatch and disable/retry; implement explicit IP, gateway and mask setup with checked SDK readback.
3. Add failing startup tests for the selected maintenance policy, cold/warm resets, authentication, explicit provisioning/run, and unchanged default startup; implement the explicit build selection without an unverified persistent marker.
4. Update the existing investigation and readiness documentation with actual behavior and limitations. Run repository, offline, native, applicable sanitizer, compile-only, image and deployment-guard checks; report failures and leave hardware gates open.
