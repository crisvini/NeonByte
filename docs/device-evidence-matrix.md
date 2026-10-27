# SD PRO Device Evidence Matrix

**Reviewed:** 2026-10-26. **Installation decision: NO-GO.** This review covers the project files and the public vendor and research sources linked below. It involved no contact with the clock, device discovery, endpoint requests, firmware execution, upload, flash, or modification.

## Evidence Classes

The [2026-10-27 independent compatibility investigation](ota-compatibility-investigation.md) adds host-probed library behavior and a public first-installation failure/serial-recovery report for another unit. Upstream default-branch commits are unchanged. These additions supply no exact-unit identification, backup, or independent Wi-Fi recovery evidence, so the installation decision remains **NO-GO**.

- **Verified on this unit:** directly reported or recorded for the project unit. A maintainer report is identified as such; it is not silently upgraded to an independent measurement.
- **Documented for exact revision:** tied by a revision identifier to this unit's board and installed software. No such documentation has been supplied or found in the reviewed public sources.
- **Inferred from another SD PRO:** reported for a separate SD PRO unit or project. It can guide questions, but it does not identify this unit.
- **Published artifact only:** verified properties of a public vendor file or repository snapshot. These properties do not identify the installed unit's contents.
- **UNKNOWN:** evidence is absent, insufficient, or not tied to this unit. An unknown does not prove that a capability does not exist.

## Unit and Revision Evidence

