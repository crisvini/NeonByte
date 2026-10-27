#ifdef ARDUINO_ARCH_ESP8266

#include "neonbyte/esp8266/ota_staging.h"
#include <Esp.h>
#include <flash_hal.h>
#include <algorithm>

namespace neonbyte {
namespace {
constexpr std::uint32_t FLASH_BASE = 0x40200000;
}

Esp8266OtaBackend::Esp8266OtaBackend() : verifier_(*this) {}

const unsigned char* Esp8266OtaBackend::Hash::oid() {
    static constexpr unsigned char SHA256_OID[] = {0x60,0x86,0x48,0x01,0x65,0x03,0x04,0x02,0x01};
    return SHA256_OID;
}

bool Esp8266OtaBackend::Verifier::verify(UpdaterHashClass*, const void*, std::uint32_t signatureLength) {
    return signatureLength == 0 && backend_.candidateVerifier_ && backend_.candidateVerifier_->verifyForActivation();
}

bool Esp8266OtaBackend::geometry(OtaGeometry& value) {
    const auto filesystemAddress = static_cast<std::uint32_t>(FS_start);
    const auto filesystemEndAddress = static_cast<std::uint32_t>(FS_end);
    const auto eepromAddress = static_cast<std::uint32_t>(EEPROM_start);
    if (filesystemAddress < FLASH_BASE || filesystemEndAddress < FLASH_BASE || eepromAddress < FLASH_BASE) return false;
    value = {
        ESP.checkFlashConfig(false),
        ESP.getFlashChipRealSize(),
        ESP.getSketchSize(),
        ESP.getFreeSketchSpace(),
        filesystemAddress-FLASH_BASE,
        filesystemEndAddress-FLASH_BASE,
        eepromAddress-FLASH_BASE,
        static_cast<std::uint8_t>(ESP.getFlashChipMode())
    };
    return true;
}

bool Esp8266OtaBackend::begin(std::uint32_t length, const OtaStageBounds& bounds) {
    if (active_ || bounds.length != length) return false;
#if defined(ARDUINO_SIGNING)
    // The pinned updater has no getter for its existing signing hook; preserve it and keep this path closed.
    return false;
#else
    OtaGeometry current{};
    OtaStageBounds checked{};
    if (!geometry(current) || !calculateOtaStageBounds(length,current,checked) ||
        checked.start != bounds.start || checked.end != bounds.end || checked.roundedLength != bounds.roundedLength) return false;

    bounds_ = bounds;
    written_ = 0;
    candidateVerifier_ = nullptr;
    Update.installSignature(&hash_,&verifier_);
    if (!Update.begin(length,U_FLASH)) {
        clearVerifier();
        return false;
    }
    active_ = true;
    return true;
#endif
}

bool Esp8266OtaBackend::write(const std::uint8_t* bytes, std::size_t length) {
    if (!active_ || !bytes || !length || length > bounds_.length-written_) return false;
    if (Update.write(const_cast<std::uint8_t*>(bytes),length) != length) return false;
    written_ += static_cast<std::uint32_t>(length);
    return true;
}

bool Esp8266OtaBackend::readAt(std::uint32_t offset, std::uint8_t* destination, std::size_t length) {
    // Full-image verification makes many bounded reads without returning to loop().
    optimistic_yield(1000);
    return active_ && destination && offset <= bounds_.length && length <= bounds_.length-offset &&
        ESP.flashRead(bounds_.start+offset,destination,length);
}

bool Esp8266OtaBackend::finalize(OtaCandidateVerifier& verifier) {
    if (!active_) return false;
    candidateVerifier_ = &verifier;
    const bool finalized = Update.end(false);
    active_ = false;
    clearVerifier();
    return finalized;
}

void Esp8266OtaBackend::abort(OtaCandidateVerifier& verifier) {
    if (!active_) return;
    candidateVerifier_ = &verifier;
    Update.end(false);
    active_ = false;
    clearVerifier();
}

void Esp8266OtaBackend::clearVerifier() {
#if !defined(ARDUINO_SIGNING)
    Update.installSignature(nullptr,nullptr);
#endif
    candidateVerifier_ = nullptr;
    written_ = 0;
}

} // namespace neonbyte

#endif
