#pragma once

#include <cstddef>
#include <cstdint>
#include <string_view>

namespace neonbyte {

struct MaintenanceInfo {
    std::string_view deviceId;
    std::string_view bootId;
    std::string_view buildId;
    std::string_view firmwareVersion;
    std::string_view stationIp;
    std::string_view recoveryApIp;
    std::string_view profile;
    std::string_view recoveryIdentityFingerprint;
    std::uint32_t maxFirmwareBytes = 0;
    bool otaEnabled = false;
};

bool isValidMaintenanceInfo(const MaintenanceInfo& info);
std::uint32_t maintenanceFirmwareCapacity(bool enabled, std::uint32_t freeSketchBytes,
                                          std::uint32_t absoluteLimit);
bool writeMaintenanceInfoJson(const MaintenanceInfo& info, char* output, std::size_t capacity,
                              std::size_t& written);

} // namespace neonbyte