| Claim | Evidence class | Evidence and provenance | Confidence and limit | Blocking condition |
|---|---|---|---|---|
| MCU module family is ESP-12F / ESP8266 | Verified on this unit | The maintainer visually confirmed the module on 2026-10-26; recorded in [hardware investigation](hardware.md). | High for the reported module marking. No supporting photo is stored in the repository. | Does not identify the carrier PCB, wiring, flash, power supply, or installed firmware. |
| PCB revision and component population | UNKNOWN | No unit-specific revision label/photo, schematic, BOM, or vendor revision record is in the reviewed project files. The vendor repository snapshot does not provide board source. | No exact-revision evidence. | Required to tie any board-level schematic or recovery instructions to this unit. |
| Fitted flash manufacturer, part number, and physical capacity | UNKNOWN | The V1.0.6 binary declares DIO, 40 MHz, and 4 MB; this is a property of that published image, not a measurement of the unit. The ESP-12F specification is module-level evidence only. | High for the binary header; no physical flash identification. | Do not use a 4 MB build/layout assumption for installation until the unit or exact-revision BOM confirms it. |
| Board input voltage, regulator, and supply margin | UNKNOWN | The module specification describes the module supply, but no exact-revision board power circuit or unit measurement is available. | Module supply requirements cannot establish the board input range or display load margin. | Obtain exact-revision power documentation; physical validation remains separate. |
| Display controller, resolution, wiring, boot straps, backlight, and color behavior | Inferred from another SD PRO | The pinned [Mini-Display SD PRO pinout note](https://github.com/piotrkochan/homeassistant-minidisplay/blob/ae012e7a81d873692eb67dc606927c69ab16cf49/notes/pinout-sdpro.md) reports an ESP-12F, 4 MB, 240 × 240 ST7789-compatible panel, MOSI GPIO13, SCLK GPIO14, no CS, DC GPIO0, reset GPIO2, and active-low backlight GPIO5. | Medium for that project's tested unit; not tied to this unit's PCB revision. The separate SmartClock AI configuration assigns display CS to GPIO15, so even community reports do not settle this unit's CS wiring. | Exact-revision schematic/BOM or unit-specific existing photos are needed. GPIO0/GPIO2/GPIO15 also require boot-mode analysis for the actual board. |
| Exact-revision schematic/BOM and board pinout | UNKNOWN | None in the reviewed vendor snapshot or project files. The third-party pinout is for another unit. | No exact-revision documentation. | Required before selecting display pins, power assumptions, or a hardware profile. |

## Stock Firmware, Storage, and Update Evidence

| Claim | Evidence class | Evidence and provenance | Confidence and limit | Blocking condition |
|---|---|---|---|---|
| Installed stock firmware version/build | UNKNOWN | The vendor's pinned public repository contains V1.0.4 and V1.0.6 update binaries. Static analysis found a `SD Pro V1.0.6` product string in the V1.0.6 artifact; neither fact identifies the bytes installed on this unit. Existing reports state that the supplied stock page does not show a version. | High for the analyzed artifact; none for the installed version. | Need a version-identification method that uses an ordinary existing display/interface or already-held records. Do not invoke an updater or probe an endpoint to identify it. |
| V1.0.6 image structure and declared storage geometry | Published artifact only | The pinned [vendor V1.0.6 binary](https://github.com/JUZIPi-tech/SD_PRO/blob/5dc22a11d6ca5ffa8cc2aad103cd82e7c77d7e1d/SDPro_V1.0.6_20260525_174828.bin) was statically analyzed in [stock firmware analysis](stock-firmware-analysis.md). It is a 488,304-byte combined ESP8266 image; analysis found LittleFS configured at `0x100000–0x3FA000` and an EEPROM-emulation base at `0x3FB000`. | High for the file and linked configuration; no evidence of this unit's actual flash contents, installed layout, filesystem, or settings. | Do not treat this update image as a backup or its address declarations as measurements of the unit. |
| Stock updater behavior in published V1.0.6 | Published artifact only | Static analysis traces `POST /update_ota`, a nominal 512 KiB guard, an `SDP` prefix check that logs but does not reject in the traced callback, and an upload-end call consistent with `Update.end(true)`. See [stock firmware analysis](stock-firmware-analysis.md). | High for the analyzed binary's traced path. The installed version, stock browser assets, complete verifier setup, and exact request rules remain unknown. | Cannot establish acceptance, safe rejection, or boot compatibility for this unit. Do not test by uploading. |
| Stock filesystem contents, version, and configuration/activation schema | UNKNOWN | The V1.0.6 update artifact omits the linked LittleFS volume and unit-specific EEPROM/settings. Existing analysis identifies references and configured addresses, not the unit's contents or schema. | High for the artifact boundary; no unit-specific data. | Need exact-version vendor schema/assets and preservation requirements. No mount or write to the unit is authorized. |
| Exact stock browser validation and update envelope | UNKNOWN | A third-party reverse-engineering note reports a browser-side `SDP` filename-prefix check and multipart field `update`; stock HTML/JavaScript for the installed version is not available in the reviewed project files. See [stock OTA research](stock-ota-installation-research.md). | Inference from another SD PRO and saved research, not an audit of this unit's installed browser. | Need matching, already-saved or vendor-supplied web assets and verifier documentation. |

## Backup, Restoration, and Recovery Evidence

| Claim | Evidence class | Evidence and provenance | Confidence and limit | Blocking condition |
|---|---|---|---|---|
| Complete, unit-specific, nonmutating flash export over stock Wi-Fi | UNKNOWN | No qualifying export route, format, region list, consistency guarantee, or read-only procedure is documented in the reviewed vendor repository/manual or project files. The [vendor manual](https://github.com/JUZIPi-tech/SD_PRO/blob/5dc22a11d6ca5ffa8cc2aad103cd82e7c77d7e1d/Smart%20Clock%20Manual%20V1.2.1.docx) describes stock setup and a local interface, not a full-flash export. | No method established. This bounded search does not prove that a vendor-only method cannot exist. | Need documentation for a coherent export of every physical flash region, including firmware, filesystem, settings/activation, SDK/RF data, and unused/tail regions. A vendor update image is not sufficient. |
| Full-region restoration of a unit-specific export | UNKNOWN | No documented stock-Wi-Fi procedure restores a complete flash export or proves it can restore all regions on the exact revision. An application updater is not evidence of a full-region restore path. | No method established or tested. | Need a matching restore procedure, including address coverage, validation, and safe behavior after interruption. |
| Stock setup AP or updater works when the installed application fails to boot | UNKNOWN | The manual describes normal stock setup behavior. The analyzed updater is application code. Neither provides evidence of a separately retained service that executes when the normal application cannot boot. | An application-level AP/updater is not independent boot recovery. | Need the identity and boot path of a rescue service independent of the installed application, plus its retained flash regions and failure behavior. |
| Independent Wi-Fi-only recovery after failed application boot or boot copy | UNKNOWN | No independent rescue service or protected Wi-Fi recovery image is demonstrated by the reviewed vendor sources, third-party reports, or project files. The ESP8266 ROM downloader is serial/boot-pin based and outside the project's Wi-Fi-only constraints; see [recovery limits](recovery.md). | No qualifying recovery path documented. Absence from reviewed sources is not proof no vendor-only mechanism exists. | Mandatory deployment blocker. A main-application maintenance AP, stock updater, backup file, or application OTA route does not satisfy this gate. |
| LittleFS-independent verified maintenance update | HOST IMPLEMENTED / DEVICE UNVALIDATED | Part 4 implements raw sketch staging only for the authenticated, paused maintenance route. Native fault injection covers LittleFS states, request/image faults, geometry, checked reads/writes, and fail-closed activation; the non-installable ESP8266 integration-check profile compiles the binding. | Host checks do not establish physical flash behavior, power-loss safety, or successful boot. The route can help only when the maintenance application is already running. | Validate runtime layout and update behavior on an identical spare. This does not clear independent-recovery or full-backup gates. |

## Sources Reviewed

| Source | Revision or scope | Evidence used |
|---|---|---|
| [JUZIPi-tech/SD_PRO](https://github.com/JUZIPi-tech/SD_PRO/tree/5dc22a11d6ca5ffa8cc2aad103cd82e7c77d7e1d) | Vendor repository snapshot, commit `5dc22a11d6ca5ffa8cc2aad103cd82e7c77d7e1d` | Repository files include a short README, V1.0.4 and V1.0.6 binaries, and the Smart Clock manual; no schematic, BOM, firmware source, full-flash export procedure, restore procedure, or independent failed-boot recovery design appears in this reviewed snapshot. |
| [Vendor Smart Clock Manual V1.2.1](https://github.com/JUZIPi-tech/SD_PRO/blob/5dc22a11d6ca5ffa8cc2aad103cd82e7c77d7e1d/Smart%20Clock%20Manual%20V1.2.1.docx) | Pinned to the vendor snapshot above | Stock setup AP and local web interface context; no qualifying full backup/restore or failed-boot recovery evidence. |
| [Vendor V1.0.6 image](https://github.com/JUZIPi-tech/SD_PRO/blob/5dc22a11d6ca5ffa8cc2aad103cd82e7c77d7e1d/SDPro_V1.0.6_20260525_174828.bin) | Pinned vendor artifact | Binary structure and updater behavior, as bounded in [stock firmware analysis](stock-firmware-analysis.md). |
| [Mini-Display SD PRO pinout note](https://github.com/piotrkochan/homeassistant-minidisplay/blob/ae012e7a81d873692eb67dc606927c69ab16cf49/notes/pinout-sdpro.md) | Commit `ae012e7a81d873692eb67dc606927c69ab16cf49` | Community-reported, hardware-tested profile for another SD PRO; not tied to this unit's PCB revision. |
| SmartClock AI | Commit `a86a31c31db3cec6189b65157566a66f4abe4fd0`; details summarized in [stock OTA research](stock-ota-installation-research.md) | Third-party installation/runtime claims and a different display-CS assignment; not vendor documentation or evidence for this unit. |
| [Ai-Thinker ESP-12F specification](https://aithinker-static.oss-cn-shenzhen.aliyuncs.com/docs/Public%20Document%20Center/WiFi/esp8266/Specification/ESP-12F%20Specification-20220807.pdf) | Module specification | ESP-12F module pin and supply requirements; does not identify the clock's carrier PCB, regulator, display wiring, or flash population. |
| [Recovery](recovery.md), [hardware](hardware.md), [stock OTA research](stock-ota-installation-research.md), [stock firmware analysis](stock-firmware-analysis.md), and [OTA readiness review](ota-readiness-review.md) | Existing project evidence | Preserved prior artifact analysis and explicit installation, backup, and recovery limitations; no need to repeat the V1.0.6 reverse engineering here. |

## Evidence That Could Resolve Unknowns

Use only information already available to the maintainer or documents supplied by the vendor. Helpful materials include:

- Existing clear photos of labels and PCB markings, if already available without opening or probing the clock.
- Purchase/revision records or a vendor record that ties the unit's serial/revision to a schematic and BOM.
- A stock version identifier visible on an ordinary existing screen, or an already-saved record of the version. Do not trigger a reboot, update, network request, or diagnostic action to obtain it.
- Vendor documentation for the exact revision covering fitted flash, power, display wiring, boot straps, stock updater/browser checks, storage schema, and preservation of configuration/activation data.
- A documented nonmutating full-flash export over the stock Wi-Fi service, with complete region coverage and snapshot consistency, and a corresponding tested full-region restore path.
- A documented Wi-Fi recovery service that runs independently when the normal application cannot boot, including its boot selection, protected regions, recovery procedure, and behavior if power fails during update or boot copy.

Do not open, probe, scan, reset, connect to, or send requests to the clock as part of this evidence collection. A claimed HTTP `GET` or “read-only” label is not proof of a handler's side effects.

## Draft Vendor Inquiry — Do Not Send

**Subject:** SD PRO hardware revision, firmware identification, and Wi-Fi recovery documentation

Hello JUZIPi team,

Could you provide documentation tied to the exact SD PRO board revision for this unit? We are looking for:

- The PCB revision identifier, schematic/BOM, fitted flash part and capacity, board input/regulator specifications, display controller, and SPI/CS/DC/reset/backlight wiring, including boot-strap requirements.
- A way to identify the installed stock firmware version using an ordinary existing screen or interface, plus the matching stock browser/update validation rules, filesystem version/geometry, and configuration/activation preservation requirements.
- Whether stock firmware supports a nonmutating, complete flash export over Wi-Fi. If so, please specify every included flash region, snapshot consistency, integrity checks, and a corresponding full-region restore procedure.
- Whether a Wi-Fi recovery service remains available when the normal application fails to boot. Please explain how it starts independently, which regions it preserves, how it restores the application, and what happens after power loss during update or boot copy.

Please indicate which of these materials and procedures apply to the unit's exact revision. We will not perform a firmware update or device-side diagnostic request while gathering this information.

Thank you.

## Decision and Stop Boundary

**Keep installation at NO-GO.** The unit-specific board and installed firmware are not identified beyond the maintainer-reported ESP-12F module. No qualifying full-flash Wi-Fi export and restore procedure or independent Wi-Fi failed-boot recovery path is documented. The analyzed V1.0.6 binary and community-tested SD PRO profiles do not satisfy those gates. The maintenance updater is host-implemented but still needs spare-device validation, and it cannot replace independent failed-boot recovery.

No vendor contact was made. No checklist item in `PLANNING.md` was changed. Stop Part 1 here; any later part requires its own explicit invocation and prerequisites.
