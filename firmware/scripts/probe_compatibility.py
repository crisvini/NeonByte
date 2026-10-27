#!/usr/bin/env python3
"""Probe pinned library behavior with host I/O doubles; never access a device."""

import argparse
import json
import os
import subprocess
import tempfile
from pathlib import Path


def extractFunction(source, signature):
    """Extract only the reviewed functions, whose braces have no string literals."""
    if source.count(signature) != 1:
        raise ValueError(f"Expected one definition of {signature}")
    start = source.index(signature)
    opening = source.index("{", start)
    depth = 0
    for index in range(opening, len(source)):
        if source[index] == "{":
            depth += 1
        elif source[index] == "}":
            depth -= 1
            if depth == 0:
                return source[start:index + 1]
    raise ValueError(f"Unterminated definition of {signature}")


def runProbe(directory, name, source):
    sourcePath = directory / f"{name}.cpp"
    binaryPath = directory / name
    sourcePath.write_text(source, encoding="utf-8")
    subprocess.run([os.environ.get("CXX", "c++"), "-std=c++17", "-Wall", "-Wextra",
                    "-Werror", str(sourcePath), "-o", str(binaryPath)], check=True)
    result = subprocess.run([str(binaryPath)], check=True, capture_output=True, text=True)
    return json.loads(result.stdout)


def probeDisplay(directory, repository, library):
    properties = (library / "library.properties").read_text()
    if "version=1.11.0\n" not in properties:
        raise ValueError("This probe requires Adafruit ST7735/ST7789 1.11.0")
    commonSource = (library / "Adafruit_ST77xx.cpp").read_text()
    panelSource = (library / "Adafruit_ST7789.cpp").read_text()
    adapterSource = (repository / "firmware/src/esp8266/display.cpp").read_text()
    header = (library / "Adafruit_ST77xx.h").read_text()
    constants = "\n".join(line for line in header.splitlines() if line.startswith("#define ST77XX_"))
    frequency = next(line for line in commonSource.splitlines() if line.startswith("#define SPI_DEFAULT_FREQ"))
    # Execute the actual method bodies. I/O, command-table transfer, and base
    # fields are doubles; this does not execute the full driver or model a panel.
    source = r'''
#include <cassert>
#include <cstdint>
#include <cstdio>
using std::uint8_t;
using std::uint16_t;
using std::uint32_t;
#define NEONBYTE_ENABLE_DISPLAY 1
constexpr uint8_t SPI_MODE3 = 0x11;
constexpr int DISPLAY_BACKLIGHT = 5, OUTPUT = 1, HIGH = 1, LOW = 0;
void pinMode(int, int) {}
void digitalWrite(int, int) {}
const uint8_t generic_st7789[] = {0};
''' + constants + "\n" + frequency + r'''
class Adafruit_ST77xx {
public:
    uint8_t spiMode = 0, invertOnCommand = 0, invertOffCommand = 0;
    uint8_t _colstart = 0, _rowstart = 0, rotation = 0, madctl = 0;
    uint16_t _xstart = 0, _ystart = 0, _width = 0, _height = 0;
    uint32_t _freq = 0, busFrequency = 0, initializationFrequency = 0;
    void begin(uint32_t freq = 0);
    void commonInit(const uint8_t* commands);
    void initSPI(uint32_t frequency, uint8_t) { busFrequency = frequency; }
    void displayInit(const uint8_t*) { initializationFrequency = busFrequency; }
    void sendCommand(uint8_t command, const uint8_t* data, unsigned) {
        if (command == ST77XX_MADCTL) madctl = *data;
    }
    void setSPISpeed(uint32_t frequency) { busFrequency = frequency; }
    void invertDisplay(bool) {}
    void fillScreen(uint16_t) {}
};
class Adafruit_ST7789 : public Adafruit_ST77xx {
public:
    uint8_t _colstart2 = 0, _rowstart2 = 0;
    uint16_t windowWidth = 0, windowHeight = 0;
    void init(uint16_t width, uint16_t height, uint8_t mode);
    void setRotation(uint8_t m);
};
class DeviceDisplay {
public:
    Adafruit_ST7789 panel_;
    bool initialized_ = false;
    void begin();
};
'''
    for contents, signature in (
        (commonSource, "void Adafruit_ST77xx::begin("),
        (commonSource, "void Adafruit_ST77xx::commonInit("),
        (panelSource, "void Adafruit_ST7789::init("),
        (panelSource, "void Adafruit_ST7789::setRotation("),
        (adapterSource, "void DeviceDisplay::begin("),
    ):
        source += "\n" + extractFunction(contents, signature)
    source += r'''
int main() {
    DeviceDisplay display;
    display.begin();
    assert(display.initialized_);
    assert(display.panel_._width == 240 && display.panel_._height == 240);
    std::printf("{\"initializationRequestedHz\":%u,\"drawingRequestedHz\":%u,"
                "\"madctl\":%u,\"columnOffset\":%u,\"rowOffset\":%u}\n",
                display.panel_.initializationFrequency, display.panel_.busFrequency,
                display.panel_.madctl, display.panel_._xstart, display.panel_._ystart);
}
'''
    return runProbe(directory, "display-probe", source)


