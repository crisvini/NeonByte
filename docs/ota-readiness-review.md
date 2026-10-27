# Stock OTA Readiness Review

**Date:** 2026-10-26. **Decision: NO-GO for installation through the stock SD PRO Wi-Fi OTA interface.** Continue documentation and offline evidence review only. Windows desktop validation has progressed; the hardware, backup, independent recovery, and maintenance-update deployment gates remain open.

This review changes documentation only. No clock was contacted, probed, restarted, or modified. No firmware was compiled, uploaded, flashed, or packaged; no private identity or release was generated. Existing deployment safeguards and API v1 contracts remain unchanged. Proposed implementation and future evidence collection below require their own authorization where they exceed this review.

## Evidence and Decision

Read in full: [agent instructions](../AGENTS.md), [implementation plan](../PLANNING.md), [recovery](recovery.md), [safe first boot](safe-first-boot.md), and [stock OTA research](stock-ota-installation-research.md). Supporting evidence includes [hardware](hardware.md), [stock binary analysis](stock-firmware-analysis.md), the current ESP8266 startup/storage/HTTP adapters, and pinned Arduino 3.1.2 update/boot code. Historical reports retain their original measurements; they are not evidence that the installed firmware matches the analyzed vendor image.

| Gate | Evidence available | Decision |
|---|---|---|
| Windows 11 agent startup and reconnection | Maintainer reports successful automatic startup, hidden execution, and Spotify reconnection after restart | Verified within that reported scope; no clock evidence |
| MCU family | ESP-12F / ESP8266 visually confirmed by maintainer | Confirmed; other board properties remain PENDING |
| Direct stock OTA packaging | Published third-party examples and compatible-looking combined image structure; current artifacts fit the nominal size guard | Plausible candidate, not demonstrated acceptance |
| Installed firmware/browser/verifier | Published V1.0.6 analyzed; installed version, browser assets, and complete verifier policy unknown | PENDING; blocks deployment |
| Board, power, display, flash, layout | Provisional profile and external unit reports; no unit-specific validation beyond module identification | PENDING; blocks deployment |
| Complete original backup and restoration | Vendor application update only; no unit-specific full-flash export or tested restore | BLOCKED |
| Independent Wi-Fi-only failed-boot recovery | Stock and NeonByte web services run in the application; no retained rescue service established | BLOCKED |
| Firmware update without LittleFS | Maintenance networking is independent; firmware staging is not | BLOCKED; proposed improvement below |
| Private installation candidate and physical acceptance | Public compile checks lack a usable identity; no approved package or spare-unit validation | PENDING; no packaging or device operations authorized |

**GO:** record the reported desktop results, inspect existing local artifacts/source, and assemble a revision-specific evidence request. **NO-GO:** stock OTA installation, firmware upload experiments, bootstrap deployment, installation packaging, or release publication. Improving maintenance access alone cannot change that decision.

### Windows Manual Validation

The maintainer's report supplied with this review confirms Windows 11 automatic startup, execution without a persistent terminal window, and Spotify reconnection after restart. [PLANNING.md](../PLANNING.md#phase-6--automatic-startup-distribution-and-quality) records these as manual results and checks the corresponding narrow tasks and desktop MVP criterion. No test date beyond the recording date, repetition count, task export, logs, or credentials was supplied. The coding agent did not rerun those tests.

Safe shutdown, failure-log inspection, startup removal, a separate agent-only restart, and forced OAuth expiration/revocation were not separately reported. Phase 6 and the overall MVP remain incomplete. These results establish neither real-device synchronization nor OTA readiness.

### Current Local Artifact Check

The existing Python inspector was rerun against the two available compilation artifacts, without rebuilding or creating an installation copy. Both passed combined E9 boundaries, segment checksums, and modern length/CRC checks:

| Existing artifact | Bytes | Headroom below nominal 524,288-byte stock guard | SHA-256 |
|---|---:|---:|---|
| `esp8266-provisional` | 355,184 | 169,104 | `4e3562bddec29cb09d014ed0c68ff27bf6a95725faf9730a2a05f0efe739ac85` |
| `esp8266-integration-check` | 358,688 | 165,600 | `40d90dfcd5c0583585ad7c54dd260bbf912f1428af666abf4084dff4c7a9ab1c` |

These match the safe-first-boot report, rather than the earlier research image's 352,304 bytes. They are existing public compile checks with no usable recovery identity, not private installation candidates. The future private candidate must be remeasured and meet the existing 458,752-byte preparation cap and every other gate. The stock guard's imperfect handling does not guarantee safe rejection.

