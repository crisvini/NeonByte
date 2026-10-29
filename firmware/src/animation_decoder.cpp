#include "neonbyte/animation_decoder.h"

#include <algorithm>
#include <cstring>

namespace neonbyte {
namespace {

constexpr std::uint16_t WIDTH = 240;
constexpr std::uint16_t HEIGHT = 240;
constexpr std::uint8_t CODEC_RGB565_RAW = 0;
constexpr std::uint8_t CODEC_RGB565_RLE = 1;
constexpr std::uint8_t CODEC_PACKED_INDEX = 2;
constexpr std::uint8_t CODEC_INDEXED_RLE = 3;

std::uint16_t read16(const std::uint8_t* bytes) {
    return static_cast<std::uint16_t>(bytes[0]) |
        static_cast<std::uint16_t>(static_cast<std::uint16_t>(bytes[1]) << 8);
}

std::uint32_t read32(const std::uint8_t* bytes) {
    return static_cast<std::uint32_t>(bytes[0]) |
        (static_cast<std::uint32_t>(bytes[1]) << 8) |
        (static_cast<std::uint32_t>(bytes[2]) << 16) |
        (static_cast<std::uint32_t>(bytes[3]) << 24);
}

std::uint8_t expectedIndexBits(std::uint16_t count) {
    if (count <= 2) return 1;
    if (count <= 4) return 2;
    if (count <= 16) return 4;
    return 8;
}

} // namespace

AnimationDecoder::AnimationDecoder(const AnimationSource& source, std::uint8_t* outputRow,
                                   std::size_t outputCapacity, std::uint8_t* encodedRow,
                                   std::size_t encodedCapacity)
    : source_(source), outputRow_(outputRow), outputCapacity_(outputCapacity),
      encodedRow_(encodedRow), encodedCapacity_(encodedCapacity) {}

bool AnimationDecoder::fail(const char* error) {
    error_ = error;
    valid_ = false;
    rowReady_ = false;
    return false;
}

bool AnimationDecoder::loadDirectoryEntry(std::uint16_t index) {
    if (index >= metadata_.frameCount) return false;
    if (!source_.readAt(NBIF_V2_HEADER_BYTES + static_cast<std::uint32_t>(index) * NBIF_V2_DIRECTORY_ENTRY_BYTES,
                        directoryEntryWire_.data(), directoryEntryWire_.size())) return false;
    directoryEntryIndex_ = index;
    return true;
}

AnimationDecoder::DirectoryEntry AnimationDecoder::directoryEntry() const {
    const auto* bytes = directoryEntryWire_.data();
    DirectoryEntry entry{};
    entry.recordOffset = read32(bytes);
    entry.recordBytes = read32(bytes + 4);
    entry.delayMs = read16(bytes + 8);
    entry.kind = static_cast<AnimationFrameKind>(bytes[10]);
    entry.indexBits = bytes[11];
    entry.paletteCount = read16(bytes + 12);
    entry.rowCount = read16(bytes + 14);
    return entry;
}

bool AnimationDecoder::open(AnimationV2Metadata& metadata) {
    metadata = {};
    metadata_ = {};
    valid_ = false;
    frameIndex_ = 0;
    rowCountRead_ = 0;
    paletteReadBytes_ = 0;
    frameStarted_ = false;
    frameCompletionPending_ = false;
    rowReady_ = false;
    directoryEntryIndex_ = UINT16_MAX;
    prefetchedHeaderOffset_ = UINT16_MAX;
    error_ = "invalid NBIF v2 header";
    if (encodedRow_ == nullptr || encodedCapacity_ < NBIF_V2_ROW_BUFFER_BYTES ||
        (outputRow_ == nullptr ? outputCapacity_ != 0 :
            outputCapacity_ < NBIF_V2_ROW_BUFFER_BYTES || outputRow_ == encodedRow_) ||
        source_.size() < NBIF_V2_HEADER_BYTES) return false;

    std::array<std::uint8_t, NBIF_V2_HEADER_BYTES> header{};
    if (!source_.readAt(0, header.data(), header.size()) ||
        header[0] != 'N' || header[1] != 'B' || header[2] != 'I' || header[3] != 'F' ||
        header[4] != 2 || header[5] != 0 || read32(header.data() + 20) != 0) return false;
    const auto width = read16(header.data() + 6);
    const auto height = read16(header.data() + 8);
    const auto frameCount = read16(header.data() + 10);
    const auto durationMs = read32(header.data() + 12);
    const auto fileBytes = read32(header.data() + 16);
    if (width != WIDTH || height != HEIGHT || frameCount == 0 || frameCount > NBIF_V2_MAX_FRAMES ||
        fileBytes != source_.size() || fileBytes > NBIF_V2_MAX_FILE_BYTES ||
        fileBytes < NBIF_V2_HEADER_BYTES + frameCount * NBIF_V2_DIRECTORY_ENTRY_BYTES) return false;

    std::array<std::uint8_t, NBIF_V2_DIRECTORY_ENTRY_BYTES> raw{};
    const auto directoryBytes = static_cast<std::uint32_t>(frameCount) * NBIF_V2_DIRECTORY_ENTRY_BYTES;
    std::uint32_t expectedOffset = NBIF_V2_HEADER_BYTES + static_cast<std::uint32_t>(directoryBytes);
    std::uint32_t summedDuration = 0;
    for (std::uint16_t index = 0; index < frameCount; ++index) {
        if (!source_.readAt(NBIF_V2_HEADER_BYTES + static_cast<std::uint32_t>(index) * NBIF_V2_DIRECTORY_ENTRY_BYTES,
                            raw.data(), raw.size())) return false;
        const DirectoryEntry entry{read32(raw.data()), read32(raw.data() + 4), read16(raw.data() + 8),
            static_cast<AnimationFrameKind>(raw[10]), raw[11], read16(raw.data() + 12), read16(raw.data() + 14)};
        if (read32(raw.data() + 16) != 0 || entry.recordOffset != expectedOffset ||
            entry.recordOffset > fileBytes || entry.recordBytes > fileBytes - entry.recordOffset ||
            entry.delayMs < 20 || static_cast<std::uint8_t>(entry.kind) > 2 ||
            (index == 0 && entry.kind != AnimationFrameKind::Keyframe)) return false;
        if (entry.kind == AnimationFrameKind::Hold) {
            if (entry.recordBytes != 0 || entry.rowCount != 0 || entry.paletteCount != 0 || entry.indexBits != 0) return false;
        } else {
            if (entry.rowCount == 0 || entry.rowCount > HEIGHT || entry.paletteCount > 256 ||
                (entry.paletteCount == 0 && entry.indexBits != 0) ||
                (entry.paletteCount != 0 && entry.indexBits != expectedIndexBits(entry.paletteCount)) ||
                entry.recordBytes < static_cast<std::uint32_t>(entry.paletteCount) * 2 +
                    static_cast<std::uint32_t>(entry.rowCount) * NBIF_V2_ROW_HEADER_BYTES ||
                (entry.kind == AnimationFrameKind::Keyframe && entry.rowCount != HEIGHT)) return false;
        }
        expectedOffset += entry.recordBytes;
        summedDuration += entry.delayMs;
        if (index == 0) {
            directoryEntryWire_ = raw;
            directoryEntryIndex_ = 0;
        }
    }
    if (expectedOffset != fileBytes || summedDuration != durationMs || durationMs > NBIF_V2_MAX_DURATION_MS) return false;

    metadata_ = {width, height, frameCount, durationMs, fileBytes};
    metadata = metadata_;
    valid_ = true;
    error_ = nullptr;
    return true;
}

bool AnimationDecoder::decodeRow(std::uint8_t codec, const std::uint8_t* input,
                                 std::size_t inputLength, std::uint16_t width) {
    if (outputRow_ == nullptr || width == 0 || width > WIDTH || outputCapacity_ < width * 2) return false;
    if (codec == CODEC_RGB565_RAW) {
        if (inputLength != static_cast<std::size_t>(width) * 2) return false;
        std::memcpy(outputRow_, input, inputLength);
        rowBytes_ = static_cast<std::uint16_t>(inputLength);
        return true;
    }
    if (codec == CODEC_PACKED_INDEX) {
        if (paletteCount_ == 0) return false;
        const auto bits = directoryEntry().indexBits;
        const auto expectedBytes = (static_cast<std::size_t>(width) * bits + 7) / 8;
        if (inputLength != expectedBytes) return false;
        std::size_t bitOffset = 0;
        for (std::uint16_t pixel = 0; pixel < width; ++pixel) {
            std::uint16_t index = 0;
            for (std::uint8_t bit = 0; bit < bits; ++bit) {
                index = static_cast<std::uint16_t>((index << 1) |
                    ((input[bitOffset >> 3] >> (7 - (bitOffset & 7))) & 1));
                ++bitOffset;
            }
            if (index >= paletteCount_) return false;
            outputRow_[pixel * 2] = static_cast<std::uint8_t>(palette_[index] & 0xff);
            outputRow_[pixel * 2 + 1] = static_cast<std::uint8_t>(palette_[index] >> 8);
        }
        const auto paddingBits = expectedBytes * 8 - static_cast<std::size_t>(width) * bits;
        if (paddingBits != 0 && (input[inputLength - 1] & ((1u << paddingBits) - 1u)) != 0) return false;
        rowBytes_ = static_cast<std::uint16_t>(width * 2);
        return true;
    }
    if (codec != CODEC_RGB565_RLE && codec != CODEC_INDEXED_RLE) return false;
    const bool indexed = codec == CODEC_INDEXED_RLE;
    if (indexed && paletteCount_ == 0) return false;
    std::size_t inputOffset = 0;
    std::uint16_t pixelCount = 0;
    while (inputOffset < inputLength) {
        const auto control = input[inputOffset++];
        const auto count = static_cast<std::uint16_t>((control & 0x7f) + 1);
        if (static_cast<std::uint32_t>(pixelCount) + count > width) return false;
        if ((control & 0x80) != 0) {
            const auto valueBytes = indexed ? 1u : 2u;
            if (inputOffset + valueBytes > inputLength) return false;
            const auto value = indexed ? input[inputOffset] : read16(input + inputOffset);
            inputOffset += valueBytes;
            if (indexed && value >= paletteCount_) return false;
            for (std::uint16_t repeat = 0; repeat < count; ++repeat) {
                const auto color = indexed ? palette_[value] : value;
                outputRow_[pixelCount * 2] = static_cast<std::uint8_t>(color & 0xff);
                outputRow_[pixelCount * 2 + 1] = static_cast<std::uint8_t>(color >> 8);
                ++pixelCount;
            }
        } else {
            const auto valueBytes = indexed ? 1u : 2u;
            const auto bytes = static_cast<std::size_t>(count) * valueBytes;
            if (inputOffset + bytes > inputLength) return false;
            for (std::uint16_t item = 0; item < count; ++item) {
                const auto value = indexed ? input[inputOffset] : read16(input + inputOffset);
                inputOffset += valueBytes;
                if (indexed && value >= paletteCount_) return false;
                const auto color = indexed ? palette_[value] : value;
                outputRow_[pixelCount * 2] = static_cast<std::uint8_t>(color & 0xff);
                outputRow_[pixelCount * 2 + 1] = static_cast<std::uint8_t>(color >> 8);
                ++pixelCount;
            }
        }
    }
    if (pixelCount != width) return false;
    rowBytes_ = static_cast<std::uint16_t>(width * 2);
    return true;
}

bool AnimationDecoder::validateRow(std::uint8_t codec, const std::uint8_t* input,
                                   std::size_t inputLength, std::uint16_t width) {
    if (width == 0 || width > WIDTH) return false;
    if (codec == CODEC_RGB565_RAW) {
        if (inputLength != static_cast<std::size_t>(width) * 2) return false;
    } else if (codec == CODEC_PACKED_INDEX) {
        if (paletteCount_ == 0) return false;
        const auto bits = directoryEntry().indexBits;
        const auto expectedBytes = (static_cast<std::size_t>(width) * bits + 7) / 8;
        if (inputLength != expectedBytes) return false;
        std::size_t bitOffset = 0;
        for (std::uint16_t pixel = 0; pixel < width; ++pixel) {
            std::uint16_t index = 0;
            for (std::uint8_t bit = 0; bit < bits; ++bit) {
                index = static_cast<std::uint16_t>((index << 1) |
                    ((input[bitOffset >> 3] >> (7 - (bitOffset & 7))) & 1));
                ++bitOffset;
            }
            if (index >= paletteCount_) return false;
        }
        const auto paddingBits = expectedBytes * 8 - static_cast<std::size_t>(width) * bits;
        if (paddingBits != 0 && (input[inputLength - 1] & ((1u << paddingBits) - 1u)) != 0) return false;
    } else {
        if (codec != CODEC_RGB565_RLE && codec != CODEC_INDEXED_RLE) return false;
        const bool indexed = codec == CODEC_INDEXED_RLE;
        if (indexed && paletteCount_ == 0) return false;
        std::size_t inputOffset = 0;
        std::uint16_t pixelCount = 0;
        while (inputOffset < inputLength) {
            const auto control = input[inputOffset++];
            const auto count = static_cast<std::uint16_t>((control & 0x7f) + 1);
            if (static_cast<std::uint32_t>(pixelCount) + count > width) return false;
            const auto valueBytes = indexed ? 1u : 2u;
            const auto values = (control & 0x80) != 0 ? 1u : static_cast<unsigned>(count);
            const auto bytes = static_cast<std::size_t>(values) * valueBytes;
            if (inputOffset + bytes > inputLength) return false;
            if (indexed) {
                for (unsigned item = 0; item < values; ++item) {
                    if (input[inputOffset + item] >= paletteCount_) return false;
                }
            }
            inputOffset += bytes;
            pixelCount = static_cast<std::uint16_t>(pixelCount + count);
        }
        if (pixelCount != width) return false;
    }
    rowBytes_ = static_cast<std::uint16_t>(width * 2);
    return true;
}

AnimationDecodeStatus AnimationDecoder::finishFrame() {
    const auto entry = directoryEntry();
    frameInfo_ = {frameIndex_, entry.delayMs, entry.kind};
    frameCompletionPending_ = true;
    frameStarted_ = false;
    return AnimationDecodeStatus::FrameComplete;
}

AnimationDecodeStatus AnimationDecoder::step() {
    if (!valid_) return AnimationDecodeStatus::Error;
    if (rowReady_) return AnimationDecodeStatus::RowReady;
    if (frameCompletionPending_) {
        frameCompletionPending_ = false;
        ++frameIndex_;
        if (frameIndex_ >= metadata_.frameCount) return AnimationDecodeStatus::AnimationComplete;
        return AnimationDecodeStatus::Progress;
    }
    if (frameIndex_ >= metadata_.frameCount) return AnimationDecodeStatus::AnimationComplete;
    if (directoryEntryIndex_ != frameIndex_ && !loadDirectoryEntry(frameIndex_)) {
        fail("directory entry read failed");
        return AnimationDecodeStatus::Error;
    }
    const auto entry = directoryEntry();
    if (!frameStarted_) {
        rowCursor_ = entry.recordOffset;
        rowCountRead_ = 0;
        previousY_ = 0;
        paletteCount_ = entry.paletteCount;
        paletteReadBytes_ = 0;
        frameStarted_ = true;
        if (entry.kind == AnimationFrameKind::Hold) return finishFrame();
        return AnimationDecodeStatus::Progress;
    }
    const auto totalPaletteBytes = static_cast<std::uint16_t>(paletteCount_ * 2);
    if (paletteReadBytes_ < totalPaletteBytes) {
        std::array<std::uint8_t, 64> paletteChunk{};
        const auto count = std::min<std::size_t>(paletteChunk.size(), totalPaletteBytes - paletteReadBytes_);
        if (!source_.readAt(rowCursor_ + paletteReadBytes_, paletteChunk.data(), count)) {
            fail("palette read failed");
            return AnimationDecodeStatus::Error;
        }
        const auto firstIndex = static_cast<std::uint16_t>(paletteReadBytes_ / 2);
        const auto countEntries = static_cast<std::uint16_t>(count / 2);
        for (std::uint16_t item = 0; item < countEntries; ++item) {
            const auto index = static_cast<std::uint16_t>(firstIndex + item);
            palette_[index] = read16(paletteChunk.data() + item * 2);
            for (std::uint16_t prior = 0; prior < index; ++prior) {
                if (palette_[prior] == palette_[index]) {
                    fail("duplicate palette color");
                    return AnimationDecodeStatus::Error;
                }
            }
        }
        paletteReadBytes_ = static_cast<std::uint16_t>(paletteReadBytes_ + count);
        if (paletteReadBytes_ < totalPaletteBytes) return AnimationDecodeStatus::Progress;
        rowCursor_ += totalPaletteBytes;
        return AnimationDecodeStatus::Progress;
    }
    if (rowCountRead_ >= entry.rowCount) {
        if (rowCursor_ != entry.recordOffset + entry.recordBytes) {
            fail("frame record has trailing or missing bytes");
            return AnimationDecodeStatus::Error;
        }
        return finishFrame();
    }

    std::array<std::uint8_t, NBIF_V2_ROW_HEADER_BYTES> rowHeader{};
    if (prefetchedHeaderOffset_ != UINT16_MAX) {
        std::memcpy(rowHeader.data(), encodedRow_ + prefetchedHeaderOffset_, rowHeader.size());
        prefetchedHeaderOffset_ = UINT16_MAX;
    } else if (!source_.readAt(rowCursor_, rowHeader.data(), rowHeader.size())) {
        fail("row header read failed");
        return AnimationDecodeStatus::Error;
    }
    const auto y = rowHeader[0];
    const auto x = rowHeader[1];
    const auto width = rowHeader[2];
    const auto codec = rowHeader[3];
    const auto encodedBytes = read16(rowHeader.data() + 4);
    rowCursor_ += NBIF_V2_ROW_HEADER_BYTES;
    if (y >= HEIGHT || width == 0 || width > WIDTH || static_cast<std::uint16_t>(x) + width > WIDTH ||
        (rowCountRead_ != 0 && y <= previousY_) || encodedBytes > NBIF_V2_ROW_BUFFER_BYTES ||
        rowCursor_ > entry.recordOffset + entry.recordBytes ||
        encodedBytes > entry.recordOffset + entry.recordBytes - rowCursor_ ||
        (entry.kind == AnimationFrameKind::Keyframe && (x != 0 || width != WIDTH || y != rowCountRead_))) {
        fail("row bounds or order are invalid");
        return AnimationDecodeStatus::Error;
    }
    // Frame zero is rebuilt at every loop. Fold the next header into this read
    // when it fits, retaining the existing row workspace and one row per step.
    const bool prefetchHeader = outputRow_ != nullptr && frameIndex_ == 0 &&
        rowCountRead_ + 1 < entry.rowCount &&
        encodedBytes <= NBIF_V2_ROW_BUFFER_BYTES - NBIF_V2_ROW_HEADER_BYTES &&
        entry.recordOffset + entry.recordBytes - rowCursor_ - encodedBytes >= NBIF_V2_ROW_HEADER_BYTES;
    const auto readBytes = encodedBytes + (prefetchHeader ? NBIF_V2_ROW_HEADER_BYTES : 0);
    if (readBytes != 0 && !source_.readAt(rowCursor_, encodedRow_, readBytes)) {
        fail("row payload read failed");
        return AnimationDecodeStatus::Error;
    }
    if (!(outputRow_ ? decodeRow(codec, encodedRow_, encodedBytes, width)
                     : validateRow(codec, encodedRow_, encodedBytes, width))) {
        fail("row payload is malformed");
        return AnimationDecodeStatus::Error;
    }
    if (prefetchHeader) {
        prefetchedHeaderOffset_ = encodedBytes;
    }
    rowCursor_ += encodedBytes;
    previousY_ = y;
    rowX_ = x;
    rowY_ = y;
    rowWidth_ = width;
    ++rowCountRead_;
    rowReady_ = true;
    return AnimationDecodeStatus::RowReady;
}

AnimationRow AnimationDecoder::row() const {
    if (!rowReady_) return {};
    return {rowX_, rowY_, rowWidth_, rowBytes_, outputRow_};
}

void AnimationDecoder::consumeRow() {
    rowReady_ = false;
}

AnimationFrameInfo AnimationDecoder::frameInfo() const {
    return frameInfo_;
}

void AnimationDecoder::restart() {
    if (!valid_) return;
    frameIndex_ = 0;
    rowCountRead_ = 0;
    paletteReadBytes_ = 0;
    frameStarted_ = false;
    frameCompletionPending_ = false;
    rowReady_ = false;
    directoryEntryIndex_ = UINT16_MAX;
    prefetchedHeaderOffset_ = UINT16_MAX;
    error_ = nullptr;
}

} // namespace neonbyte
