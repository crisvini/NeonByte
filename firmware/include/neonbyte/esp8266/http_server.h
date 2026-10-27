#pragma once
#ifdef ARDUINO_ARCH_ESP8266
#include "neonbyte/esp8266/storage.h"
#include "neonbyte/http_headers.h"
#include "neonbyte/hash_job.h"
#include "neonbyte/esp8266/ota_staging.h"
#include "neonbyte/safe_startup.h"
#include "neonbyte/stock_restore.h"
#include <bearssl/bearssl_hash.h>
#include <ESP8266WiFi.h>
#include <memory>
namespace neonbyte {
class Sha256Digest final : public ContentDigest {
public:
    void reset() override { br_sha256_init(&context_); }
    void update(const std::uint8_t* bytes, std::size_t length) override { br_sha256_update(&context_,bytes,length); }
    void finish(char* hex64) override;
private:
    br_sha256_context context_{};
};
class DeviceHttpServer {
public:
    DeviceHttpServer(PersistentStorage& storage, SafeStartup& startup, RequestAuthenticator& authenticator)
        : storage_(storage), startup_(startup), authenticator_(authenticator), transfer_(storage),
          maintenanceOta_(maintenanceBackend_,digest_), maintenanceTransfer_(maintenanceOta_),
          stockRestoreOta_(maintenanceBackend_,digest_,MaintenanceImageKind::stockV106), stockRestoreTransfer_(stockRestoreOta_) {}
    void setProtocol(ProtocolHandler* protocol) { protocol_ = protocol; }
    bool begin() { server_.begin(); return server_.status() != 0; }
    void tick(std::uint64_t now);

private:
    void headersComplete();
    void bodyComplete();
    void finishBinary();
    void dispatchJson();
    void configureWifi();
    void error(unsigned status, const char* code, const char* message);
    void prepareResponse();
    void close();
    PersistentStorage& storage_;
    SafeStartup& startup_;
    ProtocolHandler* protocol_ = nullptr;
    RequestAuthenticator& authenticator_;
    Transfer transfer_;
    Esp8266OtaBackend maintenanceBackend_{};
    Sha256Digest digest_{};
    MaintenanceOtaTransaction maintenanceOta_;
    Transfer maintenanceTransfer_;
    MaintenanceOtaTransaction stockRestoreOta_;
    Transfer stockRestoreTransfer_;
    MaintenanceOtaTransaction* activeRawOta_ = &maintenanceOta_;
    Transfer* activeTransfer_ = &transfer_;
    WiFiServer server_{80};
    WiFiClient client_;
    HttpHeaders headers_{};
    std::array<char,HTTP_HEADER_LIMIT> headerBytes_{};
    std::unique_ptr<char[]> body_;
    std::array<char,513> controlBody_{};
    char* bodyData() { return body_ ? body_.get() : controlBody_.data(); }
    std::unique_ptr<FileSource> fileHashSource_;
    ImageSource* hashSource_ = nullptr;
    std::unique_ptr<HashJob> hashJob_;
    std::array<std::uint8_t,512> chunk_{};
    HttpResponse response_{};
    std::array<char,192> responseHeaders_{};
    std::size_t headerSize_ = 0, responseHeaderSize_ = 0, sent_ = 0;
    std::uint32_t received_ = 0;
    std::uint64_t started_ = 0, lastActivity_ = 0, restartAt_ = 0;
    bool maintenance_ = false;
    bool maintenanceFirmware_ = false;
    bool stockRestore_ = false;
    bool rebootPending_ = false, finalizing_ = false, readingBody_ = false, sending_ = false, binary_ = false, firmware_ = false;
};
} // namespace neonbyte
#endif
