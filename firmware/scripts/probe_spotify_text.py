#!/usr/bin/env python3
"""Compare Spotify scanlines against the pinned Adafruit GFX classic renderer."""

import argparse
import json
import re
import tempfile
from pathlib import Path

from probe_compatibility import extractFunction, runProbe


def main():
    repository = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--gfx-library",
        type=Path,
        default=repository / "firmware/.pio/libdeps/esp8266-integration-check/Adafruit GFX Library@1.11.11",
    )
    args = parser.parse_args()

    properties = (args.gfx_library / "library.properties").read_text(encoding="utf-8")
    if "version=1.11.11\n" not in properties:
        raise ValueError("This probe requires the firmware's pinned Adafruit GFX 1.11.11")

    fontSource = (args.gfx_library / "glcdfont.c").read_text(encoding="utf-8")
    fontMatch = re.search(r"static const unsigned char font\[\] PROGMEM = \{.*?\};", fontSource, re.S)
    if not fontMatch:
        raise ValueError("Could not locate the pinned classic GFX font table")
    fontDeclaration = fontMatch.group(0)

    gfxSource = (args.gfx_library / "Adafruit_GFX.cpp").read_text(encoding="utf-8")
    signature = "void Adafruit_GFX::drawChar(int16_t x, int16_t y, unsigned char c,\n                            uint16_t color, uint16_t bg, uint8_t size_x,\n                            uint8_t size_y)"
    drawChar = extractFunction(gfxSource, signature)
    customFontBranch = "  } else { // Custom font"
    if customFontBranch not in drawChar:
        raise ValueError("The pinned classic drawChar implementation changed shape")
    drawChar = drawChar.split(customFontBranch, 1)[0] + "  }\n}"

    source = r'''
#include <algorithm>
#include <array>
#include <cassert>
#include <cstdint>
#include <cstdio>
#include <string>
#include <string_view>
#include <vector>
using int8_t = std::int8_t;
using int16_t = std::int16_t;
using uint8_t = std::uint8_t;
using uint16_t = std::uint16_t;
#define PROGMEM
#define pgm_read_byte(address) (*(address))
''' + fontDeclaration + r'''
namespace neonbyte {
bool composeSpotifyTextRow(std::string_view text, std::uint16_t offset, std::uint8_t row,
                           std::uint16_t color, std::uint8_t* output,
                           std::size_t outputCapacity);
}
#include "''' + str(repository / "firmware/src/spotify_text.cpp") + r'''"
#define pgm_read_byte(address) (*(address))

class Adafruit_GFX {
public:
    int16_t _width = 240, _height = 20;
    bool _cp437 = true;
    void* gfxFont = nullptr;
    std::array<uint16_t, 240 * 20> pixels{};
    void startWrite() {}
    void endWrite() {}
    void writePixel(int16_t x, int16_t y, uint16_t color) {
        if (x >= 0 && x < _width && y >= 0 && y < _height) pixels[y * 240 + x] = color;
    }
    void writeFillRect(int16_t x, int16_t y, int16_t width, int16_t height, uint16_t color) {
        for (int16_t row = 0; row < height; ++row)
            for (int16_t column = 0; column < width; ++column)
                writePixel(x + column, y + row, color);
    }
    void writeFastVLine(int16_t x, int16_t y, int16_t height, uint16_t color) {
        for (int16_t row = 0; row < height; ++row) writePixel(x, y + row, color);
    }
    void drawChar(int16_t x, int16_t y, unsigned char c, uint16_t color, uint16_t bg,
                  uint8_t size_x, uint8_t size_y);
};
''' + drawChar + r'''

int main() {
    std::string text;
    for (unsigned char c = 32; c <= 126; ++c) text.push_back(static_cast<char>(c));
    const uint16_t colors[] = {0xffff, 0x9cf3};
    const uint16_t offsets[] = {0, 1, 2, 7, 8, 9, 11, 12, 13, 67, 68};
    std::array<uint8_t, neonbyte::SPOTIFY_TEXT_ROW_BYTES> actual{};
    Adafruit_GFX reference;
    unsigned rowsChecked = 0;
    for (const auto color : colors) for (const auto offset : offsets) {
        reference.pixels.fill(0);
        const int16_t firstX = static_cast<int16_t>(8 - offset);
        for (std::size_t index = 0; index < text.size(); ++index)
            reference.drawChar(static_cast<int16_t>(firstX + index * 12), 0,
                               static_cast<unsigned char>(text[index]), color, 0, 2, 2);
        for (uint8_t row = 0; row < 20; ++row) {
            assert(neonbyte::composeSpotifyTextRow(text, offset, row, color,
                                                   actual.data(), actual.size()));
            for (unsigned x = 0; x < 240; ++x) {
                const auto pixel = static_cast<uint16_t>(actual[x * 2]) |
                    static_cast<uint16_t>(static_cast<uint16_t>(actual[x * 2 + 1]) << 8);
                assert(pixel == reference.pixels[row * 240 + x]);
            }
            ++rowsChecked;
        }
    }
    std::printf("{\"gfxVersion\":\"1.11.11\",\"glyphsCompared\":95,"
                "\"offsetsCompared\":11,\"rowsChecked\":%u,\"rgb565Colors\":2}\n", rowsChecked);
}
'''

    with tempfile.TemporaryDirectory(prefix="neonbyte-spotify-text-") as temporary:
        result = runProbe(
            Path(temporary), "spotify-text", source,
            extraFlags=["-I", str(repository / "firmware/include")],
        )
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
