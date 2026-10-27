#!/usr/bin/env python3
"""Trace pinned RGB565 transport with fake SPI registers; never contact hardware."""

import argparse
import json
import tempfile
from pathlib import Path

from probe_compatibility import extractFunction, runProbe


def main():
    repository = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--gfx-library", type=Path, default=repository / "firmware/.pio/libdeps/esp8266-integration-check/Adafruit GFX Library")
    parser.add_argument("--framework", type=Path, default=Path.home() / ".platformio/packages/framework-arduinoespressif8266")
    args = parser.parse_args()
    properties = (args.gfx_library / "library.properties").read_text()
    gfxVersion = next(line.split("=", 1)[1] for line in properties.splitlines() if line.startswith("version="))
    if gfxVersion not in {"1.11.11", "1.13.0"}:
        raise ValueError("This probe requires reviewed Adafruit GFX 1.11.11 or 1.13.0")
    if '"version": "3.30102.0"' not in (args.framework / "package.json").read_text():
        raise ValueError("This probe requires Arduino ESP8266 3.1.2")
    gfx = (args.gfx_library / "Adafruit_SPITFT.cpp").read_text()
    spi = (args.framework / "libraries/SPI/SPI.cpp").read_text()
    assert "SPISettings(freq, MSBFIRST, spiMode)" in gfx
    source = r'''
#include <cassert>
#include <cstdint>
#include <cstdio>
using std::uint8_t;
using std::uint16_t;
using std::uint32_t;
#define ESP8266 1
// Register values and hardware completion are doubles; byte packing is real code.
constexpr uint32_t SPICWBO = 1, SPICRBO = 2, SPIBUSY = 0;
uint32_t SPI1C = 0, SPI1CMD = 0, SPI1W0 = 0;
uint8_t dataBits = 0;
class SPIClass {
public:
    void write16(uint16_t data);
    void write16(uint16_t data, bool msb);
    void setDataBits(uint8_t bits) { dataBits = bits; }
};
constexpr int TFT_HARD_SPI = 0, TFT_SOFT_SPI = 1;
void SPI_MOSI_HIGH() {} void SPI_MOSI_LOW() {}
void SPI_SCK_HIGH() {} void SPI_SCK_LOW() {} void TFT_WR_STROBE() {}
class Adafruit_SPITFT {
public:
    int connection = TFT_HARD_SPI;
    struct { SPIClass* _spi; } hwspi;
    void SPI_WRITE16(uint16_t value);
};
'''
    for contents, signature in (
        (spi, "void SPIClass::write16(uint16_t data)"),
        (spi, "void SPIClass::write16(uint16_t data, bool msb)"),
        (gfx, "void Adafruit_SPITFT::SPI_WRITE16(uint16_t w)"),
    ):
        source += "\n" + extractFunction(contents, signature)
    source += r'''
int main() {
    SPIClass spi; Adafruit_SPITFT panel; panel.hwspi._spi = &spi;
    const uint16_t colors[] = {0xf800,0x07e0,0x001f,0xffff,0x0000,0x07ff,0xf81f,0xffe0};
    const uint8_t wire[][2] = {{0xf8,0x00},{0x07,0xe0},{0x00,0x1f},{0xff,0xff},
                              {0x00,0x00},{0x07,0xff},{0xf8,0x1f},{0xff,0xe0}};
    for (unsigned index=0; index<8; ++index) {
        panel.SPI_WRITE16(colors[index]);
        assert(dataBits == 16);
        assert((SPI1W0 & 0xff) == wire[index][0]);
        assert(((SPI1W0 >> 8) & 0xff) == wire[index][1]);
    }
    // A byte-order mutation must produce a different red word on the wire.
    SPI1C = SPICWBO | SPICRBO; panel.SPI_WRITE16(0xf800);
    assert((SPI1W0 & 0xff) == 0 && ((SPI1W0 >> 8) & 0xff) == 0xf8);
    std::puts("{\"colorsChecked\":8,\"spiMsbByteFirst\":true,\"byteOrderMutationDetected\":true,\"physicalColors\":\"PENDING\"}");
}
'''
    with tempfile.TemporaryDirectory(prefix="neonbyte-display-colors-") as temporary:
        result = runProbe(Path(temporary), "display-colors", source)
    result["gfxVersion"] = gfxVersion
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
