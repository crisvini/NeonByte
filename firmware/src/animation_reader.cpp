#include "neonbyte/animation_reader.h"

#include <algorithm>
#include <array>

namespace neonbyte {
namespace {

constexpr std::uint32_t FRAME_RECORD_BYTES = 2 + ANIMATION_FRAME_PIXEL_BYTES;

std::uint16_t readLittleEndian16(const std::uint8_t* bytes) {
    return static_cast<std::uint16_t>(bytes[0]) |
        static_cast<std::uint16_t>(static_cast<std::uint16_t>(bytes[1]) << 8);
}

} // namespace

AnimationReader::AnimationReader(const Storage& storage) : storage_(storage) {}

bool AnimationReader::open(AnimationMetadata& metadata) {
    metadata = {};
    isOpen_ = false;
    metadata_ = {};
    if (storage_.animationSize() < ANIMATION_HEADER_BYTES) {
        return false;
    }

    std::array<std::uint8_t, ANIMATION_HEADER_BYTES> header{};
    if (!storage_.readAnimationAt(0, header.data(), header.size()) ||
        header[0] != 'N' || header[1] != 'B' || header[2] != 'I' || header[3] != 'F' || header[4] != 1) {
        return false;
    }

    const std::uint16_t width = readLittleEndian16(header.data() + 5);
    const std::uint16_t height = readLittleEndian16(header.data() + 7);
    const std::uint16_t frameCount = readLittleEndian16(header.data() + 9);
    if (width != ANIMATION_WIDTH || height != ANIMATION_HEIGHT || frameCount == 0 || frameCount > ANIMATION_MAX_FRAMES) {
        return false;
    }

    const std::uint64_t expectedSize = ANIMATION_HEADER_BYTES +
        static_cast<std::uint64_t>(frameCount) * FRAME_RECORD_BYTES;
    if (expectedSize != storage_.animationSize()) {
        return false;
    }

    std::uint32_t durationMs = 0;
    for (std::uint16_t frameIndex = 0; frameIndex < frameCount; ++frameIndex) {
        std::array<std::uint8_t, 2> delayBytes{};
        const std::uint32_t delayOffset = ANIMATION_HEADER_BYTES +
            static_cast<std::uint32_t>(frameIndex) * FRAME_RECORD_BYTES;
        if (!storage_.readAnimationAt(delayOffset, delayBytes.data(), delayBytes.size())) {
            return false;
        }
        const std::uint16_t delayMs = readLittleEndian16(delayBytes.data());
        if (delayMs < 20 || durationMs + delayMs > ANIMATION_MAX_DURATION_MS) {
            return false;
        }
        durationMs += delayMs;
    }

    metadata_ = {width, height, frameCount, durationMs};
    metadata = metadata_;
    isOpen_ = true;
    return true;
}

bool AnimationReader::frameDelayMs(std::uint16_t frameIndex, std::uint16_t& delayMs) const {
    if (!isOpen_ || frameIndex >= metadata_.frameCount) {
        return false;
    }
    std::array<std::uint8_t, 2> bytes{};
    const std::uint32_t offset = ANIMATION_HEADER_BYTES +
        static_cast<std::uint32_t>(frameIndex) * FRAME_RECORD_BYTES;
    if (!storage_.readAnimationAt(offset, bytes.data(), bytes.size())) {
        return false;
    }
    delayMs = readLittleEndian16(bytes.data());
    return true;
}

bool AnimationReader::readFrameChunk(std::uint16_t frameIndex, std::uint32_t frameByteOffset,
                                     std::uint8_t* destination, std::size_t capacity,
                                     std::size_t& bytesRead) const {
    bytesRead = 0;
    if (!isOpen_ || frameIndex >= metadata_.frameCount || destination == nullptr || capacity == 0 ||
        frameByteOffset >= ANIMATION_FRAME_PIXEL_BYTES) {
        return false;
    }

    const std::uint32_t remaining = ANIMATION_FRAME_PIXEL_BYTES - frameByteOffset;
    const std::size_t count = std::min<std::size_t>(capacity, remaining);
    const std::uint32_t frameOffset = ANIMATION_HEADER_BYTES +
        static_cast<std::uint32_t>(frameIndex) * FRAME_RECORD_BYTES + 2;
    if (!storage_.readAnimationAt(frameOffset + frameByteOffset, destination, count)) {
        return false;
    }
    bytesRead = count;
    return true;
}

} // namespace neonbyte
