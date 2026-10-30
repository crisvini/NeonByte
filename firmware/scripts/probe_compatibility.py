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


def runProbe(directory, name, source, extraFlags=None):
    sourcePath = directory / f"{name}.cpp"
    binaryPath = directory / name
    sourcePath.write_text(source, encoding="utf-8")
    sanitizerFlags = (["-fsanitize=address,undefined", "-fno-omit-frame-pointer", "-fno-pie", "-no-pie"]
                      if os.environ.get("NEONBYTE_PROBE_SANITIZERS") == "1" else [])
    subprocess.run([os.environ.get("CXX", "c++"), "-std=c++17", "-Wall", "-Wextra",
                    "-Werror", *sanitizerFlags, *(extraFlags or []), str(sourcePath),
                    "-o", str(binaryPath)], check=True)
    result = subprocess.run([str(binaryPath)], capture_output=True, text=True, cwd=directory)
    if result.returncode:
        raise RuntimeError(f"{name} failed ({result.returncode}): {result.stderr.strip()}")
    return json.loads(result.stdout)


def probeDisplay(directory, repository, library, adapterSourceOverride=None, expectedMadctl=0x00):
    properties = (library / "library.properties").read_text()
    if "version=1.11.0\n" not in properties:
        raise ValueError("This probe requires Adafruit ST7735/ST7789 1.11.0")
    commonSource = (library / "Adafruit_ST77xx.cpp").read_text()
    panelSource = (library / "Adafruit_ST7789.cpp").read_text()
    adapterSource = adapterSourceOverride
    if adapterSource is None:
        adapterSource = (repository / "firmware/src/esp8266/display.cpp").read_text()
    adapterHeader = (repository / "firmware/include/neonbyte/esp8266/display.h").read_text()
    header = (library / "Adafruit_ST77xx.h").read_text()
    constants = "\n".join(line for line in header.splitlines() if line.startswith("#define ST77XX_"))
    frequency = next(line for line in commonSource.splitlines() if line.startswith("#define SPI_DEFAULT_FREQ"))
    tableStart = panelSource.index("static const uint8_t PROGMEM")
    tableEnd = panelSource.index("// clang-format on", tableStart)
    panelStart = adapterHeader.index("class BoundedDisplayPanel final")
    panelEnd = adapterHeader.index("};", panelStart) + 2
    # Actual command-table and address-window logic, with transport I/O doubled.
    source = r'''
#include <cassert>
#include <cstdint>
#include <cstdio>
#include <vector>
using std::uint8_t;
using std::uint16_t;
using std::uint32_t;
#define NEONBYTE_ENABLE_DISPLAY 1
#define PROGMEM
#define ST_CMD_DELAY 0x80
#define pgm_read_byte(address) (*(address))
void delay(unsigned) {}
constexpr uint8_t SPI_MODE3 = 0x11;
constexpr int DISPLAY_BACKLIGHT = 5, OUTPUT = 1, HIGH = 1, LOW = 0;
void pinMode(int, int) {}
void digitalWrite(int, int) {}
class FakeSPI {
public:
    inline static std::vector<uint8_t> writtenBytes;
    inline static std::vector<uint32_t> writeLengths;
    void writeBytes(const uint8_t* bytes, uint32_t length) {
        writtenBytes.insert(writtenBytes.end(), bytes, bytes + length);
        writeLengths.push_back(length);
    }
};
FakeSPI fakeSPI;
''' + constants + "\n" + frequency + "\n" + panelSource[tableStart:tableEnd] + r'''
class Adafruit_ST77xx {
public:
    uint8_t spiMode = 0, invertOnCommand = 0, invertOffCommand = 0;
    uint8_t _colstart = 0, _rowstart = 0, rotation = 0, madctl = 0;
    uint16_t _xstart = 0, _ystart = 0, _width = 0, _height = 0;
    uint32_t _freq = 0, busFrequency = 0, initializationFrequency = 0;
    std::vector<uint8_t> commands;
    std::vector<uint32_t> frequencies, windowWords;
    virtual void begin(uint32_t freq = 0);
    void commonInit(const uint8_t* commands);
    void setAddrWindow(uint16_t x, uint16_t y, uint16_t w, uint16_t h);
    void initSPI(uint32_t frequency, uint8_t) { busFrequency = frequency; }
    void displayInit(const uint8_t*);
    void sendCommand(uint8_t command, const uint8_t* data, unsigned) {
        commands.push_back(command); frequencies.push_back(busFrequency);
        if (!initializationFrequency) initializationFrequency = busFrequency;
        if (command == ST77XX_MADCTL) madctl = *data;
    }
    void writeCommand(uint8_t command) { commands.push_back(command); }
    void SPI_WRITE32(uint32_t value) { windowWords.push_back(value); }
    void setSPISpeed(uint32_t frequency) { busFrequency = frequency; }
    void invertDisplay(bool) {}
    void fillScreen(uint16_t) {}
protected:
    struct { FakeSPI* _spi = &fakeSPI; } hwspi;
};
class Adafruit_ST7789 : public Adafruit_ST77xx {
public:
    Adafruit_ST7789(int = -1, int = 0, int = 2) {}
    uint8_t _colstart2 = 0, _rowstart2 = 0;
    uint16_t windowWidth = 0, windowHeight = 0;
    void init(uint16_t width, uint16_t height, uint8_t mode);
    void setRotation(uint8_t m);
};
''' + adapterHeader[panelStart:panelEnd] + r'''
class DeviceDisplay {
public:
    BoundedDisplayPanel panel_;
    bool initialized_ = false;
    void begin();
};
'''
    for contents, signature in (
        (commonSource, "void Adafruit_ST77xx::begin("),
        (commonSource, "void Adafruit_ST77xx::commonInit("),
        (commonSource, "void Adafruit_ST77xx::displayInit("),
        (commonSource, "void Adafruit_ST77xx::setAddrWindow("),
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
    alignas(4) const uint8_t pixelBytes[] = {0x12,0x34,0x56,0x78};
    display.panel_.writePixelBytes(pixelBytes, sizeof(pixelBytes));
    assert(FakeSPI::writeLengths == std::vector<uint32_t>({sizeof(pixelBytes)}));
    assert(FakeSPI::writtenBytes == std::vector<uint8_t>(pixelBytes, pixelBytes + sizeof(pixelBytes)));
    assert(display.panel_._width == 240 && display.panel_._height == 240);
    assert(display.panel_.initializationFrequency == 20000000);
    assert(display.panel_.busFrequency == 20000000);
    const std::vector<uint8_t> expected{0x01,0x11,0x3a,0x36,0x2a,0x2b,0x21,0x13,0x29,0x36,0x36,0x36};
    assert(display.panel_.commands == expected);
    for (auto frequency : display.panel_.frequencies) assert(frequency <= 20000000);
    assert(display.panel_.rotation == 2);
    assert(display.panel_.madctl == 0x00 && display.panel_._xstart == 0 && display.panel_._ystart == 0);
    display.panel_.setAddrWindow(0,0,240,240);
    assert(display.panel_.windowWords == std::vector<uint32_t>({0x000000ef,0x000000ef}));
    display.panel_.windowWords.clear();
    display.panel_.setAddrWindow(0,239,240,1);
    assert(display.panel_.windowWords == std::vector<uint32_t>({0x000000ef,0x00ef00ef}));
    display.panel_.windowWords.clear();
    display.panel_.setAddrWindow(32,4,176,176);
    assert(display.panel_.windowWords == std::vector<uint32_t>({0x002000cf,0x000400b3}));
    struct Corner { uint16_t x, y; uint32_t column, row; };
    const Corner corners[] = {{0,0,0x00000000,0x00000000}, {239,0,0x00ef00ef,0x00000000},
                              {0,239,0x00000000,0x00ef00ef}, {239,239,0x00ef00ef,0x00ef00ef}};
    for (const auto& corner : corners) {
        display.panel_.windowWords.clear();
        display.panel_.setAddrWindow(corner.x,corner.y,1,1);
        assert(display.panel_.windowWords == std::vector<uint32_t>({corner.column,corner.row}));
    }
    std::printf("{\"initializationRequestedHz\":%u,\"drawingRequestedHz\":%u,"
                "\"rotation\":%u,\"madctl\":%u,\"columnOffset\":%u,\"rowOffset\":%u}\n",
                display.panel_.initializationFrequency, display.panel_.busFrequency,
                display.panel_.rotation, display.panel_.madctl, display.panel_._xstart, display.panel_._ystart);
}
'''
    source = source.replace(
        "display.panel_.madctl == 0x00",
        f"display.panel_.madctl == 0x{expectedMadctl:02x}",
        1,
    )
    return runProbe(directory, "display-probe", source)


def probeIncorrectMadctlMutations(directory, repository, library, currentTrace):
    adapterSource = (repository / "firmware/src/esp8266/display.cpp").read_text()
    currentSetting = "const std::uint8_t madctl = 0x00;"
    if adapterSource.count(currentSetting) != 1:
        raise ValueError("Expected one current RGB MADCTL color-order setting")
    rejected = []
    previousSettingTrace = None
    for label, wrongSetting in (
        ("legacy-bgr", "const std::uint8_t madctl = 0x08;"),
        ("stale-mirrored-bgr", "const std::uint8_t madctl = 0xc8;"),
    ):
        mutationDirectory = directory / f"{label}-madctl-mutation"
        mutationDirectory.mkdir()
        mutatedSource = adapterSource.replace(currentSetting, wrongSetting, 1)
        if label == "legacy-bgr":
            legacyTraceDirectory = directory / "legacy-bgr-trace"
            legacyTraceDirectory.mkdir()
            previousSettingTrace = probeDisplay(
                legacyTraceDirectory, repository, library, mutatedSource, expectedMadctl=0x08
            )
        try:
            probeDisplay(mutationDirectory, repository, library, mutatedSource)
        except RuntimeError as error:
            if "display.panel_.madctl == 0x00" not in str(error):
                raise
            rejected.append(label)
        else:
            raise AssertionError(f"The incorrect MADCTL {wrongSetting} mutation was accepted")
    if len(rejected) != 2:
        raise AssertionError("Expected both incorrect MADCTL mutations to be rejected")
    if previousSettingTrace is None or currentTrace["madctl"] ^ previousSettingTrace["madctl"] != 0x08:
        raise AssertionError("The pre/post MADCTL trace bytes must differ only by bit 0x08")
    unchangedTraceFields = set(currentTrace) - {"madctl"}
    if any(currentTrace[field] != previousSettingTrace.get(field) for field in unchangedTraceFields):
        raise AssertionError("The pre/post MADCTL traces changed another checked display setting")
    return {
        "incorrectValuesRejected": rejected,
        "before": previousSettingTrace["madctl"],
        "after": currentTrace["madctl"],
        "xor": currentTrace["madctl"] ^ previousSettingTrace["madctl"],
        "otherTraceFieldsUnchanged": True,
    }


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
unsigned recordedAuthMode = 0;
bool recordedPassword = false;
void wifi_softap_get_config_default(softap_config* config) { *config = {}; }
void wifi_softap_get_config(softap_config* config) { *config = {}; }
bool wifi_softap_set_config(softap_config*) { ++persistentWrites; return true; }
bool wifi_softap_set_config_current(softap_config* config) {
    recordedAuthMode = config->authmode;
    recordedPassword = std::strcmp(reinterpret_cast<const char*>(config->password),"synthetic-password") == 0;
    return true;
}
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
    assert(recordedAuthMode == AUTH_WPA2_PSK && recordedPassword);
    std::puts("{\"emptyIpUsesDefault\":true,\"nonzeroIpPreserved\":true,\"persistentWrites\":0}");
}
'''
    return runProbe(directory, "ap-probe", source)


