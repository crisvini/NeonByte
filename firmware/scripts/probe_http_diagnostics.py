#!/usr/bin/env python3
"""Test the target maintenance diagnostic response with offline I/O doubles."""
import os
import subprocess
import tempfile
from pathlib import Path

from probe_compatibility import extractFunction


def extractDiagnosticHeaders(adapter):
    """Keep real maintenance admission and framing; exclude unrelated upload work."""
    function = extractFunction(adapter, "void DeviceHttpServer::headersComplete()")
    upload_start = function.index("    if (maintenanceFirmware_) {")
    authentication = function.index("} else if (maintenance_ ?", upload_start)
    function = function[:upload_start] + "    if (" + function[authentication + len("} else if ("):]
    animation_start = function.index("    if (animationV2Route_) {")
    query_start = function.index("    if (!headers_.query.empty())", animation_start)
    function = function[:animation_start] + function[query_start:]
    binary_start = function.index("    binary_ =")
    json_start = function.index("        const auto limit = maintenance_", binary_start)
    json_end = function.index("\n    }\n    readingBody_", json_start)
    return function[:binary_start] + function[json_start:json_end] + function[json_end + len("\n    }"):]


def main():
    repository = Path(__file__).resolve().parents[2]
    adapter = (repository / "firmware/src/esp8266/http_server.cpp").read_text()
    ota = (repository / "firmware/src/ota_staging.cpp").read_text()
    stock = (repository / "firmware/src/stock_restore.cpp").read_text()
    path_functions = "\n".join((
        extractFunction(stock, "bool isStockRestorePath("),
        extractFunction(ota, "bool isMaintenanceFirmwarePath("),
        extractFunction(ota, "bool isRawMaintenanceUploadPath("),
    ))
    source = r'''
#include "neonbyte/protocol.h"
#include "neonbyte/maintenance_info.h"
#include "neonbyte/ota_staging.h"
#include "neonbyte/http_headers.h"
#include <array>
#include <algorithm>
#include <cassert>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <memory>
#include <string>
#include <string_view>
#define PSTR(value) (value)
#define memcmp_P std::memcmp
unsigned flashFormatCalls = 0;
template <typename... Args>
int flashSnprintf(char* output, std::size_t capacity, const char* format, Args... args) {
    ++flashFormatCalls;
    return std::snprintf(output, capacity, format, args...);
}
#define snprintf_P flashSnprintf
using namespace neonbyte;
namespace neonbyte {
''' + path_functions + r'''
}
struct Diagnostics {
    uint32_t connectionsAccepted=3, connectionsDisconnected=2, idleTimeouts=4, totalTimeouts=5;
    uint32_t uploadsStarted=6, uploadsAborted=7, uploadsCompleted=8, uploadFailures=9, uploadBytes=1234, maxLoopGapMs=123;
    uint32_t maxHttpTickMs=17, maxStartupTickMs=1109, maxDisplayTickMs=23, maxBackgroundMs=31;
};
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
    std::unique_ptr<char[]> body_;
    std::array<char,513> controlBody_{};
    std::array<char,HTTP_HEADER_LIMIT> headerBytes_{};
    std::size_t headerSize_=0;
    uint32_t received_=0; HttpHeaders headers_; Startup startup_; Diagnostics diagnostics_;
    BearerTokenAuthenticator authenticator_{"pairing-fixture-token"};
    std::string_view bootId_="probe-boot", buildId_="probe-build", profile_="probe-profile";
    std::string recoveryIdentityFingerprint_=std::string(64,'a');
    HttpResponse response_; bool maintenance_=true; uint64_t lastActivity_=0; Protocol protocolStorage_; Protocol* protocol_=&protocolStorage_;
    bool animationV2Route_=false, stockRestore_=false, maintenanceFirmware_=false, firmware_=false;
    bool readingBody_=false, rejected_=false;
    DeviceHttpServer() {
        headers_.method=HttpMethod::get; headers_.path="/maintenance/v1/diagnostics";
        headers_.authorization="Bearer private-fixture-token";
    }
    char* bodyData() { return body_ ? body_.get() : controlBody_.data(); }
    void error(unsigned status,const char*,const char*) { response_={}; response_.statusCode=status; rejected_=true; }
    void prepareResponse() {}
    void configureWifi() { assert(false); }
    void bodyComplete() { dispatchJson(); }
    void headersComplete();
    void dispatchJson();
    void request(std::string method="GET", std::string path="/maintenance/v1/loop-diagnostics",
                 std::string authorization="Bearer private-fixture-token", std::string body={},
                 std::string extraHeaders={}) {
        std::string wire=method+" "+path+" HTTP/1.1\r\nHost: test\r\n";
        if (!authorization.empty()) wire+="Authorization: "+authorization+"\r\n";
        wire+="Content-Length: "+std::to_string(body.size())+"\r\n"+extraHeaders+"\r\n";
        assert(wire.size()<=headerBytes_.size());
        std::memcpy(headerBytes_.data(),wire.data(),wire.size()); headerSize_=wire.size();
        headersComplete();
        if (rejected_ || body.empty()) return;
        assert(readingBody_ && body.size()<controlBody_.size());
        std::memcpy(bodyData(),body.data(),body.size()); received_=body.size(); bodyComplete();
    }
};
''' + extractDiagnosticHeaders(adapter) + "\n" + extractFunction(adapter, "void DeviceHttpServer::dispatchJson()") + r'''
int main() {
    DeviceHttpServer wireAllowed; wireAllowed.protocol_=nullptr; wireAllowed.request();
    assert(!wireAllowed.rejected_ && wireAllowed.response_.statusCode==200 && !wireAllowed.body_);
    assert(wireAllowed.maintenance_ && !wireAllowed.firmware_ && wireAllowed.readingBody_);
    for (const char* authorization : {"", "Bearer pairing-fixture-token", "Bearer wrong"}) {
        DeviceHttpServer denied; denied.request("GET","/maintenance/v1/loop-diagnostics",authorization);
        assert(denied.rejected_ && denied.response_.statusCode==401 && !denied.body_);
    }
    for (const char* method : {"POST", "PUT", "DELETE"}) {
        DeviceHttpServer denied; denied.request(method);
        assert(denied.rejected_ && denied.response_.statusCode==400);
    }
    for (unsigned length : {1U, 512U, 513U}) {
        DeviceHttpServer denied; denied.request("GET","/maintenance/v1/loop-diagnostics",
            "Bearer private-fixture-token",std::string(length,'x'));
        assert(denied.rejected_ && denied.response_.statusCode==(length>512 ? 413 : 400));
        assert(!denied.body_);
    }
    for (const char* path : {"/maintenance/v1/loop-diagnostic", "/maintenance/v1/loop-diagnostics/",
                            "/maintenance/v1/loop-diagnostics-extra", "/api/v1/loop-diagnostics"}) {
        DeviceHttpServer denied; denied.request("GET",path);
        assert(denied.rejected_ || denied.response_.statusCode>=400);
    }
    DeviceHttpServer query; query.request("GET","/maintenance/v1/loop-diagnostics?reset=1");
    assert(query.rejected_ && query.response_.statusCode==400);
    DeviceHttpServer emptyQuery; emptyQuery.request("GET","/maintenance/v1/loop-diagnostics?");
    assert(emptyQuery.rejected_ && emptyQuery.response_.statusCode==400);
    for (const char* extra : {"Authorization: Bearer wrong\r\n", "Content-Length: 1\r\n",
                              "Transfer-Encoding: chunked\r\n", "Expect: 100-continue\r\n"}) {
        DeviceHttpServer denied; denied.request("GET","/maintenance/v1/loop-diagnostics",
            "Bearer private-fixture-token",{},extra);
        assert(denied.rejected_ && denied.response_.statusCode==400);
    }
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
    // The deployed agent accepts an exact field set on the original route.
    assert(body.find("\"maxHttpTickMs\"")==std::string_view::npos);
    assert(std::count(body.begin(),body.end(),':')==13);
    assert(body.find("private-fixture-token")==std::string_view::npos);
    DeviceHttpServer wrongMethod; wrongMethod.headers_.method=HttpMethod::post; wrongMethod.dispatchJson();
    assert(wrongMethod.response_.statusCode==400);
    DeviceHttpServer nonempty; nonempty.received_=1; nonempty.dispatchJson();
    assert(nonempty.response_.statusCode==400);
    DeviceHttpServer maximum;
    maximum.diagnostics_={0xffffffffU,0xffffffffU,0xffffffffU,0xffffffffU,0xffffffffU,
        0xffffffffU,0xffffffffU,0xffffffffU,0xffffffffU,0xffffffffU,
        0xffffffffU,0xffffffffU,0xffffffffU,0xffffffffU};
    ESP.resetInfoAvailable=false; maximum.dispatchJson();
    assert(maximum.response_.statusCode==200 && maximum.response_.bodySize < maximum.response_.body.size());
    assert(maximum.response_.bodyView().find("\"resetReason\":4294967295")!=std::string_view::npos);
    assert(maximum.response_.bodyView().find("\"maxLoopGapMs\":4294967295")!=std::string_view::npos);
    assert(maximum.response_.bodyView().find("private-fixture-token")==std::string_view::npos);
    DeviceHttpServer loop; loop.headers_.path="/maintenance/v1/loop-diagnostics"; loop.dispatchJson();
    assert(loop.response_.statusCode==200);
    auto timing=loop.response_.bodyView();
    assert(timing.find("\"maxLoopGapMs\":123")!=std::string_view::npos);
    assert(timing.find("\"maxHttpTickMs\":17")!=std::string_view::npos);
    assert(timing.find("\"maxStartupTickMs\":1109")!=std::string_view::npos);
    assert(timing.find("\"maxDisplayTickMs\":23")!=std::string_view::npos);
    assert(timing.find("\"maxBackgroundMs\":31")!=std::string_view::npos);
    assert(std::count(timing.begin(),timing.end(),':')==5);
    assert(timing.find("private-fixture-token")==std::string_view::npos);
    maximum.headers_.path=loop.headers_.path; maximum.dispatchJson();
    assert(maximum.response_.statusCode==200 && maximum.response_.bodySize < maximum.response_.body.size());
    assert(maximum.response_.bodyView().find("\"maxBackgroundMs\":4294967295")!=std::string_view::npos);
    denied.headers_.path=loop.headers_.path; denied.dispatchJson(); assert(denied.response_.statusCode==401);
    wrongMethod.headers_.path=loop.headers_.path; wrongMethod.dispatchJson(); assert(wrongMethod.response_.statusCode==400);
    nonempty.headers_.path=loop.headers_.path; nonempty.dispatchJson(); assert(nonempty.response_.statusCode==400);
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
                        str(repository / "firmware/src/maintenance_info.cpp"),
                        str(repository / "firmware/src/http_headers.cpp"),
                        str(repository / "firmware/src/protocol.cpp"),
                        str(repository / "firmware/src/scene_manager.cpp"), "-o", str(binary)], check=True)
        subprocess.run([str(binary)], check=True)


if __name__ == "__main__":
    main()