def probeAccessPoint(directory, framework):
    metadata = json.loads((framework / "package.json").read_text())
    if metadata["version"] != "3.30102.0":
        raise ValueError("This probe requires the Arduino ESP8266 3.1.2 package")
    apSource = (framework / "libraries/ESP8266WiFi/src/ESP8266WiFiAP.cpp").read_text()
    source = r'''
#include <cassert>
#include <cstdint>
#include <cstdio>
#include <cstring>
#define DEBUG_WIFI(...) ((void)0)
#define ETS_UART_INTR_DISABLE() ((void)0)
#define ETS_UART_INTR_ENABLE() ((void)0)
constexpr int AUTH_WPA2_PSK = 3, AUTH_OPEN = 0, SOFTAP_IF = 1;
struct IPAddress {
    uint32_t value;
    IPAddress(unsigned a, unsigned b, unsigned c, unsigned d)
        : value(a | (b << 8) | (c << 16) | (d << 24)) {}
};
struct softap_config {
    unsigned char ssid[32], password[64];
    unsigned ssid_len, channel, ssid_hidden, max_connection, beacon_interval, authmode;
};
struct ip_info { struct { uint32_t addr; } ip; };
uint32_t currentIp = 0;
unsigned configuredIpCount = 0, persistentWrites = 0;
void wifi_softap_get_config_default(softap_config* config) { *config = {}; }
void wifi_softap_get_config(softap_config* config) { *config = {}; }
bool wifi_softap_set_config(softap_config*) { ++persistentWrites; return true; }
bool wifi_softap_set_config_current(softap_config*) { return true; }
void wifi_softap_dhcps_stop() {}
void wifi_softap_dhcps_start() {}
bool wifi_get_ip_info(int, ip_info* info) { info->ip.addr = currentIp; return true; }
class ESP8266WiFiAPClass {
public:
    bool _persistent = false;
    bool enableAP(bool) { return true; }
    bool softAP(const char* ssid, const char* psk, int channel = 1,
                int ssid_hidden = 0, int max_connection = 4, int beacon_interval = 100);
    bool softAPConfig(IPAddress ip, IPAddress, IPAddress) {
        currentIp = ip.value; ++configuredIpCount; return true;
    }
} WiFi;
'''
    source += extractFunction(apSource, "static bool softap_config_equal(const softap_config& lhs, const softap_config& rhs) {")
    source += "\n" + extractFunction(apSource, "bool ESP8266WiFiAPClass::softAP(const char* ssid,")
    source += r'''
int main() {
    // Public, synthetic test password; no private identity is loaded.
    assert(WiFi.softAP("Probe", "synthetic-password"));
    const bool emptyIpUsesDefault = currentIp == IPAddress(192,168,4,1).value;
    assert(emptyIpUsesDefault && configuredIpCount == 1);
    configuredIpCount = 0;
    currentIp = IPAddress(10,23,45,1).value;
    assert(WiFi.softAP("Probe", "synthetic-password"));
    const bool nonzeroIpPreserved = currentIp == IPAddress(10,23,45,1).value;
    assert(nonzeroIpPreserved && configuredIpCount == 0 && persistentWrites == 0);
    std::puts("{\"emptyIpUsesDefault\":true,\"nonzeroIpPreserved\":true,\"persistentWrites\":0}");
}
'''
    return runProbe(directory, "ap-probe", source)


def main():
    repository = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--display-library", type=Path, default=repository / "firmware/.pio/libdeps/esp8266-integration-check/Adafruit ST7735 and ST7789 Library")
    parser.add_argument("--framework", type=Path, default=Path.home() / ".platformio/packages/framework-arduinoespressif8266")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="neonbyte-compatibility-") as temporary:
        directory = Path(temporary)
        result = {
            "evidence": "Extracted function bodies with host I/O doubles; no hardware validation",
            "display": probeDisplay(directory, repository, args.display_library),
            "accessPoint": probeAccessPoint(directory, args.framework),
            "installationApproved": False,
        }
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
