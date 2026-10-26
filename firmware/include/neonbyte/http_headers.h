#pragma once
#include "neonbyte/protocol.h"
namespace neonbyte {
// Views refer to the supplied header buffer, which must outlive dispatch.
struct HttpHeaders {
    HttpMethod method = HttpMethod::other;
    std::string_view path, authorization, contentType, sha256, trackId;
    std::uint32_t contentLength = 0;
    bool parse(std::string_view input);
};
constexpr std::uint32_t JSON_BODY_LIMIT = 12'288;
constexpr std::uint32_t HTTP_HEADER_LIMIT = 4'096;
constexpr std::uint32_t COVER_BYTES = 9 + 240 * 240 * 2;
constexpr std::uint32_t ANIMATION_BYTES_LIMIT = 11 + 20 * (2 + 240 * 240 * 2);
constexpr std::uint32_t FIRMWARE_BYTES_LIMIT = 512 * 1024;
} // namespace neonbyte
