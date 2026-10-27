#include "neonbyte/ota_staging.h"
#include <algorithm>
#include <limits>

namespace neonbyte {

bool calculateOtaStageBounds(std::uint32_t length, const OtaGeometry& geometry, OtaStageBounds& bounds) {
    if (!length || length > FIRMWARE_BYTES_LIMIT || !geometry.flashConfigMatches ||
        geometry.physicalFlashBytes != OTA_FLASH_BYTES || !geometry.currentSketchBytes || geometry.currentFlashMode != 2) return false;

    const std::uint64_t roundedCurrent =
        (std::uint64_t(geometry.currentSketchBytes) + OTA_SECTOR_BYTES - 1) & ~(std::uint64_t(OTA_SECTOR_BYTES) - 1);
    const std::uint64_t roundedLength =
        (std::uint64_t(length) + OTA_SECTOR_BYTES - 1) & ~(std::uint64_t(OTA_SECTOR_BYTES) - 1);
    if (roundedCurrent > std::numeric_limits<std::uint32_t>::max() ||
        roundedLength > std::numeric_limits<std::uint32_t>::max() ||
        geometry.filesystemStartOffset % OTA_SECTOR_BYTES != 0 ||
        geometry.filesystemEndOffset <= geometry.filesystemStartOffset ||
        geometry.eepromStartOffset < geometry.filesystemEndOffset ||
        geometry.eepromStartOffset != geometry.physicalFlashBytes - 5 * OTA_SECTOR_BYTES ||
        roundedCurrent + geometry.freeSketchBytes != geometry.filesystemStartOffset ||
        geometry.freeSketchBytes <= OTA_SECTOR_BYTES) return false;

    const auto safeAvailable = (geometry.freeSketchBytes - OTA_SECTOR_BYTES) & ~(OTA_SECTOR_BYTES - 1);
    if (roundedLength > safeAvailable || geometry.filesystemStartOffset < roundedLength) return false;
    const auto start = geometry.filesystemStartOffset - static_cast<std::uint32_t>(roundedLength);
    if (start < roundedCurrent || start % OTA_SECTOR_BYTES != 0) return false;

    bounds = {start,geometry.filesystemStartOffset,length,static_cast<std::uint32_t>(roundedLength)};
    return true;
}

bool isMaintenanceFirmwarePath(std::string_view path) {
    return path == "/maintenance/v1/firmware";
}

Transfer& selectUploadTransfer(std::string_view path, Transfer& storageTransfer, Transfer& maintenanceTransfer) {
    return isMaintenanceFirmwarePath(path) ? maintenanceTransfer : storageTransfer;
}

bool maintenanceOtaBodyHasNoExtraBytes(std::uint32_t received, std::uint32_t expected, std::size_t extraBytes) {
    return received == expected && extraBytes == 0;
}

OtaAdmissionError maintenanceOtaAdmission(bool authorized, bool applicationPaused, bool otaEnabled,
                                          HttpMethod method, std::string_view contentType,
                                          std::uint32_t contentLength, std::string_view sha256) {
    if (!authorized) return OtaAdmissionError::unauthorized;
    if (!applicationPaused) return OtaAdmissionError::applicationRunning;
    if (!otaEnabled) return OtaAdmissionError::disabled;
    if (method != HttpMethod::put) return OtaAdmissionError::method;
    if (contentType != "application/octet-stream") return OtaAdmissionError::mediaType;
    if (contentLength > FIRMWARE_BYTES_LIMIT) return OtaAdmissionError::tooLarge;
    if (!contentLength || !isSha256(sha256)) return OtaAdmissionError::invalidBody;
    return OtaAdmissionError::none;
}

bool maintenanceOtaRestartAllowed(OtaTransactionState state) {
    return state == OtaTransactionState::activated;
}

bool MaintenanceOtaTransaction::setExpectedHash(std::string_view hash) {
    if ((state_ != OtaTransactionState::idle && state_ != OtaTransactionState::failedInactive) || !isSha256(hash)) return false;
    std::copy(hash.begin(),hash.end(),expectedHash_.begin());
    expectedHashSet_ = true;
    return true;
}

bool MaintenanceOtaTransaction::begin(std::uint32_t length) {
    if (state_ == OtaTransactionState::receiving || state_ == OtaTransactionState::verifying ||
        state_ == OtaTransactionState::activated || !expectedHashSet_) return false;
    state_ = OtaTransactionState::idle;
    length_ = received_ = 0;
    headerReceived_ = 0;
    updaterStarted_ = activationRequested_ = false;
    header_.fill(0);
    if (!backend_.geometry(geometry_) || !calculateOtaStageBounds(length,geometry_,bounds_)) {
        state_ = OtaTransactionState::failedInactive;
        return false;
    }
    length_ = length;
    state_ = OtaTransactionState::receiving;
    return true;
}

bool MaintenanceOtaTransaction::validateHeader() {
    return header_[0] == 0xe9 && header_[2] == 2 && header_[3] == 0x40 && geometry_.currentFlashMode == 2;
}

bool MaintenanceOtaTransaction::write(const std::uint8_t* bytes, std::size_t length) {
    if (state_ != OtaTransactionState::receiving || !bytes || !length || length > length_ - received_) return failInactive(true);
    std::size_t position = 0;
    while (headerReceived_ < header_.size() && position < length) {
        header_[headerReceived_++] = bytes[position++];
        ++received_;
        if (headerReceived_ == header_.size()) {
            if (!validateHeader() || !backend_.begin(length_,bounds_)) return failInactive(true);
            updaterStarted_ = true;
            if (!backend_.write(header_.data(),header_.size())) return failInactive(true);
        }
    }
    if (position < length) {
        const auto remaining = length-position;
        if (!updaterStarted_ || !backend_.write(bytes+position,remaining)) return failInactive(true);
        received_ += static_cast<std::uint32_t>(remaining);
    }
    return true;
}

bool MaintenanceOtaTransaction::commit() {
    if (state_ != OtaTransactionState::receiving || !updaterStarted_ || received_ != length_) return failInactive(true);
    state_ = OtaTransactionState::verifying;
    activationRequested_ = true;
    if (!backend_.finalize(*this)) {
        updaterStarted_ = false;
        activationRequested_ = false;
        state_ = OtaTransactionState::failedInactive;
        return false;
    }
    updaterStarted_ = false;
    activationRequested_ = false;
    state_ = OtaTransactionState::activated;
    return true;
}

void MaintenanceOtaTransaction::abort() {
    if (state_ == OtaTransactionState::activated || state_ == OtaTransactionState::failedInactive) return;
    failInactive(true);
}

bool MaintenanceOtaTransaction::readAt(std::uint32_t offset, std::uint8_t* destination, std::size_t length) const {
    return updaterStarted_ && received_ == length_ && destination && offset <= length_ &&
        length <= length_-offset && backend_.readAt(offset,destination,length);
}

bool MaintenanceOtaTransaction::verifyForActivation() {
    if (!activationRequested_ || state_ != OtaTransactionState::verifying || !updaterStarted_ ||
        received_ != length_ || !expectedHashSet_) return false;

    digest_.reset();
    std::array<std::uint8_t,256> buffer{};
    for (std::uint32_t offset=0; offset<length_;) {
        const auto count = std::min<std::uint32_t>(buffer.size(),length_-offset);
        if (!readAt(offset,buffer.data(),count)) return false;
        digest_.update(buffer.data(),count);
        offset += count;
    }
    std::array<char,64> actualHash{};
    digest_.finish(actualHash.data());
    if (!std::equal(actualHash.begin(),actualHash.end(),expectedHash_.begin())) return false;
    return validateEsp8266Image(*this) && validateArduinoImageCrc(*this);
}

bool MaintenanceOtaTransaction::failInactive(bool cleanup) {
    activationRequested_ = false;
    state_ = OtaTransactionState::failedInactive;
    if (cleanup && updaterStarted_) {
        backend_.abort(*this);
        updaterStarted_ = false;
    }
    return false;
}

} // namespace neonbyte
