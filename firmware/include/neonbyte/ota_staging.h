#pragma once

#include "neonbyte/firmware_image.h"
#include "neonbyte/hash_job.h"
#include "neonbyte/http_headers.h"
#include "neonbyte/transfer.h"
#include <array>
#include <cstddef>
#include <cstdint>
#include <string_view>

namespace neonbyte {

constexpr std::uint32_t OTA_FLASH_BYTES = 4 * 1024 * 1024;
constexpr std::uint32_t OTA_SECTOR_BYTES = 4096;

struct OtaGeometry {
    bool flashConfigMatches = false;
    std::uint32_t physicalFlashBytes = 0;
    std::uint32_t currentSketchBytes = 0;
    std::uint32_t freeSketchBytes = 0;
    std::uint32_t filesystemStartOffset = 0;
    std::uint32_t filesystemEndOffset = 0;
    std::uint32_t eepromStartOffset = 0;
    std::uint8_t currentFlashMode = 0;
};

struct OtaStageBounds {
    std::uint32_t start = 0;
    std::uint32_t end = 0;
    std::uint32_t length = 0;
    std::uint32_t roundedLength = 0;
};

bool calculateOtaStageBounds(std::uint32_t length, const OtaGeometry& geometry, OtaStageBounds& bounds);
bool isMaintenanceFirmwarePath(std::string_view path);
bool maintenanceOtaBodyHasNoExtraBytes(std::uint32_t received, std::uint32_t expected, std::size_t extraBytes);

template <typename SelectStorage>
bool prepareUploadStorage(std::string_view path, SelectStorage&& selectStorage) {
    return isMaintenanceFirmwarePath(path) || selectStorage();
}

Transfer& selectUploadTransfer(std::string_view path, Transfer& storageTransfer, Transfer& maintenanceTransfer);

enum class OtaAdmissionError {
    none,
    unauthorized,
    applicationRunning,
    disabled,
    method,
    mediaType,
    tooLarge,
    invalidBody
};

OtaAdmissionError maintenanceOtaAdmission(bool authorized, bool applicationPaused, bool otaEnabled,
                                          HttpMethod method, std::string_view contentType,
                                          std::uint32_t contentLength, std::string_view sha256);

enum class OtaTransactionState { idle, receiving, verifying, activated, failedInactive };
bool maintenanceOtaRestartAllowed(OtaTransactionState state);

class OtaCandidateVerifier {
public:
    virtual ~OtaCandidateVerifier() = default;
    virtual bool verifyForActivation() = 0;
};

class OtaFlashBackend {
public:
    virtual ~OtaFlashBackend() = default;
    virtual bool geometry(OtaGeometry& geometry) = 0;
    virtual bool begin(std::uint32_t length, const OtaStageBounds& bounds) = 0;
    virtual bool write(const std::uint8_t* bytes, std::size_t length) = 0;
    virtual bool readAt(std::uint32_t offset, std::uint8_t* destination, std::size_t length) = 0;
    // The backend must invoke the verifier before any activation command can be written.
    virtual bool finalize(OtaCandidateVerifier& verifier) = 0;
    virtual void abort(OtaCandidateVerifier& verifier) = 0;
};

class MaintenanceOtaTransaction final : public TransferSink, public ImageSource, public OtaCandidateVerifier {
public:
    MaintenanceOtaTransaction(OtaFlashBackend& backend, ContentDigest& digest) : backend_(backend), digest_(digest) {}

    bool setExpectedHash(std::string_view hash);
    bool begin(std::uint32_t length) override;
    bool write(const std::uint8_t* bytes, std::size_t length) override;
    bool commit() override;
    void abort() override;
    std::uint32_t size() const override { return length_; }
    bool readAt(std::uint32_t offset, std::uint8_t* destination, std::size_t length) const override;
    bool verifyForActivation() override;
    std::uint32_t received() const { return received_; }
    OtaTransactionState state() const { return state_; }

private:
    bool validateHeader();
    bool failInactive(bool cleanup);

    OtaFlashBackend& backend_;
    ContentDigest& digest_;
    OtaGeometry geometry_{};
    OtaStageBounds bounds_{};
    std::array<std::uint8_t,4> header_{};
    std::array<char,64> expectedHash_{};
    std::uint32_t length_ = 0;
    std::uint32_t received_ = 0;
    std::size_t headerReceived_ = 0;
    OtaTransactionState state_ = OtaTransactionState::idle;
    bool updaterStarted_ = false;
    bool activationRequested_ = false;
    bool expectedHashSet_ = false;
};

} // namespace neonbyte
