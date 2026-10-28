#pragma once
#ifdef ARDUINO_ARCH_ESP8266
#include "neonbyte/esp8266/storage.h"
#include "neonbyte/http_headers.h"
#include "neonbyte/hash_job.h"
#include "neonbyte/animation_decoder.h"
#include "neonbyte/animation_upload.h"
#include "neonbyte/esp8266/ota_staging.h"
#include "neonbyte/safe_startup.h"
#include "neonbyte/stock_restore.h"
#include <bearssl/bearssl_hash.h>
#include <ESP8266WiFi.h>
#include <memory>
namespace neonbyte {
class StagedAnimationSource final : public AnimationSource {
public:
    explicit StagedAnimationSource(PersistentStorage& storage) : storage_(storage) {}
    std::uint32_t size() const override { return storage_.animationCandidateSize(); }
    bool readAt(std::uint32_t offset, std::uint8_t* bytes, std::size_t length) const override {
        return storage_.readAnimationCandidateAt(offset,bytes,length);
    }
private:
    PersistentStorage& storage_;
};
class Sha256Digest final : public ContentDigest {
public:
    void reset() override { br_sha256_init(&context_); }
    void update(const std::uint8_t* bytes, std::size_t length) override { br_sha256_update(&context_,bytes,length); }
    void finish(char* hex64) override;
private:
    br_sha256_context context_{};
};
struct HttpDiagnostics {
    std::uint32_t connectionsAccepted = 0, connectionsDisconnected = 0, idleTimeouts = 0, totalTimeouts = 0;
    std::uint32_t uploadsStarted = 0, uploadsAborted = 0, uploadsCompleted = 0, uploadFailures = 0;
    std::uint32_t uploadBytes = 0, maxLoopGapMs = 0;
};
class DeviceHttpServer {
public:
    DeviceHttpServer(PersistentStorage& storage, SafeStartup& startup, RequestAuthenticator& authenticator)
        : storage_(storage), candidateSource_(storage), startup_(startup), authenticator_(authenticator),
          transfer_(storage), animationUpload_(storage),
          maintenanceOta_(maintenanceBackend_,digest_), maintenanceTransfer_(maintenanceOta_),
          stockRestoreOta_(maintenanceBackend_,digest_,MaintenanceImageKind::stockV106), stockRestoreTransfer_(stockRestoreOta_),
          validationDecoder_(candidateSource_,validationRow_.data(),validationRow_.size()) {}
    void setBuildIdentity(std::string_view bootId, std::string_view buildId, std::string_view profile,
                          std::string_view recoveryIdentityFingerprint) {
        bootId_ = bootId; buildId_ = buildId; profile_ = profile; recoveryIdentityFingerprint_ = recoveryIdentityFingerprint;
    }
    void setProtocol(ProtocolHandler* protocol) { protocol_ = protocol; }
    bool begin() { server_.begin(); return server_.status() != 0; }
    bool backgroundStartupWorkAllowed() const {
        return !rebootPending_ && !uploadActive_ && !legacyAnimationPromotionPending_ && !animationUpload_.blocksOtherUploads() &&
            !maintenanceOtaBlocksBackgroundWork(maintenanceOta_.state()) &&
            !maintenanceOtaBlocksBackgroundWork(stockRestoreOta_.state());
    }
    void tick(std::uint64_t now);

private:
    enum class AnimationV2Request : std::uint8_t { none, capabilities, begin, chunk, complete, status, cancel, invalid };
    void dispatchAnimationV2();
    void advanceAnimationValidation(std::uint64_t now);
    void finishAnimationChunkRequest(std::uint64_t now);
    void headersComplete();
    void bodyComplete();
    void finishBinary();
    void dispatchJson();
    void configureWifi();
    void error(unsigned status, const char* code, const char* message);
    void prepareResponse();
    void close();
    PersistentStorage& storage_;
    StagedAnimationSource candidateSource_;
    SafeStartup& startup_;
    ProtocolHandler* protocol_ = nullptr;
    RequestAuthenticator& authenticator_;
    Transfer transfer_;
    AnimationUploadSession animationUpload_;
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
    AnimationSource* hashSource_ = nullptr;
    std::unique_ptr<HashJob> hashJob_;
    std::array<std::uint8_t,512> chunk_{};
    std::array<std::uint8_t,480> validationRow_{};
    AnimationDecoder validationDecoder_;
    std::unique_ptr<std::uint8_t[]> animationChunkBody_;
    HttpResponse response_{};
    std::array<char,192> responseHeaders_{};
    std::size_t headerSize_ = 0, responseHeaderSize_ = 0, sent_ = 0;
    std::uint32_t received_ = 0;
    std::uint32_t animationUploadId_ = 0, animationChunkOffset_ = 0;
    std::uint32_t animationUploadIdCounter_ = 0;
    std::uint64_t started_ = 0, lastActivity_ = 0, restartAt_ = 0;
    std::uint64_t requestDeadlineMs_ = 60000;
    std::uint64_t lastTick_ = 0;
    HttpDiagnostics diagnostics_{};
    std::string_view bootId_{}, buildId_{}, profile_{}, recoveryIdentityFingerprint_{};
    bool clientActive_ = false, uploadActive_ = false, lastTickValid_ = false;
    bool maintenance_ = false;
    bool maintenanceFirmware_ = false;
    bool stockRestore_ = false;
    AnimationV2Request animationV2Request_ = AnimationV2Request::none;
    bool animationV2Route_ = false, animationChunkWriting_ = false, animationChunkDetached_ = false;
    bool animationValidationHashDone_ = false, animationValidationOpened_ = false;
    bool legacyAnimationPromotionPending_ = false;
    std::uint32_t legacyAnimationGeneration_ = 0;
    bool rebootPending_ = false, finalizing_ = false, readingBody_ = false, sending_ = false, binary_ = false, firmware_ = false;
};
} // namespace neonbyte
#endif
