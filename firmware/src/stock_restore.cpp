#include "neonbyte/stock_restore.h"
#include <algorithm>
#include <array>
namespace neonbyte {
namespace {
std::uint32_t little32(const std::uint8_t* value) {
    return value[0] | (std::uint32_t(value[1])<<8) | (std::uint32_t(value[2])<<16) | (std::uint32_t(value[3])<<24);
}
struct Segment { std::uint32_t address, length; };
bool legacyImage(const ImageSource& source, std::uint32_t offset, std::uint32_t end,
                 std::uint32_t entry, const Segment* segments, unsigned count) {
    std::array<std::uint8_t,256> buffer{};
    if (!source.readAt(offset,buffer.data(),8) || buffer[0] != 0xe9 || buffer[1] != count ||
        buffer[2] != 2 || buffer[3] != 0x40 || little32(buffer.data()+4) != entry) return false;
    std::uint32_t position = offset+8; std::uint8_t checksum = 0xef;
    for (unsigned segment=0;segment<count;++segment) {
        if (position > end || end-position < 8 || !source.readAt(position,buffer.data(),8) ||
            little32(buffer.data()) != segments[segment].address || little32(buffer.data()+4) != segments[segment].length) return false;
        position += 8;
        auto remaining = segments[segment].length;
        if (remaining > end-position) return false;
        while (remaining) {
            const auto size = std::min<std::uint32_t>(remaining,buffer.size());
            if (!source.readAt(position,buffer.data(),size)) return false;
            for (unsigned i=0;i<size;++i) checksum ^= buffer[i];
            position += size; remaining -= size;
        }
    }
    const auto footer = position | 15U;
    if (footer+1 != end || !source.readAt(position,buffer.data(),footer-position+1)) return false;
    for (unsigned i=0;i<footer-position;++i) if (buffer[i]) return false;
    return buffer[footer-position] == checksum;
}
}
bool isStockRestorePath(std::string_view path) { return path == "/maintenance/v1/stock-firmware"; }
bool stockRestoreRequestMatches(std::uint32_t length, std::string_view hash) {
    return length == STOCK_V106_BYTES && hash == STOCK_V106_SHA256;
}
bool stockRestoreGeometryMatches(const OtaGeometry& geometry) {
    return geometry.flashConfigMatches && geometry.physicalFlashBytes == OTA_FLASH_BYTES &&
        geometry.currentFlashMode == 2 && geometry.filesystemStartOffset == 0x100000 &&
        geometry.filesystemEndOffset == 0x3fa000 && geometry.eepromStartOffset == 0x3fb000;
}
bool validateLegacyStockImage(const ImageSource& source) {
    constexpr Segment BOOT[] = {{0x4010f000,0xe00}};
    constexpr Segment APPLICATION[] = {{0x40201010,0x6d04c},{0x40100000,0x104},
        {0x40100104,0x7044},{0x3ffe8000,0x6c8},{0x3ffe86d0,0x1ad8}};
    if (source.size() != STOCK_V106_BYTES || !legacyImage(source,0,0xe20,0x4010f45c,BOOT,1) ||
        !legacyImage(source,0x1000,STOCK_V106_BYTES,0x401000b8,APPLICATION,5)) return false;
    std::array<std::uint8_t,256> buffer{};
    for (std::uint32_t offset=0xe20;offset<0xff8;) {
        const auto size = std::min<std::uint32_t>(buffer.size(),0xff8-offset);
        if (!source.readAt(offset,buffer.data(),size)) return false;
        for (unsigned i=0;i<size;++i) if (buffer[i] != 0xaa) return false;
        offset += size;
    }
    if (!source.readAt(0xff8,buffer.data(),8) || little32(buffer.data()) != source.size()) return false;
    const auto expected = little32(buffer.data()+4);
    std::uint32_t crc = 0xffffffff;
    for (std::uint32_t offset=0;offset<source.size();) {
        const auto size = std::min<std::uint32_t>(buffer.size(),source.size()-offset);
        if (!source.readAt(offset,buffer.data(),size)) return false;
        for (unsigned i=0;i<size;++i) {
            const auto index = offset+i;
            crc ^= std::uint32_t(index >= 0xff8 && index < 0x1000 ? 0 : buffer[i])<<24;
            for (unsigned bit=0;bit<8;++bit) crc = (crc<<1) ^ ((crc & 0x80000000) ? 0x04c11db7 : 0);
        }
        offset += size;
    }
    return crc == expected;
}
OtaAdmissionError stockRestoreAdmission(bool authorized, bool paused, bool otaEnabled, bool restoreEnabled,
    HttpMethod method, std::string_view contentType, std::uint32_t length, std::string_view hash) {
    const auto result = maintenanceOtaAdmission(authorized,paused,otaEnabled && restoreEnabled,method,contentType,length,hash);
    if (result != OtaAdmissionError::none) return result;
    return stockRestoreRequestMatches(length,hash) ? OtaAdmissionError::none : OtaAdmissionError::invalidBody;
}
} // namespace neonbyte
