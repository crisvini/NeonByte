# Device Backup and Recovery

**Status:** PENDING. The project unit has not been inspected, backed up, restored, or tested in a recovery mode. No recovery procedure is approved for this unit.

The hardware-independent firmware core now has native host tests. It does not provide a board image, device network endpoint, full-flash backup, or verified restore procedure; all physical recovery requirements remain pending.

## Evidence Reviewed

The [JUZIPi SD_PRO repository](https://github.com/JUZIPi-tech/SD_PRO) publishes two stock firmware binaries and the [Smart Clock Manual V1.2.1](https://github.com/JUZIPi-tech/SD_PRO/blob/main/Smart%20Clock%20Manual%20V1.2.1.docx). The manual describes normal Wi-Fi setup but does not document stock firmware backup, serial recovery, restore, rollback, or partition recovery. Published binaries do not prove a match to the project unit's revision or preserve its full flash contents and settings.

An [independent reverse-engineering report](https://github.com/piotrkochan/homeassistant-minidisplay/blob/master/notes/reverse-engineering.md) records a stock HTTP update endpoint for the maintainer's inspected unit. Another [community installation guide](https://github.com/piotrkochan/homeassistant-minidisplay#install-on-juzipi-sd-pro) describes sending a bootstrap image through the original updater. These reports describe firmware update paths, not a verified backup or restore method, and are not approved instructions for the project unit.

If the installed module is confirmed to be ESP-12F/ESP8266, Espressif documents a ROM serial downloader selected by holding GPIO0 low during reset, with required boot strap states on other pins. Board access to UART, GPIO0, reset, and safe power is unknown. The chipset capability alone does not establish that recovery can be performed without opening or damaging this clock.

## What the Stock Update Image Can Preserve

Static analysis of `SDPro_V1.0.6_20260525_174828.bin` is documented in the [technical report](stock-firmware-analysis.md). The file is identical to the manufacturer's published V1.0.6 object, has 488,304 bytes, and contains bootloader/application images with valid segment checksums and a valid whole-image CRC. Its SHA-256 is `058e2ebcb9a35bc6a8c4e18a5441a26a88fae74d0e7684053a3bdea496cf529b`.

This is an update package, **not a full-flash backup**. It ends at offset `0x77370`, before the binary's linked LittleFS range at `0x100000–0x3FA000` and EEPROM base at `0x3FB000`. A complete read of the declared 4 MB address space would have 4,194,304 bytes; the physical capacity still requires identification. The package omits filesystem assets, device settings, and flash-tail contents. Reinstalling it cannot by itself restore erased web pages, images, configuration, or provisioning. The two images are bootloader and application, not verified rollback slots.

The analyzed firmware registers `POST /update_ota` and uses temporary staging consistent with the Arduino eboot update mechanism. That route belongs to the running application. Replacing the application can remove access to it, and replacing boot code or interrupting the copy can prevent normal startup. No automatic rollback, protected recovery image, or restoration path has been established.

Its filename-prefix error does not reject the upload in the traced backend callback. Its nominal 512 KiB guard skips oversized chunks without an explicit size error and is followed by `Update.end(true)`-style finalization. Buffered progress accounting further limits what can be inferred about exact accepted lengths. These are reasons to require controlled spare-device validation, not to attempt oversized, malformed, or renamed uploads on the project unit. Full browser checks and verifier initialization remain PENDING; generic signature-error text alone does not establish mandatory signing.

No network request to the clock, device-target compilation, or flashing was performed. All physical backup and recovery requirements below remain open.

## Preservation and Recovery Gate

The original firmware must remain preserved. Do not update the device through the stock updater, install a bootstrap, flash custom firmware, erase flash, or change partitions. A matching filename or product name is not enough to establish compatibility.

Before any future device test, the maintainer must have all of the following:

1. Confirmed product and PCB revision, module/MCU, flash part and capacity, power input, boot straps, and accessible recovery interface.
2. A non-destructive full-flash read procedure documented for the confirmed chip and board. Read the entire flash, including bootloader, application, filesystem, and settings/configuration regions.
3. Two independent reads with matching hashes, plus a written manifest recording device revision, displayed firmware version, tool version, detected flash size, and backup hashes. Keep backups encrypted and outside version control because they may contain Wi-Fi credentials.
4. A verified stock image match and a restore procedure proven on an identical spare or sacrificial unit. A vendor application image alone is not a full-flash backup.
5. A written recovery runbook, including serial voltage levels, adapter wiring, boot/reset sequence, image offsets, and a confirmed way to recover if the normal updater no longer works.

If the maintainer's requirement is to keep the original firmware on the project unit untouched, use a separate identical spare for firmware testing. If no spare is available, leave the unit on stock firmware and continue with host-side work only.

## Current Safe Next Steps

- Obtain photos and the stock firmware version information requested in [the hardware investigation](hardware.md).
- Ask the manufacturer for the exact revision's schematic, stock update limits, full-flash backup method, and recovery/restore instructions.
- Request the matching filesystem image/assets and configuration or activation preservation requirements; the published application update does not contain them.
- Preserve the analyzed file and its hash. After a separately authorized full backup exists, inspect its filesystem and updater web assets offline to resolve browser checks and configuration boundaries.
- If a spare unit is available, inspect and validate backup/restore there before making a device-specific firmware plan.
- Do not probe undocumented stock endpoints on a network containing personal credentials. Independent analysis reports a potential unauthenticated configuration response; that behavior has not been tested on the project unit.

No flashing, OTA, erase, partition modification, or device operation has been performed as part of this investigation.
