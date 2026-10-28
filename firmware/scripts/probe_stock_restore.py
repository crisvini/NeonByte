#!/usr/bin/env python3
"""Inspect the reviewed stock file with host doubles; never restore or contact a device."""

import argparse
import hashlib
import json
import os
import struct
import subprocess
import tempfile
from pathlib import Path

from probe_compatibility import extractFunction


def inspectStock(data):
    expectedHash = "058e2ebcb9a35bc6a8c4e18a5441a26a88fae74d0e7684053a3bdea496cf529b"
    if hashlib.sha256(data).hexdigest() != expectedHash:
        raise ValueError("Only the unchanged, previously reviewed V1.0.6 artifact is supported")
    for offset, count, end in ((0, 1, 0xe20), (0x1000, 5, len(data))):
        magic, segments, mode, geometry, _ = struct.unpack_from("<BBBBI", data, offset)
        if (magic, segments, mode, geometry) != (0xe9, count, 2, 0x40):
            raise ValueError("Unexpected stock E9 header")
        position, checksum = offset + 8, 0xef
        for _ in range(segments):
            _, length = struct.unpack_from("<II", data, position)
            position += 8
            if not length or position + length > len(data):
                raise ValueError("Stock segment exceeds image bounds")
            for value in data[position:position + length]:
                checksum ^= value
            position += length
        checksumOffset = position | 15
        if (data[position:checksumOffset] != bytes(checksumOffset - position)
                or data[checksumOffset] != checksum or checksumOffset + 1 != end):
            raise ValueError("Invalid stock segment checksum or boundary")
    declaredLength, storedCrc = struct.unpack_from("<II", data, 0xff8)
    crc = 0xffffffff
    for index, value in enumerate(data):
        crc ^= (0 if 0xff8 <= index < 0x1000 else value) << 24
        for _ in range(8):
            crc = ((crc << 1) ^ (0x04c11db7 if crc & 0x80000000 else 0)) & 0xffffffff
    if declaredLength != len(data) or storedCrc != crc:
        raise ValueError("Invalid stock legacy length/CRC")
    return {"bytes": len(data), "sha256": expectedHash, "legacyCrc": hex(crc)}


