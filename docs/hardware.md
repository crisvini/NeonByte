# Hardware Investigation

**Status (2026-10-27): NOT RELEASE READY.** The maintainer visually confirmed an **ESP-12F / ESP8266** module in the project unit on 2026-10-26. Part 6 concluded **NO-GO** and Part 7 remains blocked; the [installation decision report](installation-go-no-go.md) records the evidence and blockers. Display wiring, physical flash capacity, installed layout, power, boot compatibility, backup, and recovery remain **PENDING**. No device endpoint has been contacted and no firmware has been uploaded. See the [release-readiness report](release-readiness.md).

## Evidence and Its Limits

The manufacturer's [SD_PRO repository](https://github.com/JUZIPi-tech/SD_PRO) publishes application update images and a [manual](https://github.com/JUZIPi-tech/SD_PRO/blob/main/Smart%20Clock%20Manual%20V1.2.1.docx), without board source, schematics, or verified backup/restore instructions. The manual describes a stock setup AP and local web interface. It does not establish boot recovery.

The supplied V1.0.6 artifact matches the manufacturer object at commit `5dc22a11d6ca5ffa8cc2aad103cd82e7c77d7e1d`. Its SHA-256 is `058e2ebcb9a35bc6a8c4e18a5441a26a88fae74d0e7684053a3bdea496cf529b`. The [static report](stock-firmware-analysis.md) establishes its combined ESP8266 image structure, 488,304-byte length, checksums, linked filesystem geometry, and OTA callback. It does not identify the installed firmware version or validate this unit's flash contents.

The [Ai-Thinker ESP-12F datasheet](https://aithinker-static.oss-cn-shenzhen.aliyuncs.com/docs/Public%20Document%20Center/WiFi/esp8266/Specification/ESP-12F%20Specification-20220807.pdf) specifies default 32-Mbit flash and module supply requirements. Visual module identification establishes the MCU family; it does not measure the fitted flash, board input voltage, regulator, or display load. These remain pending rather than inferred from the module name.

## Provisional Compilation Profile

An [independent hardware-tested SD PRO project](https://github.com/piotrkochan/homeassistant-minidisplay/blob/master/notes/pinout-sdpro.md) is the research source for this profile. Only pinout facts are used; no community firmware code is copied. These settings are **unverified on the project unit**.

| Item | Local build assumption | Evidence boundary |
|---|---|---|
| MCU/module | ESP8266 / ESP-12F | Visually confirmed by the maintainer |
| PlatformIO board manifest | `esp12e` generic compilation manifest | Build scaffold for the ESP8266 family; not a board identification |
| Flash interface/capacity | DIO, 40 MHz, 4 MB | Stock artifact and independent unit; physical chip capacity PENDING |
| CPU clock | 80 MHz | Generic manifest default; stock CPU clock not established |
| Display | ST7789-compatible, 240 × 240 | Independent unit only |
| SPI MOSI / SCLK | GPIO13 / GPIO14 | Default ESP8266 hardware SPI; wiring PENDING |
| CS | Unconnected, permanently selected | PENDING |
| DC / reset | GPIO0 / GPIO2 | PENDING; both have boot strap implications |
| Backlight | GPIO5, active-low | PENDING; no button GPIO is used |
| SPI / colors | Mode 3, MADCTL RGB/BGR bit clear (`0x00`), inversion enabled; 20 MHz requested from the first initialization command | [Offline tests](ota-compatibility-corrections.md) cover the requested frequency and byte path. The maintainer's pre-correction chart showed red/blue exchange with neutral colors intact, supporting the one-bit correction. Post-correction color fidelity and timing remain PENDING |
| Rotation / offsets | Rotation 2 (180 degrees); MADCTL `0x00` (RGB); column/row offsets 0/0 | The [orientation correction](display-orientation-correction.md) verifies commands and address windows; this color-only update preserves them. Post-correction physical color output remains PENDING |
| Filesystem | LittleFS `0x100000–0x3FA000`, block 8,192 bytes | Matches the researched stock artifact's linked geometry; installed compatibility PENDING |
| Boot / updates | Arduino 3.1.2 eboot combined image | Different from the old stock boot image; acceptance and startup PENDING |

`NEONBYTE_ENABLE_DISPLAY=0` keeps the provisional artifact from initializing SPI or display GPIOs. The `esp8266-integration-check` environment compiles the enabled paths for local inspection only. Neither artifact is approved for installation. See the [integration report](esp8266-integration.md).

The [safe first-boot report](safe-first-boot.md) documents host-tested provisioning/maintenance independent of display and configuration storage, with a private per-device identity required for future use. Public compile checks contain no usable credentials. This does not validate radio behavior, boot recovery, or installation.

## Firmware and Storage Boundaries

The native environment remains the default. ESP8266 code provides Wi-Fi, a bounded HTTP server, persisted bearer/configuration/mode, namespaced asset staging, RGB565 rows, animation playback, and gated OTA. These are compile-validated implementations, not physical validation. No agent-to-device client is implemented in this phase.

The 4m3m linker map retains the stock-researched filesystem offsets; it does not change device partitions during compilation. Runtime mounts explicitly disable autoformat. Code writes only under `/neonbyte/`, does not migrate stock configuration or activation data, and exposes no filesystem updater or erase route. Even a matching address range does not prove filesystem-version compatibility or that mounting/writing would preserve all stock behavior.

A 240 × 240 RGB565 frame has 115,200 pixel bytes, too large for the chosen row buffer strategy. The implementation streams 480-byte rows. Up to 20 NBIF frames occupy 2,304,051 bytes; available space and atomic replacement can impose a much lower limit.

## Open Hardware and Installation Blockers

- PCB revision, physical flash identification/capacity, power requirements, boot strap loading, display controller, pins, color order, offsets, and backlight behavior.
- Installed stock version, complete OTA validation rules, filesystem contents/compatibility, free space, and configuration/activation preservation.
- A complete unit-specific backup and a proven independent recovery path that remains reachable after a failed application boot.
- Actual free heap, stack high-water mark, FPS, transfer behavior, reset/interruption behavior, and sustained testing.

Wi-Fi is the only permitted communication and update method. Physical programming, UART, soldering, and USB-serial are out of scope. Their existence as chip capabilities is not an available recovery solution for this project. **A safe Wi-Fi-only first installation is not established; deployment is blocked.** See [recovery](recovery.md).