def probeAccessPointAdapter(directory, repository):
    adapter = (repository / "firmware/src/esp8266/main.cpp").read_text()
    policy = (repository / "firmware/include/neonbyte/recovery_ap.h").read_text()
    source = r'''
#include <cassert>
#include <cstdint>
#include <cstdio>
#include <string>
#include <string_view>
#include <cstring>
using std::uint32_t;
constexpr int HEX = 16, SOFTAP_IF = 1, AUTH_WPA2_PSK = 3, DHCP_STARTED = 1;
constexpr unsigned WIFI_AP = 2;
class String : public std::string {
public:
    using std::string::string;
    String(unsigned, int) : std::string("123") {}
    String(const std::string& value) : std::string(value) {}
};
struct RecoveryIdentity { std::string_view token, apPassword; };
class IPAddress {
public:
    IPAddress(unsigned a, unsigned b, unsigned c, unsigned d) : value_(a | b<<8 | c<<16 | d<<24) {}
    uint32_t v4() const { return value_; }
private:
    uint32_t value_;
};
struct ip_info { struct { uint32_t addr; } ip, gw, netmask; };
struct softap_config {
    unsigned char ssid[32]{}, password[64]{};
    unsigned ssid_len = 0, authmode = AUTH_WPA2_PSK;
};
softap_config apConfig{};
bool configReadOk = true, dhcpRunning = true, modeEnabled = true;
bool wrongSsid = false, wrongPassword = false, wrongAuth = false;
bool wifi_softap_get_config(softap_config* value) {
    *value = apConfig;
    if (wrongSsid) value->ssid[0] ^= 1;
    if (wrongPassword) value->password[0] ^= 1;
    if (wrongAuth) value->authmode = 0;
    return configReadOk;
}
unsigned wifi_softap_dhcps_status() { return dhcpRunning ? DHCP_STARTED : 0; }
struct FakeEsp { unsigned getChipId() { return 123; } } ESP;
struct FakeWifi {
    bool startOk = true, configOk = true, disabled = false;
    bool disableOk = true, disableRequested = false;
    bool protectedPassword = false, persistence = false;
    ip_info info{{0x012d170a},{0x012d170a},{0x00ffffff}};
    unsigned getMode() { return modeEnabled ? WIFI_AP : 0; }
    bool softAP(const char* name, const char* password) {
        protectedPassword = std::string(password) == "synthetic-password";
        apConfig = {};
        apConfig.ssid_len = std::strlen(name);
        std::memcpy(apConfig.ssid,name,apConfig.ssid_len);
        std::memcpy(apConfig.password,password,std::strlen(password));
        return startOk;
    }
    bool softAPConfig(IPAddress ip, IPAddress gateway, IPAddress mask) {
        if (!configOk) return false;
        info = {{ip.v4()},{gateway.v4()},{mask.v4()}};
        return true;
    }
    bool enableAP(bool enabled) {
        disableRequested = !enabled;
        if (!disableOk) return false;
        disabled = !enabled;
        return true;
    }
} WiFi;
bool readOk = true, corruptAddress = false, corruptGateway = false, corruptMask = false;
bool wifi_get_ip_info(int, ip_info* info) {
    if (!readOk) return false;
    *info = WiFi.info;
    if (corruptAddress) info->ip.addr ^= 1;
    if (corruptGateway) info->gw.addr ^= 1;
    if (corruptMask) info->netmask.addr ^= 1;
    return true;
}
struct StartupServices { virtual bool startRecoveryAp(RecoveryIdentity) = 0; };
''' + policy.replace("#pragma once", "") + r'''
using neonbyte::startCheckedRecoveryAp;
class DeviceStartupServices : public StartupServices {
public:
''' + extractFunction(adapter, "bool startRecoveryAp(RecoveryIdentity identity) override") + r'''
};
int main() {
    const RecoveryIdentity identity{"synthetic-token", "synthetic-password"};
    DeviceStartupServices services;
    assert(services.startRecoveryAp(identity));
    assert(WiFi.protectedPassword && !WiFi.persistence && !WiFi.disabled);
    assert(WiFi.info.ip.addr == IPAddress(192,168,4,1).v4());
    assert(WiFi.info.gw.addr == IPAddress(192,168,4,1).v4());
    assert(WiFi.info.netmask.addr == IPAddress(255,255,255,0).v4());
    for (unsigned failure = 0; failure < 4; ++failure) {
        WiFi = FakeWifi{};
        WiFi.startOk = failure != 0;
        WiFi.configOk = failure != 1;
        readOk = failure != 2;
        corruptGateway = failure == 3;
        assert(!services.startRecoveryAp(identity) && WiFi.disabled);
    }
    corruptGateway = false; readOk = true; corruptMask = true; WiFi = FakeWifi{};
    assert(!services.startRecoveryAp(identity) && WiFi.disabled);
    corruptMask = false; corruptAddress = true; WiFi = FakeWifi{};
    assert(!services.startRecoveryAp(identity) && WiFi.disabled);
    corruptAddress = false; WiFi = FakeWifi{}; WiFi.configOk = false; WiFi.disableOk = false;
    assert(!services.startRecoveryAp(identity) && WiFi.disableRequested && !WiFi.disabled);
    for (unsigned failure = 0; failure < 6; ++failure) {
        WiFi = FakeWifi{};
        configReadOk = failure != 0; dhcpRunning = failure != 1;
        modeEnabled = failure != 2; wrongSsid = failure == 3;
        wrongPassword = failure == 4; wrongAuth = failure == 5;
        assert(!services.startRecoveryAp(identity) && WiFi.disableRequested);
    }
    std::puts("{\"existingAddressReplaced\":true,\"protectedPassword\":true,\"failurePathsChecked\":true,\"securityAndDhcpReadback\":true}");
}
'''
    return runProbe(directory, "ap-adapter-probe", source)


