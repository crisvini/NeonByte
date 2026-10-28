#pragma once

#include "neonbyte/animation_source.h"

#include <array>
#include <cstddef>
#include <cstdint>

namespace neonbyte {

constexpr std::uint32_t NBIF_V2_HEADER_BYTES = 24;
constexpr std::uint32_t NBIF_V2_DIRECTORY_ENTRY_BYTES = 20;
constexpr std::uint32_t NBIF_V2_ROW_HEADER_BYTES = 6;
constexpr std::uint32_t NBIF_V2_MAX_FILE_BYTES = 2'359'296;
constexpr std::uint32_t NBIF_V2_MAX_DURATION_MS = 30'000;
constexpr std::size_t NBIF_V2_MAX_DIRECTORY_BYTES = 20 * NBIF_V2_DIRECTORY_ENTRY_BYTES;
constexpr std::size_t NBIF_V2_ROW_BUFFER_BYTES = 480;

enum class AnimationDecodeStatus : std::uint8_t {
    Progress,
    RowReady,
    FrameComplete,
    AnimationComplete,
    Error,
};

enum class AnimationFrameKind : std::uint8_t {
    Keyframe = 0,
    Delta = 1,
    Hold = 2,
};

struct AnimationRow {
    std::uint16_t x = 0;
    std::uint16_t y = 0;
    std::uint16_t width = 0;
    std::uint16_t byteCount = 0;
    const std::uint8_t* pixels = nullptr;
};

struct AnimationFrameInfo {
    std::uint16_t frameIndex = 0;
    std::uint16_t delayMs = 0;
    AnimationFrameKind kind = AnimationFrameKind::Keyframe;
};

struct AnimationV2Metadata {
    std::uint16_t width = 0;
    std::uint16_t height = 0;
    std::uint16_t frameCount = 0;
    std::uint32_t durationMs = 0;
    std::uint32_t fileBytes = 0;
};

class AnimationDecoder {
public:
    AnimationDecoder(const AnimationSource& source, std::uint8_t* outputRow, std::size_t outputCapacity);

    bool open(AnimationV2Metadata& metadata);
    AnimationDecodeStatus step();
    AnimationRow row() const;
    void consumeRow();
    AnimationFrameInfo frameInfo() const;
    void restart();
    bool valid() const { return valid_; }
    const char* error() const { return error_; }

private:
    struct DirectoryEntry {
        std::uint32_t recordOffset = 0;
        std::uint32_t recordBytes = 0;
        std::uint16_t delayMs = 0;
        AnimationFrameKind kind = AnimationFrameKind::Keyframe;
        std::uint8_t indexBits = 0;
        std::uint16_t paletteCount = 0;
        std::uint16_t rowCount = 0;
    };

    bool fail(const char* error);
    DirectoryEntry directoryEntry(std::uint16_t index) const;
    AnimationDecodeStatus finishFrame();
    bool decodeRow(std::uint8_t codec, const std::uint8_t* input, std::size_t inputLength,
                   std::uint16_t width);

    const AnimationSource& source_;
    std::uint8_t* outputRow_;
    std::size_t outputCapacity_;
    std::array<std::uint8_t, NBIF_V2_MAX_DIRECTORY_BYTES> directory_{};
    std::array<std::uint8_t, NBIF_V2_ROW_BUFFER_BYTES> encodedRow_{};
    std::array<std::uint16_t, 256> palette_{};
    AnimationV2Metadata metadata_{};
    AnimationFrameInfo frameInfo_{};
    std::uint32_t rowCursor_ = 0;
    std::uint16_t paletteReadBytes_ = 0;
    std::uint16_t frameIndex_ = 0;
    std::uint16_t rowCountRead_ = 0;
    std::uint16_t previousY_ = 0;
    std::uint16_t rowX_ = 0;
    std::uint16_t rowY_ = 0;
    std::uint16_t rowWidth_ = 0;
    std::uint16_t rowBytes_ = 0;
    std::uint16_t paletteCount_ = 0;
    bool valid_ = false;
    bool frameStarted_ = false;
    bool frameCompletionPending_ = false;
    bool rowReady_ = false;
    const char* error_ = "not opened";
};

} // namespace neonbyte
