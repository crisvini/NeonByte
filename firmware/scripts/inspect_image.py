#!/usr/bin/env python3
"""Inspect a local ESP8266 image; never opens a network or device connection."""
import argparse
import hashlib
import json
import struct
from pathlib import Path


def inspectImage(path):
    data = Path(path).read_bytes()
    records = []
    for start in (0, 0x1000):
        magic, count, mode, geometry, entry = struct.unpack_from("<BBBBI", data, start)
        if magic != 0xE9 or not 1 <= count <= 16 or (mode, geometry) != (2, 0x40):
            raise ValueError("Expected combined DIO/40 MHz/4 MB ESP8266 E9 images")
        position, checksum = start + 8, 0xEF
        for _ in range(count):
            address, length = struct.unpack_from("<II", data, position)
            position += 8
            if not length or position + length > len(data):
                raise ValueError("Segment exceeds image bounds")
            for index, value in enumerate(data[position:position + length], position):
                if not (address == 0x40201010 and 0x1010 <= index < 0x1018):
                    checksum ^= value
            position += length
        checksumOffset = position | 15
        if data[position:checksumOffset] != bytes(checksumOffset - position) or data[checksumOffset] != checksum:
            raise ValueError("Invalid image padding or segment checksum")
        records.append({"offset": start, "segments": count, "entry": hex(entry), "end": checksumOffset + 1})
    if records[0]["end"] > 0x1000 or records[1]["end"] != len(data):
        raise ValueError("Unexpected image boundary or appended trailer")
    length, storedCrc = struct.unpack_from("<II", data, 0x1010)
    crc = 0xFFFFFFFF
    for index, value in enumerate(data):
        crc ^= (0 if 0x1010 <= index < 0x1018 else value) << 24
        for _ in range(8):
            crc = ((crc << 1) ^ (0x04C11DB7 if crc & 0x80000000 else 0)) & 0xFFFFFFFF
    if length != len(data) or storedCrc != crc:
        raise ValueError("Invalid Arduino 3.x length/CRC")
    return {"bytes": len(data), "stockGuardHeadroomBytes": 524288 - len(data),
            "sha256": hashlib.sha256(data).hexdigest(), "crc": hex(crc), "images": records,
            "installationApproved": False}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image")
    args = parser.parse_args()
    print(json.dumps(inspectImage(args.image), indent=2))
