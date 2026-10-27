#pragma once

#include "neonbyte/animation_reader.h"

#include <algorithm>
#include <cstdint>
#include <string_view>
#include <vector>

namespace neonbyte {

struct DeviceConfiguration {
    char token[65]{};
    char apPassword[17]{};
};

class PersistentStorage final : public Storage {
public:
    std::uint32_t assetRevision = 0;
    std::vector<std::uint8_t> animationBytes;
    std::vector<std::uint8_t> coverBytes;
    std::string_view coverTrack = "track";
    mutable std::vector<std::uint32_t> coverReads;

    bool loadMode(DisplayMode& mode) const override {
        static_cast<void>(mode);
        return false;
    }
    bool saveMode(DisplayMode mode) override {
        static_cast<void>(mode);
        return true;
    }
    std::uint64_t freeBytes() const override { return 0; }
    std::uint32_t animationSize() const override {
        return static_cast<std::uint32_t>(animationBytes.size());
    }
    bool readAnimationAt(std::uint32_t offset, std::uint8_t* destination, std::size_t length) const override {
        if (offset > animationBytes.size() || length > animationBytes.size() - offset) return false;
        std::copy_n(animationBytes.data() + offset, length, destination);
        return true;
    }
    bool readCover(std::string_view trackId, std::uint32_t offset, std::uint8_t* bytes, std::size_t length) const {
        coverReads.push_back(offset);
        if (trackId != coverTrack || offset > coverBytes.size() || length > coverBytes.size() - offset) return false;
        std::copy_n(coverBytes.data() + offset, length, bytes);
        return true;
    }
};

} // namespace neonbyte
