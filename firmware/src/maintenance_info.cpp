#include "neonbyte/maintenance_info.h"

#include "neonbyte/http_headers.h"

#include <algorithm>
#include <cstdio>

namespace neonbyte {
namespace {
bool isSafeIdentityValue(std::string_view value, std::size_t maximum, bool mayBeEmpty = false) {
    if ((!mayBeEmpty && value.empty()) || value.size() > maximum) return false;
    for (const unsigned char character : value) {
        const bool alphaNumeric = (character >= 'a' && character <= 'z') ||
            (character >= 'A' && character <= 'Z') || (character >= '0' && character <= '9');
        if (!alphaNumeric && character != '-' && character != '_' && character != '.' && character != ':') return false;
    }
    return true;
}

bool isSafeIpv4(std::string_view value) {
    if (value == "0.0.0.0") return true;
    unsigned octets = 0;
    unsigned octet = 0;
    bool hasDigit = false;
    for (const char character : value) {
        if (character >= '0' && character <= '9') {
            hasDigit = true;
            octet = octet * 10 + static_cast<unsigned>(character - '0');
            if (octet > 255) return false;
        } else if (character == '.') {
            if (!hasDigit || ++octets > 3) return false;
            octet = 0;
            hasDigit = false;
        } else return false;
    }
    return hasDigit && octets == 3;
}

bool isSha256(std::string_view value) {
    if (value.size() != 64) return false;
    for (const char character : value) if (!((character >= '0' && character <= '9') || (character >= 'a' && character <= 'f'))) return false;
    return true;
}

const char* safeData(std::string_view value) { return value.empty() ? "" : value.data(); }
}

bool isValidMaintenanceInfo(const MaintenanceInfo& info) {
    if (!isSafeIdentityValue(info.deviceId, 64) || !isSafeIdentityValue(info.bootId, 64) ||
        !isSafeIdentityValue(info.firmwareVersion, 64) || !isSafeIpv4(info.stationIp) ||
        !isSafeIpv4(info.recoveryApIp) || info.maxFirmwareBytes > FIRMWARE_BYTES_LIMIT) return false;
    if (info.otaEnabled) {
        return isSafeIdentityValue(info.buildId, 96) && isSafeIdentityValue(info.profile, 96) &&
            isSha256(info.recoveryIdentityFingerprint) && info.maxFirmwareBytes > 0;
    }
    return info.maxFirmwareBytes == 0 && isSafeIdentityValue(info.buildId, 96, true) &&
        isSafeIdentityValue(info.profile, 96, true) &&
        (info.recoveryIdentityFingerprint.empty() || isSha256(info.recoveryIdentityFingerprint));
}

std::uint32_t maintenanceFirmwareCapacity(bool enabled, std::uint32_t freeSketchBytes,
                                           std::uint32_t absoluteLimit) {
    if (!enabled || absoluteLimit == 0 || freeSketchBytes <= 4096) return 0;
    const std::uint32_t available = (freeSketchBytes - 4096) & 0xfffff000U;
    return std::min(available, absoluteLimit);
}

bool writeMaintenanceInfoJson(const MaintenanceInfo& info, char* output, std::size_t capacity,
                               std::size_t& written) {
    written = 0;
    if (!output || capacity == 0 || !isValidMaintenanceInfo(info)) return false;
    const int count = std::snprintf(output, capacity,
        "{\"deviceId\":\"%.*s\",\"bootId\":\"%.*s\",\"buildId\":\"%.*s\","
        "\"firmwareVersion\":\"%.*s\",\"stationIp\":\"%.*s\",\"recoveryApIp\":\"%.*s\","
        "\"otaEnabled\":%s,\"maxFirmwareBytes\":%lu,\"profile\":\"%.*s\","
        "\"recoveryIdentityFingerprint\":\"%.*s\"}",
        static_cast<int>(info.deviceId.size()), safeData(info.deviceId),
        static_cast<int>(info.bootId.size()), safeData(info.bootId),
        static_cast<int>(info.buildId.size()), safeData(info.buildId),
        static_cast<int>(info.firmwareVersion.size()), safeData(info.firmwareVersion),
        static_cast<int>(info.stationIp.size()), safeData(info.stationIp),
        static_cast<int>(info.recoveryApIp.size()), safeData(info.recoveryApIp),
        info.otaEnabled ? "true" : "false", static_cast<unsigned long>(info.maxFirmwareBytes),
        static_cast<int>(info.profile.size()), safeData(info.profile),
        static_cast<int>(info.recoveryIdentityFingerprint.size()), safeData(info.recoveryIdentityFingerprint));
    if (count < 0 || static_cast<std::size_t>(count) >= capacity) return false;
    written = static_cast<std::size_t>(count);
    return true;
}

} // namespace neonbyte
