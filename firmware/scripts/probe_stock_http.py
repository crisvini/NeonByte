#!/usr/bin/env python3
"""Run real HTTP upload admission with host storage/network doubles; no sockets."""
import os
import subprocess
import tempfile
from pathlib import Path
from probe_compatibility import extractFunction


def main():
    repository = Path(__file__).resolve().parents[2]
    adapter = (repository / "firmware/src/esp8266/http_server.cpp").read_text()
    source = r'''
#include "neonbyte/stock_restore.h"
#include <algorithm>
#include <array>
#include <cassert>
#include <cstring>
#include <memory>
#include <new>
#include <string>
using namespace neonbyte;
enum class AssetKind { cover, animation, firmware };
struct Sink : TransferSink, ImageSource {
    unsigned begins = 0, hashes = 0, commits = 0, reads = 0;
    std::uint32_t length_ = 0;
    std::uint32_t size() const override { return length_; }
    bool readAt(std::uint32_t offset,std::uint8_t* out,std::size_t length) const override {
        if (offset > length_ || length > length_-offset) return false;
        std::fill_n(out,length,0x5a); return true;
    }
    OtaTransactionState state() { return commits ? OtaTransactionState::activated : OtaTransactionState::receiving; }
    bool setExpectedHash(std::string_view) { ++hashes; return true; }
    bool begin(std::uint32_t length) override { ++begins; length_ = length; return true; }
    bool write(const std::uint8_t*,std::size_t) override { return true; }
    bool commit() override { ++commits; return true; }
    void abort() override {}
};
struct UploadStorage : Sink {
    unsigned selections = 0;
    bool selectAsset(AssetKind,std::string_view) { ++selections; return true; }
    void sealStaged() { assert(false); }
    bool validateStaged() { assert(false); return false; }
    bool applyFirmware() { assert(false); return false; }
};
struct FileSource : ImageSource {
    explicit FileSource(const char*) { assert(false); }
    std::uint32_t size() const override { return 0; }
    bool readAt(std::uint32_t,std::uint8_t*,std::size_t) const override { return false; }
};
struct Digest : ContentDigest {
    std::size_t bytes = 0;
    void reset() override { bytes = 0; }
    void update(const std::uint8_t*,std::size_t length) override { bytes += length; }
    void finish(char* out) override {
        assert(bytes == 488304); std::copy(STOCK_V106_SHA256.begin(),STOCK_V106_SHA256.end(),out);
    }
};
constexpr std::uint32_t COVER_TRACK_BYTES = 1026;
struct Startup {
    bool paused = true;
    bool identity = true;
    bool authorized(std::string_view auth) { return auth == "Bearer recovery-test"; }
    bool identityValid() { return identity; }
    bool applicationPaused() { return paused; }
};
struct Auth { bool isAuthorized(std::string_view auth) { return auth == "Bearer pairing-test"; } };
struct EspRuntime {
    std::uint32_t flashBytes = OTA_FLASH_BYTES;
    bool flashConfigValid = true;
    std::uint32_t getFlashChipRealSize() { return flashBytes; }
    bool checkFlashConfig(bool) { return flashConfigValid; }
};
EspRuntime ESP;
class DeviceHttpServer {
public:
    struct Diagnostics { unsigned uploadsStarted = 0, uploadsCompleted = 0; } diagnostics_;
    UploadStorage storage_; Startup startup_; Auth authenticator_;
    std::string_view buildId_ = "probe-build", profile_ = "probe-profile";
    std::string recoveryIdentityFingerprint_ = std::string(64,'a');
    Sink maintenanceOta_, stockRestoreOta_;
    Transfer transfer_{storage_}, maintenanceTransfer_{maintenanceOta_}, stockRestoreTransfer_{stockRestoreOta_};
    Transfer* activeTransfer_ = &transfer_;
    Sink* activeRawOta_ = &maintenanceOta_;
    void* protocol_ = nullptr;
    HttpHeaders headers_;
    std::array<char,HTTP_HEADER_LIMIT> headerBytes_{};
    std::size_t headerSize_ = 0;
    std::unique_ptr<char[]> body_;
    std::unique_ptr<FileSource> fileHashSource_;
    ImageSource* hashSource_ = nullptr;
    std::unique_ptr<HashJob> hashJob_;
    Digest digest_;
    std::array<std::uint8_t,512> chunk_{};
    HttpResponse response_{};
    struct { int available() { return 0; } } client_;
    std::uint32_t received_ = 0;
    std::uint64_t requestDeadlineMs_ = 60000;
    bool finalizing_ = false, rebootPending_ = false;
    bool maintenance_ = false, firmware_ = false, maintenanceFirmware_ = false, stockRestore_ = false;
    bool binary_ = false, readingBody_ = false, uploadActive_ = false;
    unsigned status = 0;
    void error(unsigned code,const char*,const char*) { status = code; finalizing_ = false; activeTransfer_->abort(); }
    void dispatchJson() { assert(false); }
    void prepareResponse() { status = response_.statusCode; }
    void bodyComplete();
    void finishBinary();
    void headersComplete();
    void request(const std::string& value) {
        assert(value.size() <= headerBytes_.size());
        std::memcpy(headerBytes_.data(),value.data(),value.size()); headerSize_ = value.size(); headersComplete();
    }
};
''' + "\n".join(extractFunction(adapter, signature) for signature in (
        "void DeviceHttpServer::headersComplete()", "void DeviceHttpServer::bodyComplete()", "void DeviceHttpServer::finishBinary()")) + r'''
std::string request(std::string path="/maintenance/v1/stock-firmware",std::string auth="Bearer recovery-test",
    std::string hash=std::string(STOCK_V106_SHA256),unsigned length=488304,std::string extra="") {
    return "PUT "+path+" HTTP/1.1\r\nHost: test\r\nAuthorization: "+auth+
        "\r\nContent-Type: application/octet-stream\r\nContent-Length: "+std::to_string(length)+
        "\r\nX-Content-SHA256: "+hash+"\r\n"+extra+"\r\n";
}
int main() {
    DeviceHttpServer allowed; allowed.request(request());
    if (NEONBYTE_ENABLE_OTA && NEONBYTE_ENABLE_STOCK_RESTORE) {
        assert(allowed.status == 0 && allowed.readingBody_);
        assert(allowed.requestDeadlineMs_ == 60000);
        assert(allowed.activeTransfer_ == &allowed.stockRestoreTransfer_);
        assert(allowed.activeRawOta_ == &allowed.stockRestoreOta_);
        assert(allowed.stockRestoreOta_.begins == 1 && allowed.maintenanceOta_.begins == 0);
        const std::array<std::uint8_t,512> chunk{};
        while (allowed.received_ < 488304) {
            const auto length = std::min<std::uint32_t>(512,488304-allowed.received_);
            assert(allowed.activeTransfer_->append(chunk.data(),length)); allowed.received_ += length;
        }
        allowed.bodyComplete();
        assert(allowed.hashSource_ == &allowed.stockRestoreOta_);
        while (allowed.finalizing_) allowed.finishBinary();
        assert(allowed.status == 204 && allowed.rebootPending_);
        assert(allowed.stockRestoreOta_.commits == 1 && allowed.maintenanceOta_.commits == 0);
        assert(allowed.diagnostics_.uploadsStarted == 1 && allowed.diagnostics_.uploadsCompleted == 1 && !allowed.uploadActive_);
    } else assert(allowed.status == 409 && !allowed.readingBody_);
    assert(allowed.storage_.selections == 0 && allowed.storage_.begins == 0);
    for (unsigned fault=0;fault<5;++fault) {
        DeviceHttpServer denied;
        if (fault == 0) denied.startup_.identity = false;
        if (fault == 1) denied.buildId_ = {};
        if (fault == 2) denied.profile_ = {};
        if (fault == 3) denied.recoveryIdentityFingerprint_.resize(63);
        if (fault == 4) ESP.flashConfigValid = false;
        denied.request(request("/maintenance/v1/firmware"));
        assert(denied.status == 409 && !denied.readingBody_);
        assert(denied.maintenanceOta_.begins == 0 && denied.storage_.begins == 0);
    }
    ESP.flashConfigValid = true;
    DeviceHttpServer wrongFlash;
    ESP.flashBytes = OTA_FLASH_BYTES - 1;
    wrongFlash.request(request("/maintenance/v1/firmware"));
    assert(wrongFlash.status == 409 && !wrongFlash.readingBody_);
    assert(wrongFlash.maintenanceOta_.begins == 0 && wrongFlash.storage_.begins == 0);
    ESP.flashBytes = OTA_FLASH_BYTES;
    for (unsigned fault=0;fault<6;++fault) {
        DeviceHttpServer denied;
        denied.startup_.paused = fault != 1;
        denied.request(request("/maintenance/v1/stock-firmware",fault == 0 ? "Bearer pairing-test" : "Bearer recovery-test",
            fault == 2 ? std::string(64,'a') : std::string(STOCK_V106_SHA256),fault == 3 ? 488303 : 488304,
            fault == 4 ? "Transfer-Encoding: chunked\r\n" : fault == 5 ? "Expect: 100-continue\r\n" : ""));
        assert(denied.status >= 400 && !denied.readingBody_);
        assert(denied.stockRestoreOta_.begins == 0 && denied.maintenanceOta_.begins == 0);
        assert(denied.storage_.begins == 0 && denied.storage_.selections == 0);
    }
    DeviceHttpServer modern; modern.request(request("/maintenance/v1/firmware"));
    if (NEONBYTE_ENABLE_OTA) {
        assert(modern.status == 0 && modern.activeRawOta_ == &modern.maintenanceOta_);
        assert(modern.maintenanceOta_.begins == 1 && modern.stockRestoreOta_.begins == 0);
    } else assert(modern.status == 409);
    DeviceHttpServer application;
    application.protocol_ = &application;
    application.request(request("/api/v1/firmware","Bearer pairing-test"));
    if (NEONBYTE_ENABLE_OTA) {
        assert(application.activeTransfer_ == &application.transfer_ && application.storage_.selections == 1);
        assert(application.requestDeadlineMs_ == 60000);
        assert(application.stockRestoreOta_.begins == 0 && application.maintenanceOta_.begins == 0);
    } else assert(application.status == 409);
    DeviceHttpServer animation;
    animation.protocol_ = &animation;
    animation.request(request("/api/v1/animation","Bearer pairing-test",std::string(64,'a'),2304051));
    assert(animation.status == 0 && animation.readingBody_ && animation.requestDeadlineMs_ == 342000);
    DeviceHttpServer cover;
    cover.protocol_ = &cover;
    cover.request(request("/api/v1/cover","Bearer pairing-test",std::string(64,'a'),COVER_BYTES,
        "X-Track-Id: track\r\n"));
    assert(cover.status == 0 && cover.readingBody_ && cover.requestDeadlineMs_ == 75000);
}
'''
    sanitizerFlags = (["-fsanitize=address,undefined", "-fno-omit-frame-pointer", "-fno-pie", "-no-pie"]
                      if os.environ.get("NEONBYTE_PROBE_SANITIZERS") == "1" else [])
    with tempfile.TemporaryDirectory(prefix="neonbyte-stock-http-") as directory:
        code, binary = Path(directory) / "probe.cpp", Path(directory) / "probe"
        code.write_text(source, encoding="utf-8")
        for otaEnabled, restoreEnabled in ((0, 0), (0, 1), (1, 0), (1, 1)):
            subprocess.run([os.environ.get("CXX", "c++"), "-std=c++17", "-Wall", "-Wextra", "-Werror", *sanitizerFlags,
                            "-I" + str(repository / "firmware/include"), f"-DNEONBYTE_ENABLE_OTA={otaEnabled}",
                            f"-DNEONBYTE_ENABLE_STOCK_RESTORE={restoreEnabled}", str(code),
                            *(str(repository / "firmware/src" / (name + ".cpp"))
                              for name in ("stock_restore", "firmware_image", "ota_staging", "transfer", "http_headers", "hash_job")),
                            "-o", str(binary)], check=True)
            subprocess.run([str(binary)], check=True)
    print("Stock HTTP adapter: authentication, both gates, raw routing, body readback, finalization/restart selection and modern route isolation passed; no device access.")


if __name__ == "__main__":
    main()