def main():
    repository = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("stockImage", type=Path)
    parser.add_argument("--candidate-image", type=Path,
                        help="Optional combined image to check against the pinned stock Updater header gate")
    parser.add_argument("--framework", type=Path, default=Path.home() / ".platformio/packages/framework-arduinoespressif8266")
    parser.add_argument("--current-sketch-bytes", type=int, default=362960,
                        help="Hypothetical running length for provisional 4m3m geometry only")
    args = parser.parse_args()
    if not 0 < args.current_sketch_bytes <= 0xff000:
        parser.error("Current sketch length must be 1 to 1044480 bytes for hypothetical 4m3m geometry")
    result = inspectStock(args.stockImage.read_bytes())
    if json.loads((args.framework / "package.json").read_text())["version"] != "3.30102.0":
        raise ValueError("This probe requires the pinned Arduino ESP8266 3.1.2 package")
    updater = (args.framework / "cores/esp8266/Updater.cpp").read_text()
    source = r'''
#include <cstdint>
#include <cstdio>
#include <fstream>
#include <vector>
#include <cstring>
#include "neonbyte/firmware_image.h"
#include "neonbyte/ota_staging.h"
using std::uint8_t;
using std::uint32_t;
#define FLASH_MAP_SUPPORT 0
constexpr int U_FLASH=0, U_FS=100, UPDATE_ERROR_READ=1, UPDATE_ERROR_MAGIC_BYTE=2, UPDATE_ERROR_NEW_FLASH_CONFIG=3;
std::vector<uint8_t> bytes;
struct FakeEsp {
    bool flashRead(uint32_t offset, uint32_t* out, uint32_t size) {
        if (offset>bytes.size() || size>bytes.size()-offset) return false;
        std::memcpy(out,bytes.data()+offset,size); return true;
    }
    uint32_t magicFlashChipSize(unsigned nibble) { return nibble == 4 ? 0x400000 : 0; }
    uint32_t getFlashChipRealSize() { return 0x400000; }
} ESP;
struct UpdaterClass {
    int _command=U_FLASH;
    uint32_t _startAddress=0, _currentAddress=0;
    void _setError(int) {}
    bool _verifyEnd();
};
struct Source : neonbyte::ImageSource {
    uint32_t size() const override { return bytes.size(); }
    bool readAt(uint32_t offset,uint8_t* out,std::size_t length) const override {
        if (offset>bytes.size() || length>bytes.size()-offset) return false;
        std::memcpy(out,bytes.data()+offset,length); return true;
    }
};
''' + extractFunction(updater, "bool UpdaterClass::_verifyEnd()") + r'''
int main(int argc, char** argv) {
    if (argc < 3 || argc > 4) return 2;
    std::ifstream input(argv[1],std::ios::binary);
    bytes.assign(std::istreambuf_iterator<char>(input),{});
    const auto current = static_cast<uint32_t>(std::stoul(argv[2]));
    const auto rounded = (current+4095U)&~4095U;
    if (!current || rounded>=0x100000) return 2;
    UpdaterClass updater;
    Source image;
    neonbyte::OtaStageBounds bounds{};
    const neonbyte::OtaGeometry geometry{true,0x400000,current,0x100000-rounded,0x100000,0x3fa000,0x3fb000,2};
    const bool fits = neonbyte::calculateOtaStageBounds(image.size(),geometry,bounds);
    const bool coreAccepts = updater._verifyEnd();
    const bool structure = neonbyte::validateEsp8266Image(image);
    const bool modernCrc = neonbyte::validateArduinoImageCrc(image);
    std::printf("{\"coreHeaderAccepts\":%s,\"modernStructureAccepts\":%s,\"modernCrcAccepts\":%s,"
                "\"fitsHypothetical4m3m\":%s,\"stagingStart\":%u,\"stagingEnd\":%u}\n",
                coreAccepts?"true":"false",structure?"true":"false",modernCrc?"true":"false",
                fits?"true":"false",bounds.start,bounds.end);
    const bool stockRestorationAccepted = coreAccepts && !structure && !modernCrc && fits;
    if (argc == 4) {
        std::ifstream candidateInput(argv[3],std::ios::binary);
        std::vector<uint8_t> candidateBytes(std::istreambuf_iterator<char>(candidateInput),{});
        if (candidateBytes.empty()) return 2;
        bytes = std::move(candidateBytes);
        UpdaterClass candidateUpdater;
        Source candidate;
        const bool candidateHeaderAccepted = candidateUpdater._verifyEnd();
        const bool candidateStructure = neonbyte::validateEsp8266Image(candidate);
        const bool candidateCrc = neonbyte::validateArduinoImageCrc(candidate);
        const bool candidateFitsLegacyEnvelope = candidate.size() <= 0xff000U;
        std::printf("{\"manualInstallCandidate\":{\"bytes\":%u,\"stockUpdaterHeaderAccepts\":%s,"
                    "\"modernStructureAccepts\":%s,\"modernCrcAccepts\":%s,\"fitsLegacyEnvelope\":%s}}\n",
                    candidate.size(),candidateHeaderAccepted?"true":"false",candidateStructure?"true":"false",
                    candidateCrc?"true":"false",candidateFitsLegacyEnvelope?"true":"false");
        return stockRestorationAccepted && candidateHeaderAccepted && candidateStructure && candidateCrc && candidateFitsLegacyEnvelope ? 0 : 1;
    }
    return stockRestorationAccepted ? 0 : 1;
}
'''
    with tempfile.TemporaryDirectory(prefix="neonbyte-stock-restore-probe-") as directory:
        code, binary = Path(directory) / "probe.cpp", Path(directory) / "probe"
        code.write_text(source, encoding="utf-8")
        sanitizerFlags = (["-fsanitize=address,undefined", "-fno-omit-frame-pointer", "-fno-pie", "-no-pie"]
                          if os.environ.get("NEONBYTE_PROBE_SANITIZERS") == "1" else [])
        subprocess.run([os.environ.get("CXX", "c++"), "-std=c++17", "-Wall", "-Wextra", "-Werror", *sanitizerFlags, "-I" + str(repository / "firmware/include"),
                        str(code), *(str(repository / "firmware/src" / (name + ".cpp"))
                                     for name in ("firmware_image", "ota_staging", "http_headers", "transfer", "stock_restore")),
                        "-o", str(binary)], check=True)
        command = [str(binary), str(args.stockImage.resolve()), str(args.current_sketch_bytes)]
        if args.candidate_image:
            command.append(str(args.candidate_image.resolve()))
        completed = subprocess.run(command,
                                   check=True, capture_output=True, text=True)
        probeLines = completed.stdout.splitlines()
        result["hostProbe"] = json.loads(probeLines[0])
        if args.candidate_image:
            result["manualInstallCandidate"] = json.loads(probeLines[1])["manualInstallCandidate"]
        subprocess.run([os.environ.get("CXX", "c++"), "-std=c++17", "-Wall", "-Wextra", "-Werror", *sanitizerFlags,
                        "-I" + str(repository / "firmware/include"), str(repository / "firmware/scripts/validate_stock_transaction.cpp"),
                        *(str(repository / "firmware/src" / (name + ".cpp"))
                          for name in ("firmware_image", "ota_staging", "http_headers", "transfer", "stock_restore", "hash_job")),
                        "-lcrypto", "-o", str(binary)], check=True)
        subprocess.run([str(binary), str(args.stockImage.resolve())], check=True)
    result["restorationImplementedOffline"] = True
    result["restorationHardwareValidated"] = False
    result["installationApproved"] = False
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
