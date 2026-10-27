# Authenticated Live Stock Restoration Design

**Authorization:** The maintainer requested final offline preparation, implementation if viable, and a conditional physical test proposal. Device operations, private packages, changed deployment safeguards, and releases are excluded. Installation remains **NO-GO**.

## Approach and Boundaries

Keep modern OTA unchanged. Add a separate `PUT /maintenance/v1/stock-firmware` extension that reuses the existing checked raw-staging transaction and backend with an immutable stock-image policy. Reusing the transaction avoids duplicating the dangerous activation/abort state machine. Admitting legacy files through the modern routes would weaken their format contract; a bootstrap or replacement boot architecture would change the preservation boundary and cannot solve its own first-installation risk.

The stock operation requires the existing recovery bearer authentication, paused application with no pending automatic start, existing OTA gate, strict framing, and an additional `NEONBYTE_ENABLE_STOCK_RESTORE` gate defaulting to zero. Only the existing non-installable integration-check profile selects that new gate for compilation. No current deployment block is removed.

Accept only the reviewed vendor V1.0.6 file: 488,304 bytes, SHA-256 `058e2ebcb9a35bc6a8c4e18a5441a26a88fae74d0e7684053a3bdea496cf529b`. Check the allowlisted request length/hash before staging, then independently check the actual staged SHA-256 before activation. A request digest is never sufficient by itself. The legacy validator checks exact combined E9 headers, entry points, all six known segment addresses/lengths, XOR checksums, zero footer padding, the known boot gap, exact EOF, and length/CRC at `0xFF8`/`0xFFC`. CRC is calculated over the entire file with those eight metadata bytes zeroed. Modern validators remain byte-for-byte unchanged.

Require the existing runtime flash checks plus exactly the researched 4m3m boundaries: 4 MiB physical flash, filesystem `0x100000–0x3FA000`, EEPROM `0x3FB000`, and DIO mode. Compute staging with the existing one-sector reserve and reject any mismatch before erase. Check geometry again inside the pre-activation verifier. Restoration accesses no filesystem, configuration, EEPROM, or SDK data. eboot will replace sector-rounded boot/application bytes on restart; it is not rollback or a full-flash restore.

Synthetic host images test parser and transaction failure behavior using a test-only digest double; they are not vendor images or proof of SHA-256. An additional local probe uses the unchanged ignored vendor file, real OpenSSL SHA-256 and the production transaction/legacy validator with a modeled flash backend. No network, device, firmware execution or installable artifact is involved.

## Validation and Remaining Risks

Test admission, old/modern route separation, correct legacy parsing, all structural/CRC failures, hash mismatch despite matching headers, readback corruption, bad geometry, insufficient staging, first/middle/final write/read failures, short/extra bodies, abort of a complete candidate, disabled gates, finalizer failure, reserved-region preservation, and RTC/startup ordering. Run repository, native, offline, sanitizer, existing target compile, image, and deployment-guard checks.

This operation can help only while NeonByte and its authenticated network/updater work. It does not prove exact-unit stock compatibility, preserve already-lost stock data, export a backup, survive boot-copy interruption, or provide independent Wi-Fi recovery. After successful stock replacement, NeonByte's identity and services disappear. Keep physical acceptance and full-backup/independent-recovery gates open.
