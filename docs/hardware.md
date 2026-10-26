# Hardware Investigation

**Status:** public-source research and static stock-binary analysis completed on 2026-10-26. The project unit has not been physically inspected. No board-specific settings are approved, and no device operations have been performed. Physical hardware validation remains **PENDING**.

## Findings

The manufacturer's [SD_PRO repository](https://github.com/JUZIPi-tech/SD_PRO) currently contains a short README, the stock images [SDPro V1.0.4](https://github.com/JUZIPi-tech/SD_PRO/blob/main/SDPro_V1.0.4_20260423_135657.bin) and [SDPro V1.0.6](https://github.com/JUZIPi-tech/SD_PRO/blob/main/SDPro_V1.0.6_20260525_174828.bin), and the [Smart Clock Manual V1.2.1](https://github.com/JUZIPi-tech/SD_PRO/blob/main/Smart%20Clock%20Manual%20V1.2.1.docx). It does not publish firmware source, a schematic, a board revision map, a pinout, a stock flash or filesystem layout, or backup and recovery instructions. The manual documents Wi-Fi setup through an access point named `Smart Weather Clock` and a local page at `192.168.4.1`; it gives no electrical or recovery specifications.

An independent [hardware-tested JUZIPi SD PRO project](https://github.com/piotrkochan/homeassistant-minidisplay) reports one tested unit with an ESP8266/ESP-12F, 4 MB flash, and a 240 × 240 ST7789-compatible display. Its [SD PRO profile](https://github.com/piotrkochan/homeassistant-minidisplay/blob/master/notes/pinout-sdpro.md) publishes a candidate pin map. These are useful leads for that maintainer's unit, not confirmation of this project's unit or its revision. Its pinout and update observations are used only as research references; no community firmware code is copied.

The [Ai-Thinker ESP-12F datasheet](https://aithinker-static.oss-cn-shenzhen.aliyuncs.com/docs/Public%20Document%20Center/WiFi/esp8266/Specification/ESP-12F%20Specification-20220807.pdf) identifies that module as ESP8266-based, with default 32-Mbit SPI flash and a 3.0–3.6 V module supply (typical 3.3 V, supply capability above 500 mA). Those figures apply only if the installed module is confirmed as ESP-12F; they do not establish the clock's USB input range, regulator, display current, or total supply requirement. Espressif's [ESP8266EX datasheet](https://documentation.espressif.com/0a-esp8266ex_datasheet_en.html) and [esptool boot-mode guide](https://docs.espressif.com/projects/esptool/en/latest/esp8266/advanced-topics/boot-mode-selection.html) describe chip-level capabilities, not the board wiring or accessible recovery method.

## Stock Firmware Evidence

The supplied `SDPro_V1.0.6_20260525_174828.bin` matches the manufacturer's published Git blob at commit `5dc22a11d6ca5ffa8cc2aad103cd82e7c77d7e1d`. Its SHA-256 is `058e2ebcb9a35bc6a8c4e18a5441a26a88fae74d0e7684053a3bdea496cf529b`. See the [technical report and reproducible checks](stock-firmware-analysis.md) for segment tables, offsets, source comparisons, and limitations.

Confirmed for this file:

- A 488,304-byte combined ESP8266 image contains eboot-style code at offset `0x0000` and a five-segment application at `0x1000`, with entry points `0x4010F45C` and `0x401000B8` respectively.
- Both headers declare DIO, a 40 MHz flash interface, and 4 MB flash. These are build settings, not measurements of the physical device or CPU clock.
- Both segment XOR checksums validate (`0xB0` and `0xA5`), as does an older Arduino-style whole-image CRC (`0xCCC59B3F`) with length/CRC words at `0xFF8/0xFFC`. No appended signature or SHA-256 trailer is present.
- Filesystem construction and updater code link LittleFS to flash offsets `0x100000–0x3FA000`, with an 8,192-byte block setting. EEPROM code references base `0x3FB000`. These describe the binary's configuration; installed contents and physical capacity remain unknown.
- The file ends before the configured filesystem, so it does not include the stock web assets, animations, settings, or a complete device backup.
- Static route registration identifies `POST /update_ota`. The upload callback has a nominal `0x80000`-byte guard and Arduino-style staging/finalization. Its `SDP` prefix error logs without rejecting the upload; browser-side rules and all verifier initialization remain unverified.

A custom update is technically plausible, but acceptance, successful boot, and recovery are separate unverified questions. No board target, pinout, firmware size budget, or installation method is approved by these findings. The manufacturer's binary is not evidence that the project unit runs that exact version.

## Candidate Hardware Profile

The following profile is reported for another hardware-tested unit. Every item remains **PENDING for the project unit** until its markings and behavior are checked.

| Item | Candidate reference | Project-unit status |
|---|---|---|
| MCU/module | ESP8266 / Ai-Thinker ESP-12F | PENDING — inspect markings; another project also reports ESP-12E variants |
| Display | ST7789-compatible, 240 × 240 | PENDING — confirm controller, active area, orientation, color order, and inversion |
| SPI MOSI / SCLK | GPIO13 / GPIO14 | PENDING — do not configure from the community profile alone |
| Display CS | Not connected; panel permanently selected | PENDING |
| Display DC / reset | GPIO0 / GPIO2 | PENDING — both are ESP8266 boot-configuration pins |
| Backlight | GPIO5, active-low PWM | PENDING — confirm electrical polarity and drive circuit |
| Button | GPIO4 | PENDING |
| SPI mode / pixel order | Mode 3 / BGR; inversion enabled | PENDING — verify visually and electrically |
| Flash | 4 MB is reported for the candidate ESP-12F unit and declared by the analyzed image | PENDING — read the installed flash identification and capacity |
| Device input power | Manual says to connect the data cable; no voltage or current rating is given | PENDING — identify connector, regulator, safe input range, and current draw |
| Filesystem and partitions | Analyzed image links LittleFS at `0x100000–0x3FA000` and EEPROM base `0x3FB000` | PENDING — confirm installed layout, contents, geometry, and configuration compatibility |
| Bootloader and serial access | ESP8266 ROM serial download is a chip capability; board access is unknown | PENDING |
| Stock OTA | `POST /update_ota` and a nominal 512 KiB guard are confirmed in the analyzed V1.0.6 binary | PENDING — installed version, complete validation rules, safe limits, and recovery are unverified |

For a confirmed ESP-12F module, its datasheet's 32-Mbit default flash corresponds to 4 MB. The same datasheet's power figures describe the module only. The display and other board circuitry add unknown load, so neither figure should be used to choose a power supply or firmware partition layout before inspecting the unit.

The independent reverse-engineering notes also report that the stock browser checks for firmware filenames beginning with `SDP`. Browser assets are absent from the analyzed image; its backend prefix check only logs an error and continues. Neither observation establishes a backup, rollback, or recovery path. The manufacturer binaries are not proven to match this unit's board revision or complete flash contents.

## Existing NeonByte Implementation

The repository has a Node.js/TypeScript Spotify agent, a browser simulator, and a C++17 firmware core under `firmware/`. PlatformIO is configured for native host tests only; there is no device board target or network server, and the local interface does not communicate with a clock. The hardware-independent v1 JSON handler and remaining limits are described in [firmware development](firmware-development.md). The device address, token pairing, binary payload limits, and hardware-dependent storage constraints remain pending.

The agent already resolves `auto`, `spotify`, and `gif` scenes and converts media to 240 × 240 RGB565. Its version-1 animation asset stores complete frames, each requiring 115,200 pixel bytes plus a two-byte delay. This is a file-format fact, not evidence that the target can hold a frame in RAM or has sufficient flash. The host-tested `AnimationReader` streams the existing animation file through caller-sized reads; the hardware chunk size and storage limits still require measurement.

## Information Still Required

Before choosing a PlatformIO board, display driver, pins, partition table, or upload method, obtain:

- A clear photo of the product label, enclosure, connectors, and all startup/version screens.
- If the enclosure can be opened safely, well-lit photos of both PCB sides and close-ups of the MCU/module, flash, display connector, USB/serial interface, and board revision markings. Do not open a sealed or warranty-sensitive unit solely for this investigation.
- The exact stock firmware version shown by the device and any vendor-supplied documentation for that revision.
- Confirmation of the power adapter/cable rating and board input voltage/current limits, from the label or a safe measurement.
- Identification of accessible UART signals, boot/reset controls, and the exact chip boot strap wiring.
- A non-destructive full-flash backup procedure, stock image match, and restore procedure verified on an identical spare device before any work on the project unit.
- Confirmed flash capacity, filesystem/partition boundaries, stock updater limits, and whether rollback or dual-image boot is supported.

Physical board inspection is required to turn the candidate profile into a board configuration. A product name or a matching enclosure is not sufficient evidence.

## Proposed Firmware Architecture

The hardware-independent core is implemented and tested on the PlatformIO native environment. Board-specific firmware and all physical behavior remain unimplemented and pending hardware evidence.

- **Core state:** implemented as pure C++ mode selection, heartbeat expiry, progress correction, and display rendering calls.
- **Protocol layer:** implements the existing v1 JSON status, mode, Spotify, and heartbeat routes with closed-schema validation and bearer authentication through an injected checker. Cover and animation uploads remain unavailable until their limits and storage behavior are defined.
- **Network services:** the transport-neutral request/response interface is defined; Wi-Fi provisioning, reconnection, HTTP server, and nonblocking behavior remain unimplemented.
- **Media reader:** the native-tested reader validates and streams the existing RGB565 animation format. Original GIF decoding is not part of the firmware.
- **Storage service:** mode load/save and animation reads are abstracted. Upload staging, checksums, atomic replacement, and recovery remain unimplemented.
- **Display interface:** a rendering interface is defined. Confirmed board pins, controller initialization, orientation, pixel order, inversion, and backlight behavior require hardware inspection.
- **Host validation:** the PlatformIO native suite covers state, protocol, interfaces, and animation bounds. A hardware target must wait until the exact board profile is evidenced.

The candidate ESP8266 mapping assigns DC and reset to GPIO0 and GPIO2, which are also boot-mode pins according to Espressif. If that map is correct, attached display circuitry and reset levels could affect startup or serial recovery. Verify strap levels and signal loading before connecting a programmer or building a board profile.

## References

- [JUZIPi-tech SD_PRO repository](https://github.com/JUZIPi-tech/SD_PRO) — vendor README, stock images, and manual.
- [Stock firmware technical report](stock-firmware-analysis.md) — verified local binary structure, checksums, linked layout, OTA control flow, and pinned primary-source comparisons.
- [JUZIPi Smart Clock Manual V1.2.1](https://github.com/JUZIPi-tech/SD_PRO/blob/main/Smart%20Clock%20Manual%20V1.2.1.docx) — Wi-Fi setup instructions; no hardware or recovery details.
- [Ai-Thinker ESP-12F datasheet](https://aithinker-static.oss-cn-shenzhen.aliyuncs.com/docs/Public%20Document%20Center/WiFi/esp8266/Specification/ESP-12F%20Specification-20220807.pdf) — module specifications, conditional on module identification.
- [Espressif ESP8266EX datasheet](https://documentation.espressif.com/0a-esp8266ex_datasheet_en.html) — SoC electrical and boot-pin reference.
- [Espressif esptool ESP8266 boot-mode guide](https://docs.espressif.com/projects/esptool/en/latest/esp8266/advanced-topics/boot-mode-selection.html) — generic ROM serial boot requirements.
- [Independent tested SD PRO hardware profile](https://github.com/piotrkochan/homeassistant-minidisplay/blob/master/notes/pinout-sdpro.md) — candidate pin map and configuration for another unit.
- [Independent stock firmware reverse-engineering notes](https://github.com/piotrkochan/homeassistant-minidisplay/blob/master/notes/reverse-engineering.md) — reported binary metadata and OTA route for the studied unit.

## Safety Boundary

Until the project unit is identified and a backup/restore path is verified, do not select a board profile, compile a device target, upload firmware, run OTA, erase flash, or alter partitions. Continue only with source review and host-side design after maintainer approval.
