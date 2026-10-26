#pragma once
#include "neonbyte/firmware_image.h"
#include <string_view>
namespace neonbyte {
class ContentDigest {
public:
    virtual ~ContentDigest() = default;
    virtual void reset() = 0;
    virtual void update(const std::uint8_t* bytes, std::size_t length) = 0;
    virtual void finish(char* hex64) = 0;
};
enum class HashStep { pending, complete, failed };
class HashJob {
public:
    HashJob(const ImageSource& source, ContentDigest& digest, std::uint32_t prefix, std::uint32_t length)
        : source_(source), digest_(digest), prefix_(prefix), length_(length) { digest_.reset(); }
    HashStep step(std::uint8_t* buffer, std::size_t capacity);
private:
    const ImageSource& source_;
    ContentDigest& digest_;
    std::uint32_t prefix_, length_, position_ = 0;
    bool failed_ = false;
};
} // namespace neonbyte
