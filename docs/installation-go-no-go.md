# SD PRO Installation GO/NO-GO Decision

**Decision date:** 2026-10-27. **Decision: NO-GO.** The available evidence does not make installation or physical validation eligible for proposal. This is the Part 6 assessment only; it is not authorization to contact or modify the clock.

## Scope and Evidence Classes

This review covers Parts 1–5 of [`NEXT_STEPS.md`](../NEXT_STEPS.md), the related reports and source artifacts in this repository, and the exact-unit evidence already recorded there. No new exact-unit evidence was supplied for this review. The only recorded unit-specific hardware observation remains the maintainer's visual confirmation of an ESP-12F module on 2026-10-26; no supporting photo is stored in the repository.

The labels below are independent evidence types:

- **Source-supported:** a repository implementation, pinned upstream source, vendor artifact, or published documentation supports the stated software or artifact property. It does not establish unit-specific behavior unless tied to the exact unit and revision.
- **Mock-tested:** a host test or simulated backend exercises the stated software behavior. It does not establish flash, radio, boot, display, or power-loss behavior on the clock.
- **Real-hardware-tested:** a test or observation performed on the actual SD PRO unit. Maintainer-reported observations are identified as reports and are not presented as independent measurements.
- **Unknown:** evidence is absent or is not tied to this unit. Unknown is not proof that a feature does not exist.

The checklist is dated 2026-10-27. It preserves earlier evidence dates and does not imply that the clock was inspected during this review.

The subsequent [independent compatibility investigation](ota-compatibility-investigation.md) adds library-boundary probes and an external first-installation failure report. It identifies further display and provisioning corrections, supplies no new exact-unit backup/recovery evidence, and leaves every mandatory gate and the **NO-GO** decision unchanged.

## Mandatory Evidence Checklist

