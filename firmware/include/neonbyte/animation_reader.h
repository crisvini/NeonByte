#pragma once

#include "neonbyte/interfaces.h"

namespace neonbyte {

constexpr std::uint16_t ANIMATION_WIDTH = 240;
constexpr std::uint16_t ANIMATION_HEIGHT = 240;
constexpr std::uint16_t ANIMATION_MAX_FRAMES = 20;
constexpr std::uint32_t ANIMATION_MAX_DURATION_MS = 30'000;
constexpr std::uint32_t ANIMATION_HEADER_BYTES = 11;
constexpr std::uint32_t ANIMATION_FRAME_PIXEL_BYTES =
    static_cast<std::uint32_t>(ANIMATION_WIDTH) * ANIMATION_HEIGHT * 2;

struct AnimationMetadata {
    std::uint16_t width = 0;
    std::uint16_t height = 0;
    std::uint16_t frameCount = 0;
    std::uint32_t durationMs = 0;
};

class AnimationReader {
public:
    explicit AnimationReader(const Storage& storage);

    bool open(AnimationMetadata& metadata);
    bool frameDelayMs(std::uint16_t frameIndex, std::uint16_t& delayMs) const;
    bool readFrameChunk(std::uint16_t frameIndex, std::uint32_t frameByteOffset,
                        std::uint8_t* destination, std::size_t capacity,
                        std::size_t& bytesRead) const;

private:
    const Storage& storage_;
    AnimationMetadata metadata_{};
    bool isOpen_ = false;
};

} // namespace neonbyte
