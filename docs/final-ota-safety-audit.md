# Final First-Installation OTA Safety Audit

**Date:** 2026-10-27. **Decision: NO-GO.** This audit authorizes no installation or physical validation. The clock was not contacted, discovered, reset, or modified. No private identity, installation package, filesystem image, release, or flash operation was created or performed. Only existing compilation-only ESP8266 profiles were built, under the previously authorized provisional assumptions.

## Findings and Offline Corrections

**Subsequent authorized cycle:** [final offline preparation](final-offline-preparation.md) implements and fault-tests a separate authenticated legacy stock-restoration route. Statements below that restoration is unimplemented describe this earlier audit. Both modern routes still reject legacy images; independent Wi-Fi failed-boot recovery and full backup remain unestablished, so **NO-GO** is unchanged.

| Finding | Failure consequence | Correction and evidence |
|---|---|---|
| HTTP startup discarded the result of listener creation | A transient TCP allocation/bind/listen failure left an AP with no provisioning or updater service for the rest of that boot | `DeviceHttpServer::begin()` now checks listener state. `SafeStartup` retries failed HTTP startup every five seconds, without restarting a successful listener. Native fault injection and the extracted real begin adapter cover failure and retry. |
| Automatic startup did not require successful recovery networking | At ten seconds, storage/display initialization could begin while the AP or HTTP listener was unavailable, removing the intended maintenance opportunity before a hang/reset | Automatic risky initialization now requires successful AP and HTTP startup. A recovered service restarts the ten-second maintenance window. Permanent failures perform no automatic storage access or RTC risky-operation writes. Both failure classes were reproduced before correction. |
| AP success checked only IP/gateway/netmask after SDK calls | Correct addresses could mask a disabled AP, incorrect SSID/password/authentication, or stopped DHCP | Startup additionally checks AP mode, SDK configuration read success, exact SSID, WPA2, exact terminated password, and started DHCP. A mismatch requests AP disable and leaves startup to retry. The actual adapter method is host-compiled against injected SDK states; each added failure class is rejected. |
| Raw OTA readback and updater hashing had no cooperative service points | Several synchronous whole-image passes could starve SDK/watchdog service and interrupt maintenance before activation | The raw flash read adapter and updater hash callback now call `optimistic_yield(1000)` between bounded chunks. The extracted adapters failed their service-opportunity regressions before correction. Both target profiles compile. Actual watchdog timing is unmeasured. |