| Requirement | Source-supported | Mock-tested | Real-hardware-tested | Unknown | Gate |
|---|---|---|---|---|---|
| Actual installed stock version | The [vendor snapshot](https://github.com/JUZIPi-tech/SD_PRO/tree/5dc22a11d6ca5ffa8cc2aad103cd82e7c77d7e1d) includes V1.0.4 and V1.0.6 artifacts. The [V1.0.6 analysis](stock-firmware-analysis.md) identifies that published file only. | Not applicable. | No installed-version observation is recorded. | Installed version/build and a safe existing version-identification record. | **BLOCKER** |
| Unit PCB, flash, display, and boot layout | The [hardware report](hardware.md) and [device evidence matrix](device-evidence-matrix.md) distinguish the ESP-12F module report from evidence about the carrier board. The [third-party pinout note](https://github.com/piotrkochan/homeassistant-minidisplay/blob/ae012e7a81d873692eb67dc606927c69ab16cf49/notes/pinout-sdpro.md) is for another unit. | Compilation uses provisional settings only. | Maintainer-reported visual ESP-12F identification on 2026-10-26; no PCB revision, flash, display, or boot behavior was measured. | Exact PCB revision, fitted flash/capacity, power circuit, display wiring/controller, boot straps, and installed boot layout. | **BLOCKER** |
| Compatible original web verifier and first-install image | Static analysis and public examples make some image formats plausible; [stock OTA research](stock-ota-installation-research.md) explicitly leaves the installed browser and verifier unknown. | Local image inspectors validate generated files, not acceptance by the stock installer. | No stock upload or first boot was tested on this unit or an identified identical spare. | Matching installed web assets, verifier rules, and demonstrated first-install compatibility. | **BLOCKER** |
| All flash, storage, and activation preservation regions | The published [V1.0.6 binary](https://github.com/JUZIPi-tech/SD_PRO/blob/5dc22a11d6ca5ffa8cc2aad103cd82e7c77d7e1d/SDPro_V1.0.6_20260525_174828.bin) supports claims about its own linked LittleFS and EEPROM references. It is not a physical map or a complete image of this unit. | No host test can identify the unit's stored regions or contents. | No unit flash region was read or measured. | Physical capacity and map, filesystem contents, settings/activation, SDK/RF data, staging, tail regions, and preservation behavior. | **BLOCKER** |
| Complete, restorable, unit-specific Wi-Fi backup | No qualifying vendor procedure or repository artifact is documented; [`recovery.md`](recovery.md) explains why the published update image is not a backup. | No mock establishes complete unit data or restoration. | No backup or restore was performed. | Nonmutating full-region export, snapshot consistency, exact coverage, integrity evidence, and a matching full-region restore procedure. | **BLOCKER** |
| Independent Wi-Fi-only recovery after the main application or boot copy fails | The [stock analysis](stock-firmware-analysis.md) and [recovery report](recovery.md) show that the examined updater and NeonByte maintenance service depend on application code running. No independent rescue service is demonstrated. | Host startup and maintenance tests cover application-level failures only. | No failed-boot recovery path was tested. | Whether the vendor has an undisclosed recovery service that boots independently, its protected regions, and its failure behavior. | **BLOCKER** |
| Safe recovery identity distribution | [`safe-first-boot.md`](safe-first-boot.md) specifies a private per-device identity and secure operator handoff. It also states that no private identity or installation package was produced. | Native tests check identity validation and fail-closed startup; they do not test secret custody or delivery. | No identity was provisioned to this unit. | A trusted private preparation process, unique identity, secure delivery, retention, and recovery access for the exact device. | **BLOCKER** |
| Validated maintenance updater | [`maintenance-ota-design.md`](maintenance-ota-design.md) documents the raw-staging implementation, injected fault tests, and compilation-only profile. | Native tests cover request, image, geometry, read/write, LittleFS-independence, and fail-closed activation scenarios. | No raw flash update, eboot activation, or resulting boot was tested on an SD PRO. | Runtime staging geometry, flash readback/programming, update interruption, reset, and successful boot on an identical spare. | **BLOCKER** |
| Identical spare for restoration and failure tests | No spare unit or exact-revision identity is documented in the reviewed [device evidence](device-evidence-matrix.md) or [recovery record](recovery.md). | Simulation is not a hardware spare. | No spare was identified or tested. | Availability and exact-revision/component equivalence of a spare. | **BLOCKER** |

One missing mandatory item is sufficient for NO-GO. Every listed gate is either missing or supported only at a non-unit-specific level; no requirement is fully satisfied for installation.

## Review of Parts 1–5

- **Part 1:** The evidence matrix records the maintainer-reported ESP-12F module and keeps the installed firmware, board details, full backup, and independent recovery unknown. The V1.0.6 file and other SD PRO reports do not identify this unit.
- **Part 2:** Windows 11 automatic startup, hidden execution, and Spotify reconnection after restart are maintainer-reported desktop results. They provide no evidence of SD PRO firmware compatibility, backup, or recovery. Additional Windows checks remain pending in [`installation.md`](installation.md).
- **Part 3:** The filesystem-independent maintenance transaction was designed and documented offline. Design completion did not validate the hardware or the boot path.
- **Part 4:** The maintenance route was implemented, host fault-tested, and compiled in non-installable profiles. The report records no device operation, private identity, or installation package. Hardware runtime validation remains pending.
- **Part 5:** The offline harness, native suite, sanitizers, and compilation-only profiles passed as documented in [`offline-validation.md`](offline-validation.md). These validate software behavior against mocks and host adapters, not the LCD, physical flash, radio, boot, or power-loss behavior.

The relevant detailed records are [`device-evidence-matrix.md`](device-evidence-matrix.md), [`stock-firmware-analysis.md`](stock-firmware-analysis.md), [`stock-ota-installation-research.md`](stock-ota-installation-research.md), [`ota-readiness-review.md`](ota-readiness-review.md), [`safe-first-boot.md`](safe-first-boot.md), and [`maintenance-ota-design.md`](maintenance-ota-design.md). Their historical dates and scopes remain intact.

## Blockers and Minimum Next Actions

1. Provide already-existing unit labels/photos, revision or purchase records, and a stock version previously shown on an ordinary screen, if available. Do not trigger a diagnostic request, reboot, or update to obtain them.
2. Obtain vendor documentation tied to the exact revision for the PCB schematic/BOM, fitted flash and capacity, power, display and boot wiring, installed-version identification, original web verifier, first-install requirements, and every settings/activation preservation region.
3. Obtain a documented, nonmutating, coherent Wi-Fi export of the entire unit-specific physical flash range and a matching full-region restore procedure. Evidence must cover the application, filesystem, settings/activation, SDK/RF data, staging and flash tail, with integrity and region-coverage details.
4. Establish an independent Wi-Fi rescue path that can execute when the main application cannot boot, including after an interrupted boot copy. A stock updater or NeonByte recovery AP inside the main application does not satisfy this requirement. If no such vendor mechanism exists, installation remains blocked under the current project constraints.
5. Identify an identical spare and tie it to the same board revision and component population. After the documentary gates are satisfied, separately authorize spare-only restoration and updater validation before considering the project unit.
6. Only for a separately reviewed candidate, create a unique private recovery identity through the documented trusted process and arrange secure delivery and retention. Do not put the identity in Git, public binaries, CI artifacts, manifests, logs, or this report.

If any mandatory requirement remains unsupported, keep the decision at **NO-GO**. Do not use an experimental install or upload to discover compatibility or recovery behavior. Because the gates are not met, this report does not prepare the conditional hardware-validation checklist.

## Decision and Stop Boundary

**Final decision: NO-GO for SD PRO installation and not eligible for a separate physical validation proposal.** The missing unit-specific full backup/restore and independent Wi-Fi-only failed-boot recovery are sufficient blockers by themselves. Hardware identity, installed stock version, verifier compatibility, preserved regions, private recovery identity, updater runtime behavior, and an identical spare are also unresolved.

No device was contacted, probed, reset, or modified. No new firmware build, package, or installation was part of this decision. Protocol v1, partition/layout assumptions, deployment guards, and hardware checklists were not relaxed or marked complete. Stop at Part 6; Part 7 remains outside this authorization.