Keep direct uncompressed combined-image installation as the conditional architectural candidate. Current size evidence provides no reason for an extra bootstrap. The reviewed Mini-Display bootstrap replaces settings, overlaps stock storage, and formats LittleFS; it also disappears when replaced by the main application. It does not solve NeonByte's preservation or independent-recovery requirements.

## Details Verifiable Without Modifying the Clock

No new device access is authorized or performed by this review. Prefer information already held by the maintainer and vendor documentation tied to the exact PCB revision. A read-only label on an HTTP method is insufficient evidence that a stock handler has no persistent side effects.

| Detail | Safe evidence source | What it can establish and what stays PENDING |
|---|---|---|
| Module and PCB revision | Existing clear photos, labels, purchase/revision records, vendor assembly documentation | Module marking is already confirmed; establish PCB identity only if visible. Do not open, probe, or alter wiring for this review |
| Stock version/build and ordinary display behavior | Maintainer's existing screen photos or previously saved stock UI information | Displayed version/resolution indicators can be recorded; strings alone do not identify every installed byte, LCD driver, rotation offsets, or color policy |
| Browser filename/envelope rules | Already saved HTML/JS or browser captures, exact-version vendor web assets | Audit case-sensitive prefix, multipart field, route, client checks, and handlers offline. No upload, Save action, or live script execution |
| Firmware format, nominal capacity/mode, linked regions, stock updater logic | Published matching image, source if supplied, image inspector/disassembly | Can establish artifact declarations and code behavior; cannot measure this unit's physical flash or identify its actual volume contents |
| Physical flash capacity/ID | Existing trustworthy unit-specific diagnostic export, visible chip marking, or revision-specific vendor BOM | A header's 4 MB declaration and generic ESP-12F defaults are insufficient. No new diagnostic firmware or readout command |
| LCD controller, CS/DC/reset/backlight wiring, boot straps, supply/regulator | Exact-revision schematic/BOM, existing legible board photos, vendor test records | Can resolve documented wiring and intended ratings. Polarity, timing, actual power margin, and rendering behavior still require later approved validation |
| Filesystem geometry/version, free space, settings/activation | Existing authorized stock diagnostic/export files and exact-version vendor filesystem/schema documentation | Analyze offline; a filesystem asset export is not a raw full-flash backup. Do not mount/write the physical volume or import credentials |
| Independent recovery and backup capability | Vendor boot architecture, documented stock export/restore format, exact-revision recovery specification | Establish whether qualifying mechanisms exist before considering any live test; a stock update page alone establishes neither |
| NeonByte size, checksums, interfaces, deployment guards | Existing local binaries, sources, build configuration, native mocks | Can validate software assumptions offline. Cannot establish RF reachability, heap/stack margins, LCD behavior, flash durability, or failed-boot recovery |

If live inspection becomes necessary later, first review the exact stock routes and side effects and obtain explicit authorization for a bounded read-only operation. Do not scan ports, guess backup/debug endpoints, switch provisioning modes, reboot, or attempt a dummy upload to discover behavior. No UART, soldering, USB-serial, or physical programming is an available fallback under the current project constraints.

## Complete Stock Backup: Feasibility

**Technically possible only if a suitable reader is already available; not currently established through stock Wi-Fi.** A running ESP8266 application can in principle read flash and export it over Wi-Fi. That chip capability does not imply that the installed stock server implements such an export. No documented full-flash reader appears in the reviewed stock evidence. Absence of evidence is not proof that a vendor-only feature cannot exist.

A qualifying backup must cover the entire independently confirmed physical address range, including boot/application, unused or staging regions, the complete filesystem, EEPROM/settings/activation records, and RF/SDK/provisioning sectors. If physical capacity is confirmed as 4 MB, that means 4,194,304 bytes, not the 488,304-byte vendor update. The downloaded vendor binary cannot recreate omitted unit-specific state.

Require an exact-version read-only export specification, explicit region coverage, coherent snapshot semantics, and independently checked length/hashes. Prefer two matching captures of stable regions; if the stock application changes settings or SDK data between reads, identify those differences and obtain a coherent restorable snapshot rather than claiming completeness from a checksum alone. Keep raw exports encrypted outside Git because they can contain network credentials and activation data. A backup also needs a documented full-region restore path and later validation on an identical spare; the stock application updater has not been shown to restore arbitrary flash regions.

Installing a dumper or temporary bootstrap first would overwrite original flash before the backup and require the very deployment/recovery guarantees still missing. A network proxy to a serial programmer would violate Wi-Fi-only/physical-access constraints. Neither is an acceptable workaround in this review.

