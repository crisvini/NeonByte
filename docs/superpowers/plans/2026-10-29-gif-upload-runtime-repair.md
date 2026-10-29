# GIF Upload Runtime Repair Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans inline. The maintainer explicitly authorized agent correction, Windows restart, read-only device checks, and one controlled physical GIF upload. No commit, push, firmware modification, OTA, flash, device restart, or manual flash deletion is authorized.

**Goal:** Install the already prepared 53,489-byte NBIF v2 through the corrected Windows agent and confirm firmware validation.

**Architecture:** Retain the existing HTTP fix and upload protocol. Restore an exported prepared NBIF through the loopback panel after restarting the stale Windows process. Validate its SHA-256 and complete NBIF structure before exposing it for a separately confirmed replacement.

**Tech Stack:** Existing Node.js 22, TypeScript, native HTTP, and NBIF v2 validators; no new dependencies.

## Design and Scope

The Windows listener started before the corrected client artifact was copied. Its legacy stored address is stale, while its effective verified maintenance address answers status and capabilities. Exporting the current `/api/animation` preserves the exact prepared asset. Requiring another GIF conversion discards that asset; an alternate upload utility would leave the panel workflow unverified. Extend the existing local preparation handler with `/api/animation/prepared`, accepting only its exported NBIF media type and a required SHA-256. Optional bounded original-size metadata preserves the preview statistics. Keep origin, host, OTA lock, size, format, and replacement confirmation checks. This route never contacts the device.

## Tasks

- [x] Add regressions exporting a prepared asset, restarting the local server, restoring identical bytes, and retaining the preview after invalid hash/format requests. Verify origin, size, and OTA protection.
- [x] Implement the minimal shared preparation handler in `agent/src/web/server.ts` and document the local restore API.
- [x] Run HTTP/upload/web tests, `npm run check`, offline integration, native tests and relevant HTTP probes with sanitizers.
- [x] Compare and copy reviewed agent artifacts to Windows without changing credentials or `.env`; restart only the stale agent and confirm the new process/artifact path.
- [x] Restore the saved NBIF, recheck real status/capabilities, capture sanitized outgoing request framing, and perform one panel replacement. Confirm the firmware session reaches `installed`, including exact byte counts and no validation error.

## Review Focus

- A correct HTTP artifact on disk does not update a previously running process.
- A saved legacy address can differ from the authenticated effective device address.
- Invalid, oversized, cross-origin, or OTA-locked restoration must not replace the prepared preview.
- Export and restoration must preserve the exact NBIF bytes/hash without conversion or device writes.
- A successful DELETE or completed network send does not prove installation; require firmware upload status.

## Execution Record

The restore regression first failed with HTTP 404, then passed with the shared
validated preparation handler. The physical panel replacement completed once;
the firmware receipt and test evidence are in
[the repair report](../../gif-upload-runtime-repair.md). Existing credentials and
`.env` matched after restart. No source change to the existing native HTTP fix
was needed. Minor optional test gaps identified in review are recorded in the
report. No unrelated phase checkbox was marked complete.
