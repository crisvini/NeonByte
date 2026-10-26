# Hardware Investigation

**Status:** preliminary. No unit has been physically inspected in this phase. All hardware properties of the project unit remain PENDING.

## Sources Reviewed

| Source | What it reports | How it will be used |
|---|---|---|
| [JUZIPi-tech SD_PRO repository](https://github.com/JUZIPi-tech/SD_PRO) | The repository under the JUZIPi-tech organization contains SD Pro binaries and the Smart Clock V1.2.1 manual. | A public reference possibly associated with the vendor; a formal link and match to this unit have not been confirmed. No binary has been downloaded, uploaded, or run. |
| [Community homeassistant-minidisplay project](https://github.com/piotrkochan/homeassistant-minidisplay) | The maintainer reports testing a JUZIPi SD PRO with an ESP8266/ESP-12F, 4 MB of flash, and a 240 × 240 ST7789 LCD. | An independent report about one unit; it does not confirm this project's hardware revision or configuration. |

No photos of the unit, board revision identification, or screenshots of the original interface are attached to this repository. The 240 × 240 resolution comes from the plan and community report, so it remains an expected target rather than a confirmed measurement.

## Unit Identification

| Item | Status | Required evidence |
|---|---|---|
| Exact model and revision on the label | PENDING | Photo of the label and enclosure. |
| Board photos and component markings | PENDING | Clear board photos; do not open the device if doing so involves risk or damage. |
| MCU, module, and clock speed | PENDING | Legible markings or technical documentation tied to the exact revision. |
| LCD controller, resolution, rotation, and colors | PENDING | Manual for the applicable revision and visual/electrical confirmation on an authorized bench. |
| SPI pinout, chip select, reset, and backlight | PENDING | Schematic or original firmware matching the revision. |
| Power supply and electrical limits | PENDING | Vendor specification and safe measurement. |
| Flash, partitions, and file system | PENDING | Unit identification and non-destructive technical inspection. |
| Bootloader, serial, and recovery mode | PENDING | Documented and tested procedure for the exact revision. |
| Original firmware and backup/restore procedure | PENDING | Matching image and a restorable procedure tested before any flash. |
| Original interface and firmware version | PENDING | Screenshots of the interface and version shown on the device. |

## Risks and Preliminary Resource Budget

| Resource or risk | Status |
|---|---|
| Free RAM during operation and peak drawing/upload use | PENDING — measure on identified hardware |
| Free flash after firmware and file system use | PENDING — measure on identified hardware |
| Maximum firmware size and OTA layout | PENDING — confirm without flashing |
| FPS for each screen and update cost | PENDING — measure on a bench |
| Animation size, frame, and timing limits | PENDING — define from RAM, flash, and performance measurements |
| Recovery method after a boot failure | PENDING — document and test before flashing |

No capacity or performance figures are assumed. The 240 × 240 value is only an expected dimension in the plan.

## Safety Rule

Until the MCU, pinout, power supply, display, flash, partitions, bootloader, original firmware backup, and recovery procedure are confirmed, work remains limited to the contract and simulator. Do not flash firmware, run OTA, or erase/change partitions based only on references for other units.