## Independent Wi-Fi-Only Recovery: Feasibility

**Not achievable by the currently reviewed stock or NeonByte update architecture when the replacement application cannot execute.** Arduino OTA stages the candidate, then eboot copies it over the old program. The boot path does not provide a persistent Wi-Fi rescue application. See the pinned [OTA memory model](https://arduino-esp8266.readthedocs.io/en/3.1.2/ota_updates/readme.html#update-process-memory-view) and [eboot implementation](https://github.com/esp8266/Arduino/blob/3.1.2/bootloaders/eboot/eboot.c).

The ESP8266 ROM fallback is a serial downloader selected through boot pins, not a Wi-Fi service; see [Espressif boot-mode documentation](https://docs.espressif.com/projects/esptool/en/latest/esp8266/advanced-topics/boot-mode-selection.html). A Wi-Fi-only operator cannot use that fallback under the existing constraints.

There are distinct failure classes:

- **Application boots, but storage/configuration/display fails:** the host-tested authenticated AP/maintenance design can retain access. Physical radio behavior remains unverified. This is useful application maintenance.
- **Application boots, but LittleFS cannot stage firmware:** networking may work while replacement fails. The proposal below addresses this narrower case.
- **Application fails before maintenance networking, or boot copy/power/bootloader fails:** neither the stock updater it replaced nor NeonByte's own AP can help. A backup file alone cannot provide an executing restoration service.

A custom bootloader plus separately retained rescue application and verified selection/rollback could, in principle, cover some application failures while the bootloader and rescue image remain intact. It would require a new flash architecture, installation of that rescue path, radio-capable rescue firmware, and extensive independent validation. It cannot guarantee Wi-Fi recovery from corruption of the bootloader/rescue itself. No such design is demonstrated on this unit, and creating it would exceed the present architecture and authorization.

Request vendor evidence of an already installed independent rescue mechanism. If none exists, the current independent-recovery requirement cannot be met by a small NeonByte change. **Keep the project unit on stock firmware.** Any future decision to change the requirement would be a separate explicit policy decision, not a technical GO from this review.

## Filesystem-Dependent Maintenance Updater

### Current Path and Failure

In [HTTP handling](../firmware/src/esp8266/http_server.cpp), both firmware routes select `PersistentStorage` as the transfer sink. Recovery authentication and a paused application are required for `/maintenance/v1/firmware`; the OTA feature gate remains enforced. [Persistent storage](../firmware/src/esp8266/storage.cpp) then requires a mounted volume and candidate length plus the 32 KiB reserve, writes `/neonbyte/firmware.part`, checks image format and readback SHA-256, and promotes it to `/neonbyte/firmware.bin`. `applyFirmware()` validates format/CRC again, checks physical/linked flash and available sketch staging, copies the file through `Update.begin(..., U_FLASH)`, and finalizes with `Update.end(false)`.

Thus there are two staging locations: a LittleFS file and the Arduino raw sketch-update area. A full, read-only, absent, or incompatible LittleFS volume blocks the first stage even though the raw sketch staging area might be usable. Temporary Wi-Fi and an early HTTP listener do not remove this dependency. Lowering the reserve, deleting stock files, formatting, or changing filesystem boundaries would not safely address it.

### Smallest Safe Improvement Proposed

**Add a filesystem-independent sink only for the existing authenticated maintenance firmware route, using the existing raw sketch OTA area and pinned Arduino updater.** Retain the single application, linker geometry, normal asset/file path, private recovery identity, feature gates, and deployment-target restrictions. This is a proposal, not implementation authorization.

Compare three options:

| Option | Benefit | Limitation |
|---|---|---|
| Better preflight/error text only | Smallest diagnostic change; can explain why replacement is unavailable | Leaves the deployment blocker intact |
| Maintenance-only raw sketch staging adapter | Removes the filesystem dependency without a bootstrap, new filesystem, or partition migration | Requires a separately reviewed integrity/activation transaction and native fault coverage |
| Rescue bootloader, extra application slot, or storage migration | Could target broader recovery goals | Major architecture change, cannot bootstrap itself safely here, and exceeds scope |

Recommend the second option as the smallest change that resolves the specific maintenance-update dependency. Reuse `TransferSink`, `ImageSource`, bounded hashing, and both current image validators; isolate the ESP8266 binding behind a portable transaction policy. Do not generalize or replace asset storage.

Required properties for that later design:

1. Authenticate before accepting a transfer; require a paused application, strict HTTP framing, exact nonzero length, expected SHA-256, the existing 512 KiB runtime ceiling, and confirmed physical/linked flash geometry. Reject unsafe geometry or insufficient sketch staging before any erase. Compute sector-rounded bounds from the actual running image and candidate; preserve the current safety margin and exclude the running image, filesystem, EEPROM, and SDK/RF sectors. The 448 KiB installation-preparation cap remains separate.
2. Stream bounded chunks to raw OTA staging without mounting, creating, deleting, or formatting any LittleFS file. Expose a checked flash-backed `ImageSource` for readback. Preserve the current private recovery identity through a separately trusted preparation process; image CRC cannot prove that the candidate contains the correct credentials or working recovery logic.
3. Verify exact staged length, complete staged SHA-256, both E9 images/segments, modern CRC, flash settings, and all read results before scheduling boot copy. SHA-256 of received network bytes alone is insufficient. Reject a flash-mode mismatch before staging rather than relying on the pinned updater's header rewrite, which could make stored bytes differ from the expected image. Authentication plus a supplied digest is not a publisher signature or proof of successful boot.
4. Reuse the updater's pre-activation verification extension rather than inventing a second boot-copy mechanism. A candidate is its existing `installSignature()` hash/verifier hook with a zero-length signature trailer, checking the expected digest and checked `ImageSource` before the eboot command is written. This would be an integrity gate, not a new signing/package format. Exact adapter lifetime, staging address derivation, read failures, cleanup, and compatibility with existing update paths must be settled and tested in the later design.
5. Make finalization reachable only from a verified transaction. In the pinned source, `Update.end(false)` can schedule boot copy when all bytes are present; it is **not a universal abort operation**. Failure cleanup must not call a successful finalizer on an unverified complete image. A streaming alternative that withholds a final byte must also account for the updater's buffered tail and checked readback, not merely hash the download. Inspect the pinned [Updater implementation](https://github.com/esp8266/Arduino/blob/3.1.2/cores/esp8266/Updater.cpp) and [verification interfaces](https://github.com/esp8266/Arduino/blob/3.1.2/cores/esp8266/Updater.h) when designing this transaction.
6. Cover missing/full/read-only/unmountable storage, bad authentication, disabled OTA, wrong method/framing, bad hash/CRC/segments, oversized/truncated/extra input, disconnect/timeouts, heap exhaustion, failed flash reads/writes, insufficient/overlapping staging, and cleanup after complete-but-invalid input with native injected backends. Assert no boot command or restart on failure and no filesystem access on this route. Model resets before activation; do not claim that host tests solve power loss during eboot copy. Keep later target compilation and spare-unit runtime tests separately authorized.

Even after such an implementation, firmware that never reaches maintenance remains unrecoverable through this service. Success would remove one deployment blocker, not prove installation safety or justify relaxing the full-backup/independent-recovery gates.

## Next Concrete Action and Stop Boundary

**Assemble a revision-specific vendor evidence request for offline review before further installation work.** The maintainer can attach existing unit/PCB labels and displayed stock version, if already available, and request:

- The exact board schematic/BOM, fitted flash identification, display wiring/controller, and power specifications.
- The matching stock application and filesystem assets, installed browser/verifier rules, storage geometry/version, and configuration/activation preservation requirements.
- A documented nonmutating Wi-Fi full-flash export, its region coverage and consistency guarantees, and a corresponding full-region restore mechanism.
- Identification of the recovery code that executes when the normal application cannot boot, how it starts without that application, which flash regions it protects, and what happens if power fails during boot copy.

No vendor message was sent by this review. Evaluate the supplied documentation or already captured assets offline and update the evidence table. If the vendor confirms there is no qualifying independent Wi-Fi recovery or no complete export/restore path, retain **NO-GO** under the current requirements. Do not proceed to a test upload to answer that question.

The maintenance proposal can be considered as a separate, narrowly authorized local design/implementation task; it is not the next installation step. Do not generate a package or publish a release. Physical Phase 4 acceptance and broader phase completion remain unchecked except for the specifically reported Windows results.

## Review Validation

- Rechecked both existing local images with `firmware/scripts/inspect_image.py`; their checksums, CRCs, sizes, and hashes match the values above. No target build or device tool ran.
- Reviewed startup, maintenance routing, file staging, transfer finalization, and the pinned upstream activation path. No firmware behavior or protocol contract changed.
- `npm run check` passed: Markdown lint, English-language policy, 9 root/contract tests, agent build/type checks, and 54 agent tests. `git diff --check` passed. These checks do not validate physical installation or recovery.
