#include "neonbyte/firmware_image.h"
#include "neonbyte/http_headers.h"
#include <algorithm>
#include <array>
namespace neonbyte {
namespace {
std::uint32_t little32(const std::uint8_t* b) {
    return b[0] | (std::uint32_t(b[1])<<8) | (std::uint32_t(b[2])<<16) | (std::uint32_t(b[3])<<24);
}
bool image(const ImageSource& source, std::uint32_t offset, std::uint32_t boundary, bool exact) {
    std::array<std::uint8_t,256> buffer{};
    if (offset > boundary || boundary-offset < 8 || !source.readAt(offset,buffer.data(),8)) return false;
    const auto count = buffer[1]; const auto entry = little32(buffer.data()+4);
    if (buffer[0] != 0xe9 || !count || count > 16 || buffer[2] != 2 || buffer[3] != 0x40 || entry < 0x40100000 || entry >= 0x40110000) return false;
    std::uint32_t position = offset+8; std::uint8_t checksum = 0xef;
    for (unsigned segment = 0; segment < count; ++segment) {
        if (position > boundary || boundary-position < 8 || !source.readAt(position,buffer.data(),8)) return false;
        const auto address = little32(buffer.data());
        auto length = little32(buffer.data()+4); position += 8;
        const auto inRange = [address,length](std::uint32_t first, std::uint32_t end) {
            return address >= first && address < end && length <= end-address;
        };
        if (!inRange(0x3ffe8000,0x40000000) && !inRange(0x40100000,0x40110000) && !inRange(0x40200000,0x40300000)) return false;
        if (!length || length > boundary-position) return false;
        while (length) {
            const auto chunk = std::min<std::uint32_t>(length,buffer.size());
            if (!source.readAt(position,buffer.data(),chunk)) return false;
            for (unsigned i=0;i<chunk;++i) {
                // elf2bin patches modern length/CRC after calculating segment XOR.
                const bool patchedMetadata = address == 0x40201010 && position+i >= 0x1010 && position+i < 0x1018;
                if (!patchedMetadata) checksum ^= buffer[i];
            }
            position += chunk; length -= chunk;
        }
    }
    const auto checksumOffset = position | 15U;
    if (checksumOffset >= boundary || (exact && checksumOffset+1 != boundary)) return false;
    if (!source.readAt(position,buffer.data(),checksumOffset-position+1)) return false;
    for (unsigned i=0;i<checksumOffset-position;++i) if (buffer[i]) return false;
    return buffer[checksumOffset-position] == checksum;
}
}
bool validateEsp8266Image(const ImageSource& source) {
    const auto size = source.size();
    return size > 0x1020-1 && size <= FIRMWARE_BYTES_LIMIT && image(source,0,0x1000,false) && image(source,0x1000,size,true);
}
bool validateArduinoImageCrc(const ImageSource& source) {
    if (source.size() < 0x1018 || source.size() > FIRMWARE_BYTES_LIMIT) return false;
    std::array<std::uint8_t,256> bytes{};
    if (!source.readAt(0x1010,bytes.data(),8) || little32(bytes.data()) != source.size()) return false;
    const auto expected = little32(bytes.data()+4);
    std::uint32_t crc = 0xffffffff;
    for (std::uint32_t offset=0;offset<source.size();) {
        const auto count = std::min<std::uint32_t>(bytes.size(),source.size()-offset);
        if (!source.readAt(offset,bytes.data(),count)) return false;
        for (unsigned i=0;i<count;++i) {
            const auto index = offset+i;
            const auto value = index >= 0x1010 && index < 0x1018 ? 0 : bytes[i];
            crc ^= std::uint32_t(value)<<24;
            for (unsigned bit=0;bit<8;++bit) crc = (crc<<1) ^ ((crc & 0x80000000) ? 0x04c11db7 : 0);
        }
        offset += count;
    }
    return crc == expected;
}
} // namespace neonbyte
