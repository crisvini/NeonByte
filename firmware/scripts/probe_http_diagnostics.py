#!/usr/bin/env python3
"""Test the target maintenance diagnostic response with offline I/O doubles."""
import os
import subprocess
import tempfile
from pathlib import Path

from probe_compatibility import extractFunction


def main():
    repository = Path(__file__).resolve().parents[2]
    adapter = (repository / "firmware/src/esp8266/http_server.cpp").read_text()
    source = r'''
#include "neonbyte/protocol.h"
#include "neonbyte/maintenance_info.h"
#include "neonbyte/ota_staging.h"
#include <array>
#include <cassert>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <string_view>
#define PSTR(value) (value)
unsigned flashFormatCalls = 0;
template <typename... Args>
int flashSnprintf(char* output, std::size_t capacity, const char* format, Args... args) {
    ++flashFormatCalls;
    return std::snprintf(output, capacity, format, args...);
}
#define snprintf_P flashSnprintf
using namespace neonbyte;
struct Diagnostics {
    uint32_t connectionsAccepted=3, connectionsDisconnected=2, idleTimeouts=4, totalTimeouts=5;
    uint32_t uploadsStarted=6, uploadsAborted=7, uploadsCompleted=8, uploadFailures=9, uploadBytes=1234, maxLoopGapMs=123;
};
struct Headers { HttpMethod method=HttpMethod::get; std::string_view path="/maintenance/v1/diagnostics", authorization="Bearer private-fixture-token", contentType; };
struct Startup {
    bool identity=true;
    bool authorized(std::string_view value) { return value == "Bearer private-fixture-token"; }
    bool identityValid() { return identity; }
    bool recoveryApRunning() { return true; }
};
struct ResetInfo { uint32_t reason=4; };
struct ESPClass {
    ResetInfo info; bool resetInfoAvailable=true;
    uint32_t getChipId() { return 0xabcdef; }
    uint32_t getFlashChipRealSize() { return OTA_FLASH_BYTES; }
    bool checkFlashConfig(bool) { return true; }
    uint32_t getFreeSketchSpace() { return 512*1024; }
    uint32_t getFreeHeap() { return 17234; }
    uint32_t getMaxFreeBlockSize() { return 9876; }
    ResetInfo* getResetInfoPtr() { return resetInfoAvailable ? &info : nullptr; }
} ESP;
using String = std::string;
constexpr int WL_CONNECTED=1;
struct IPAddress {
    uint8_t octets[4]{};
    IPAddress() = default;
    IPAddress(uint8_t first,uint8_t second,uint8_t third,uint8_t fourth) : octets{first,second,third,fourth} {}
    uint8_t operator[](std::size_t index) const { return octets[index]; }
    String toString() { return "192.168.1.20"; }
};
struct WiFiClass { int status() { return 0; } IPAddress localIP() { return {}; } IPAddress softAPIP() { return {192,168,4,1}; } } WiFi;
struct Protocol { HttpResponse handle(const HttpRequest&, DeviceInfo) { return {}; } };
void handleMaintenance(const HttpRequest& request,Startup& startup,uint64_t,HttpResponse& response) {
    response={}; response.statusCode=startup.authorized(request.authorization) ? 404 : 401;
}
class DeviceHttpServer {
public:
    std::array<char,513> body_{}; uint32_t received_=0; Headers headers_; Startup startup_; Diagnostics diagnostics_;
    std::string_view bootId_="probe-boot", buildId_="probe-build", profile_="probe-profile";
    std::string recoveryIdentityFingerprint_=std::string(64,'a');
    HttpResponse response_; bool maintenance_=true; uint64_t lastActivity_=0; Protocol protocolStorage_; Protocol* protocol_=&protocolStorage_;
    char* bodyData() { return body_.data(); }
    void error(unsigned status,const char*,const char*) { response_={}; response_.statusCode=status; }
    void prepareResponse() {}
    void configureWifi() { assert(false); }
    void dispatchJson();
};
''' + extractFunction(adapter, "void DeviceHttpServer::dispatchJson()") + r'''
int main() {
    DeviceHttpServer information; information.headers_.path="/maintenance/v1/info"; information.dispatchJson();
    assert(information.response_.statusCode==200);
    assert(information.response_.bodyView().find("\"deviceId\":\"esp8266-abcdef\"")!=std::string_view::npos);
    assert(information.response_.bodyView().find("\"buildId\":\"probe-build\"")!=std::string_view::npos);
    assert(information.response_.bodyView().find("\"profile\":\"probe-profile\"")!=std::string_view::npos);
    assert(information.response_.bodyView().find("private-fixture-token")==std::string_view::npos);
    DeviceHttpServer identityUnavailable; identityUnavailable.headers_.path="/maintenance/v1/info";
    identityUnavailable.startup_.identity=false; identityUnavailable.dispatchJson();
    assert(identityUnavailable.response_.statusCode==200);
    assert(identityUnavailable.response_.bodyView().find("\"otaEnabled\":false")!=std::string_view::npos);
    assert(identityUnavailable.response_.bodyView().find("\"maxFirmwareBytes\":0")!=std::string_view::npos);
    DeviceHttpServer denied; denied.headers_.authorization="Bearer wrong"; denied.dispatchJson();
    assert(denied.response_.statusCode==401);
    DeviceHttpServer server; server.protocol_=nullptr; server.dispatchJson();
    assert(server.response_.statusCode==200);
    assert(flashFormatCalls > 0);
    auto body=server.response_.bodyView();
    assert(body.find("\"freeHeapBytes\":17234")!=std::string_view::npos);
    assert(body.find("\"maxFreeBlockBytes\":9876")!=std::string_view::npos);
    assert(body.find("\"resetReason\":4")!=std::string_view::npos);
    assert(body.find("\"connectionsAccepted\":3")!=std::string_view::npos);
    assert(body.find("\"uploadsAborted\":7")!=std::string_view::npos);
    assert(body.find("\"uploadBytes\":1234")!=std::string_view::npos);
    assert(body.find("\"maxLoopGapMs\":123")!=std::string_view::npos);
    assert(body.find("private-fixture-token")==std::string_view::npos);
    DeviceHttpServer wrongMethod; wrongMethod.headers_.method=HttpMethod::post; wrongMethod.dispatchJson();
    assert(wrongMethod.response_.statusCode==400);
    DeviceHttpServer nonempty; nonempty.received_=1; nonempty.dispatchJson();
    assert(nonempty.response_.statusCode==400);
    DeviceHttpServer maximum;
    maximum.diagnostics_={0xffffffffU,0xffffffffU,0xffffffffU,0xffffffffU,0xffffffffU,
        0xffffffffU,0xffffffffU,0xffffffffU,0xffffffffU,0xffffffffU};
    ESP.resetInfoAvailable=false; maximum.dispatchJson();
    assert(maximum.response_.statusCode==200 && maximum.response_.bodySize < maximum.response_.body.size());
    assert(maximum.response_.bodyView().find("\"resetReason\":4294967295")!=std::string_view::npos);
    assert(maximum.response_.bodyView().find("\"maxLoopGapMs\":4294967295")!=std::string_view::npos);
    assert(maximum.response_.bodyView().find("private-fixture-token")==std::string_view::npos);
    std::puts("Authenticated diagnostics: memory, reset, lifecycle counters and non-disclosure passed.");
}
'''
    sanitizerFlags = (["-fsanitize=address,undefined", "-fno-omit-frame-pointer", "-fno-pie", "-no-pie"]
                      if os.environ.get("NEONBYTE_PROBE_SANITIZERS") == "1" else [])
    with tempfile.TemporaryDirectory(prefix="neonbyte-http-diagnostics-") as directory:
        code, binary = Path(directory) / "probe.cpp", Path(directory) / "probe"
        code.write_text(source, encoding="utf-8")
        subprocess.run([os.environ.get("CXX", "c++"), "-std=c++17", "-Wall", "-Wextra", "-Werror", *sanitizerFlags,
                        "-I" + str(repository / "firmware/include"), "-DNEONBYTE_ENABLE_OTA=1", str(code),
                        str(repository / "firmware/src/maintenance_info.cpp"), "-o", str(binary)], check=True)
        subprocess.run([str(binary)], check=True)


if __name__ == "__main__":
    main()