def probeRecoveryAdapters(directory, repository):
    httpHeader = (repository / "firmware/include/neonbyte/esp8266/http_server.h").read_text()
    otaHeader = (repository / "firmware/include/neonbyte/esp8266/ota_staging.h").read_text()
    otaSource = (repository / "firmware/src/esp8266/ota_staging.cpp").read_text()
    source = r'''
#include <cassert>
#include <cstdint>
#include <cstddef>
#include <cstdio>
#include <cstring>
unsigned serviceOpportunities = 0, hashCalls = 0, readCalls = 0;
void yield() { ++serviceOpportunities; }
void optimistic_yield(unsigned) { ++serviceOpportunities; }
void br_sha256_update(int*, const void*, std::size_t) { ++hashCalls; }
struct FakeServer {
    bool canListen = false;
    unsigned begins = 0;
    void begin() { ++begins; }
    unsigned status() { return canListen ? 10 : 0; }
};
class DeviceHttpServer {
public:
    FakeServer server_;
''' + extractFunction(httpHeader, "bool begin()") + r'''
};
struct FakeEsp {
    bool readOk = true;
    bool flashRead(std::uint32_t address, std::uint8_t* out, std::size_t length) {
        assert(address >= 0xa0000 && address + length <= 0xa0400);
        ++readCalls;
        std::memset(out,0x5a,length);
        return readOk;
    }
} ESP;
class Esp8266OtaBackend {
public:
    bool active_ = true;
    struct { std::uint32_t start = 0xa0000, length = 1024; } bounds_;
    bool readAt(std::uint32_t, std::uint8_t*, std::size_t);
};
class Hash {
public:
    int context_ = 0;
''' + extractFunction(otaHeader, "void add(") + r'''
};
''' + extractFunction(otaSource, "bool Esp8266OtaBackend::readAt(") + r'''
int main() {
    DeviceHttpServer http;
    assert(!http.begin());
    http.server_.canListen = true;
    assert(http.begin());
    // Each bounded raw read and updater hash chunk must service the SDK.
    Esp8266OtaBackend backend;
    std::uint8_t bytes[256];
    for (unsigned offset = 0; offset < 1024; offset += sizeof(bytes)) {
        const auto before = serviceOpportunities;
        assert(backend.readAt(offset,bytes,sizeof(bytes)));
        assert(bytes[0] == 0x5a && serviceOpportunities > before);
    }
    const auto reads = readCalls;
    assert(!backend.readAt(1024,bytes,1));
    backend.active_ = false;
    assert(!backend.readAt(0,bytes,sizeof(bytes)) && readCalls == reads);
    backend.active_ = true; ESP.readOk = false;
    assert(!backend.readAt(0,bytes,sizeof(bytes)));
    Hash hash;
    for (unsigned offset = 0; offset < 1024; offset += 128) {
        const auto before = serviceOpportunities;
        hash.add(bytes,128);
        assert(serviceOpportunities > before);
    }
    assert(hashCalls == 8);
    std::puts("{\"listenerFailureReported\":true,\"rawReadErrorsChecked\":true,\"cooperativeReadbackAndHash\":true}");
}
'''
    # Remove the nested Hash override specifier in the standalone host class.
    source = source.replace(" override", "")
    return runProbe(directory, "recovery-adapters-probe", source)


def main():
    repository = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--display-library", type=Path, default=repository / "firmware/.pio/libdeps/esp8266-integration-check/Adafruit ST7735 and ST7789 Library")
    parser.add_argument("--framework", type=Path, default=Path.home() / ".platformio/packages/framework-arduinoespressif8266")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="neonbyte-compatibility-") as temporary:
        directory = Path(temporary)
        display = probeDisplay(directory, repository, args.display_library)
        result = {
            "evidence": "Extracted function bodies with host I/O doubles; no hardware validation",
            "display": display,
            "madctlMutationTrace": probeIncorrectMadctlMutations(
                directory, repository, args.display_library, display
            ),
            "accessPoint": probeAccessPoint(directory, args.framework),
            "accessPointAdapter": probeAccessPointAdapter(directory, repository),
            "recoveryAdapters": probeRecoveryAdapters(directory, repository),
            "installationApproved": False,
        }
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