The listener failure is supported by the pinned [Arduino WiFiServer implementation](https://github.com/esp8266/Arduino/blob/3.1.2/libraries/ESP8266WiFi/src/WiFiServer.cpp), which can return from `begin()` without a listener. The [AP implementation](https://github.com/esp8266/Arduino/blob/3.1.2/libraries/ESP8266WiFi/src/ESP8266WiFiAP.cpp) and local SDK headers support the new readbacks. These are source and mock results, not evidence of working radio, DHCP leases, or client access on this unit.

The cooperative calls service SDK tasks; they do not reenter the application HTTP handler, resume paused display work, or clear the RTC guard. Request authentication, exact framing, size and SHA-256 requirements, checked image readback, strict modern CRC/E9 validators, OTA feature gates, activation ordering, and deployment guards remain in force. Complete invalid candidates remain inactive in the native fault tests.

Existing protections remain relevant: no automatic filesystem formatting; private recovery credentials independent of LCD/storage; recovery networking before guarded filesystem/display work; maintenance after representative crash/reset evidence; and explicit maintenance-on-every-boot selection in the integration-check profile. That selection is still not a durable first-boot-only policy. The provisional profile still defaults to automatic startup and disables display/OTA. Both public profiles lack a usable private recovery identity and must never be installed.

## Return to Stock While NeonByte Still Runs

**Conclusion:** A dedicated authenticated live return-to-stock path is technically plausible under the researched layout, but it is **not implemented, validated on hardware, or a safe recovery procedure**. Both current NeonByte firmware routes reject the unchanged original V1.0.6 file. Do not patch that file or weaken those validators.

Fresh local inspection of the existing, unchanged manufacturer artifact established:

| Property | Result |
|---|---|
| File length | 488,304 bytes; below the existing 524,288-byte maintenance-route cap |
| SHA-256 | `058e2ebcb9a35bc6a8c4e18a5441a26a88fae74d0e7684053a3bdea496cf529b` |
| Boot/application | E9 at 0 / `0x1000`, one / five segments, valid XOR checksums |
| Flash declaration | DIO / 40 MHz / 4 MB; declaration is not a unit measurement |
| Legacy length/CRC | `0xFF8` / `0xFFC`; CRC `0xCCC59B3F` validates |
| Modern length/CRC | Expected at `0x1010` / `0x1014`; absent in the required modern form |
| Existing NeonByte structural and modern CRC validators | Both reject the original file, as expected |
| Pinned core `_verifyEnd()` with the stock bytes and a synthetic 4 MiB flash | Accepts its header/capacity; this is only the weak core end check, not a complete update or boot test |
| Portable staging calculation with a hypothetical 362,960-byte running sketch and 4m3m geometry | Accepts the size; 491,520 rounded bytes staged at `0x88000–0x100000` |

The [pinned vendor tree](https://api.github.com/repos/JUZIPi-tech/SD_PRO/git/trees/5dc22a11d6ca5ffa8cc2aad103cd82e7c77d7e1d) was reread through the GitHub connector and confirms the artifact's 488,304-byte blob. The independently checked bytes match the earlier [stock analysis](stock-firmware-analysis.md). They do not identify the installed version or constitute a manufacturer signature, complete backup, or revision compatibility proof.

The [pinned updater](https://github.com/esp8266/Arduino/blob/3.1.2/cores/esp8266/Updater.cpp) can stage a combined image and schedule a copy to offset zero; it does not inherently require NeonByte's modern CRC convention. The [pinned eboot source](https://github.com/esp8266/Arduino/blob/3.1.2/bootloaders/eboot/eboot.c) copies sector-rounded bytes, then loads an application at offset `0x1000`. **Inference:** these mechanisms do not impose an obvious transport/size/offset barrier to a separately validated legacy image. They do not demonstrate that the old application or its bootloader will run on this unit after replacement.

A future reviewed implementation would need a separate, explicit stock-restoration operation with strict legacy-format validation and an approved artifact fingerprint, recovery authentication, a paused application, independent checked SHA-256 readback before activation, exact runtime geometry, and preserved filesystem/EEPROM/SDK boundaries. Existing modern update validation should stay unchanged. No restoration endpoint or upload command is supplied by this audit.

The manufacturer file restores only boot/application bytes. It cannot restore stock web files, animations, settings, activation data, EEPROM, or SDK/RF state that were lost or changed. Matching filesystem addresses and disabled autoformat do not prove that mounting/writing preserved stock data. Even a successfully restored vendor application could lack its web UI or settings. V1.0.6 may also differ from the unit's currently installed version.

The copy replaces the boot sector when it differs. This original image has different boot bytes from modern NeonByte, so that step cannot benefit from eboot's identical-sector skip. For this file, the destination extends to the rounded `0x78000`, not just exact EOF `0x77370`; the researched filesystem begins at `0x100000`. The source's post-copy comparison is disabled. Power loss or a flash failure during this in-place copy can destroy bootability before any Wi-Fi service runs. No protected rollback slot or independent rescue service was established.

Even an implemented live restore would require NeonByte, its radio, listener, credentials, raw updater, and flash to remain functional until restart. It could address a booting application with unavailable storage; it could never satisfy the independent failed-boot recovery gate. After stock replacement, the NeonByte AP, authentication and maintenance routes disappear.

## Fresh Offline Validation

| Check | Result |
|---|---|
| `npm run check` | Passed: Markdown/language checks, 9 root tests and 1 Windows-only skip, agent build/typecheck, 54 agent tests |
| `npm run test:offline` | Passed: 20 integration scenarios over loopback, with no clock/Spotify access |
| PlatformIO `native` | Passed: 69 tests in four suites |
| Standalone AddressSanitizer and UndefinedBehaviorSanitizer | Passed: all 69 native tests, all 20 offline scenarios, and the dependency/adapter probes |
| `python3 firmware/scripts/probe_compatibility.py` | Passed: pinned display, AP, SDK readback failures, listener result and cooperative OTA adapter checks; also added to CI |
| Both existing ESP8266 profiles | Compiled successfully; no project compiler warnings; non-installable local outputs only |
| Python image inspector and exact C++ runtime validators | Accepted both compile outputs; inspectors report `installationApproved: false` |
| `python3 firmware/scripts/probe_stock_restore.py SDPro_V1.0.6_20260525_174828.bin` | Passed the expected unchanged-stock inspection, core-header probe, strict-validator rejection and hypothetical staging calculation |
| Synthetic deployment guard and `git diff --check` | Passed; no real device target invoked |

The new stock probe uses only the previously reviewed local file, Python's standard library, the installed pinned core sources, and temporary host executables. It performs no OTA, writes no firmware image, and rejects any different artifact fingerprint or out-of-range hypothetical running length. The ignored stock artifact is not supplied to CI. The independent CRC/XOR procedure remains in [the stock report](stock-firmware-analysis.md#read-only-verification-procedure).

| Local build measurement | Provisional | Integration check |
|---|---:|---:|
| Complete image bytes | 361,936 | 362,960 |
| Reported program section bytes | 357,787 | 358,811 |
| Reported static RAM bytes | 43,908 | 43,908 |
| Headroom below nominal stock 512 KiB guard | 162,352 | 161,328 |
| Whole-image CRC | `0xDFE7741E` | `0x7D473578` |

Local compilation-only SHA-256 values:

- Provisional: `82edda14028611fe7dc7ad6cdbfa5f0cdd1da961147188a2ad1ac9d12b62fe58`.
- Integration check: `2953eea42c88a0f5e7c4475ccfe902c661ed94869ed02cacc7d7d5e47cdb4e96`.

Target compiler stack frames include AP start 96 bytes, AP network/security readback 144, startup begin/tick 64/32, raw readback 32, updater hash callback 16, candidate verifier 352, and HTTP JSON dispatch 1,152. These are individual frames; SDK, filesystem, yield/callback stack depth, runtime heap fragmentation and the 4,096-byte continuation stack's actual high-water mark remain unmeasured. Neither size headroom nor sanitized host execution proves first boot.

## Exactly What Still Blocks Safe Installation

All mandatory gates in [the installation decision](installation-go-no-go.md) remain open:

1. **Exact-unit hardware and boot evidence:** PCB revision, power, physical flash capacity/map, boot strap loading, LCD controller/pins/CS/reset/backlight, timing/orientation, and compatible boot layout are unknown. ESP-12F visual identification alone is insufficient.
2. **Matching installed stock version and verifier:** the actual version, web assets, multipart acceptance, complete verifier rules, first-image acceptance and resulting boot remain unverified.
3. **Preservation map and behavior:** stock filesystem/configuration/activation, EEPROM and SDK/RF/tail contents, compatibility and preservation have not been established for this unit.
4. **Complete unit-specific backup and restore:** no coherent, nonmutating full-flash Wi-Fi export and matching verified full-region restoration method exists in the reviewed evidence. The public vendor application is insufficient.
5. **Independent Wi-Fi-only failed-boot recovery:** no proven rescue mechanism survives a nonbooting application, broken boot sector or interrupted boot copy. This alone requires NO-GO; an AP within NeonByte cannot satisfy it.
6. **Private recovery identity and reviewed installation candidate:** no approved private profile, unique credentials securely delivered/retained, or exact identity-bearing candidate has been prepared. Current public binaries deliberately cannot provide recovery access.
7. **Identical spare and physical validation:** no matching spare is documented. Stock acceptance, boot/AP/DHCP/client access, flash I/O, filesystem preservation, actual memory/watchdog behavior, update/restore/reset behavior and power-loss safety are untested on equivalent hardware.
8. **Live return-to-stock implementation:** the current routes reject the legacy vendor image. A separate reviewed and spare-tested live-restoration path is absent, and even that would not resolve items 4–5.

Application recovery still depends on code reaching `setup()` and continuing to run/yield. Pre-startup constructor/SDK failure, radio failure, resource exhaustion, denial of service, inaccessible secrets, electrical problems, and non-resetting hangs remain possible. AP status readback is a startup observation, not continuous RF monitoring. HTTP remains plaintext on trusted networks; there is no publisher signature or automatic proof that an uploaded image retains the private identity. RTC state is not durable across power loss. Cold boot can retry faults under the default automatic policy.

**Final boundary:** offline defects were corrected; installation safety was not established. Keep the original unit untouched and the decision **NO-GO**. No hardware task in `PLANNING.md` is completed by this audit. If full backup/restore and independent Wi-Fi-only boot recovery cannot be established within the existing constraints, this unit must remain on its original firmware.
