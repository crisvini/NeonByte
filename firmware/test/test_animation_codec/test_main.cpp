#include <unity.h>

#include "neonbyte/animation_decoder.h"
#include "neonbyte/interfaces.h"

#include <algorithm>
#include <cstdint>
#include <limits>
#include <vector>

using namespace neonbyte;

static_assert(sizeof(AnimationDecoder) <= 1536, "NBIF v2 decoder state must remain within 1.5 KiB.");

namespace {

class DecoderStorage final : public Storage {
public:
    std::vector<std::uint8_t> bytes;
    mutable std::size_t largestRead = 0;

    bool loadMode(DisplayMode&) const override { return false; }
    bool saveMode(DisplayMode) override { return false; }
    std::uint64_t freeBytes() const override { return 0; }
    std::uint32_t animationSize() const override { return static_cast<std::uint32_t>(bytes.size()); }
    bool readAnimationAt(std::uint32_t offset, std::uint8_t* destination, std::size_t length) const override {
        largestRead = std::max(largestRead, length);
        if (offset > bytes.size() || length > bytes.size() - offset) return false;
        std::copy_n(bytes.data() + offset, length, destination);
        return true;
    }
};

struct FrameRecord {
    AnimationFrameKind kind;
    std::uint16_t delayMs;
    std::vector<std::uint16_t> palette;
    std::uint8_t indexBits;
    std::uint16_t rowCount;
    std::vector<std::uint8_t> bytes;
};

void append16(std::vector<std::uint8_t>& output, std::uint16_t value) {
    output.push_back(static_cast<std::uint8_t>(value));
    output.push_back(static_cast<std::uint8_t>(value >> 8));
}

void appendRow(std::vector<std::uint8_t>& output, std::uint8_t y, std::uint8_t x,
               std::uint8_t width, std::uint8_t codec, const std::vector<std::uint8_t>& payload) {
    output.push_back(y); output.push_back(x); output.push_back(width); output.push_back(codec);
    append16(output, static_cast<std::uint16_t>(payload.size()));
    output.insert(output.end(), payload.begin(), payload.end());
}

FrameRecord keyframe() {
    FrameRecord frame{AnimationFrameKind::Keyframe, 70, {0xf800, 0x07e0}, 1, 240, {}};
    append16(frame.bytes, frame.palette[0]); append16(frame.bytes, frame.palette[1]);
    std::vector<std::uint8_t> raw(480, 0);
    for (std::size_t offset = 0; offset < raw.size(); offset += 2) {
        raw[offset] = 0x00; raw[offset + 1] = 0xf8;
    }
    appendRow(frame.bytes, 0, 0, 240, 0, raw);
    appendRow(frame.bytes, 1, 0, 240, 1, {0xff, 0x00, 0xf8, 0xef, 0x00, 0xf8});
    std::vector<std::uint8_t> packed(30, 0x55);
    appendRow(frame.bytes, 2, 0, 240, 2, packed);
    appendRow(frame.bytes, 3, 0, 240, 3, {0xff, 1, 0xef, 1});
    for (std::uint16_t y = 4; y < 240; ++y) {
        appendRow(frame.bytes, static_cast<std::uint8_t>(y), 0, 240, 1,
            {0xff, 0x00, 0xf8, 0xef, 0x00, 0xf8});
    }
    return frame;
}

FrameRecord delta() {
    FrameRecord frame{AnimationFrameKind::Delta, 80, {0x07e0}, 1, 1, {}};
    append16(frame.bytes, frame.palette[0]);
    appendRow(frame.bytes, 10, 20, 2, 3, {0x81, 0});
    return frame;
}

FrameRecord hold() {
    return {AnimationFrameKind::Hold, 90, {}, 0, 0, {}};
}

void writeTestAnimation(DecoderStorage& storage) {
    const std::vector<FrameRecord> records{keyframe(), delta(), hold()};
    const std::uint32_t dataOffset = NBIF_V2_HEADER_BYTES + records.size() * NBIF_V2_DIRECTORY_ENTRY_BYTES;
    std::uint32_t totalBytes = dataOffset;
    for (const auto& record : records) totalBytes += record.bytes.size();
    storage.bytes.assign(totalBytes, 0);
    auto& bytes = storage.bytes;
    bytes[0] = 'N'; bytes[1] = 'B'; bytes[2] = 'I'; bytes[3] = 'F'; bytes[4] = 2;
    bytes[6] = 240; bytes[8] = 240; bytes[10] = static_cast<std::uint8_t>(records.size());
    bytes[12] = 240; bytes[16] = static_cast<std::uint8_t>(totalBytes);
    bytes[17] = static_cast<std::uint8_t>(totalBytes >> 8);
    bytes[18] = static_cast<std::uint8_t>(totalBytes >> 16);
    std::uint32_t offset = dataOffset;
    for (std::size_t index = 0; index < records.size(); ++index) {
        const auto directory = NBIF_V2_HEADER_BYTES + index * NBIF_V2_DIRECTORY_ENTRY_BYTES;
        const auto& frame = records[index];
        const auto write32At = [&](std::size_t at, std::uint32_t value) {
            bytes[at] = static_cast<std::uint8_t>(value);
            bytes[at + 1] = static_cast<std::uint8_t>(value >> 8);
            bytes[at + 2] = static_cast<std::uint8_t>(value >> 16);
            bytes[at + 3] = static_cast<std::uint8_t>(value >> 24);
        };
        write32At(directory, offset);
        write32At(directory + 4, frame.bytes.size());
        bytes[directory + 8] = static_cast<std::uint8_t>(frame.delayMs);
        bytes[directory + 9] = static_cast<std::uint8_t>(frame.delayMs >> 8);
        bytes[directory + 10] = static_cast<std::uint8_t>(frame.kind);
        bytes[directory + 11] = frame.indexBits;
        bytes[directory + 12] = static_cast<std::uint8_t>(frame.palette.size());
        bytes[directory + 14] = static_cast<std::uint8_t>(frame.rowCount);
        bytes[directory + 15] = static_cast<std::uint8_t>(frame.rowCount >> 8);
        std::copy(frame.bytes.begin(), frame.bytes.end(), bytes.begin() + offset);
        offset += frame.bytes.size();
    }
}

void testV2DecoderStreamsAllRowCodecsDeltasAndHolds() {
    DecoderStorage storage;
    writeTestAnimation(storage);
    std::array<std::uint8_t, NBIF_V2_ROW_BUFFER_BYTES> output{};
    AnimationDecoder decoder(storage, output.data(), output.size());
    AnimationV2Metadata metadata{};
    TEST_ASSERT_TRUE(decoder.open(metadata));
    TEST_ASSERT_EQUAL_UINT16(3, metadata.frameCount);
    TEST_ASSERT_EQUAL_UINT32(240, metadata.durationMs);
    std::uint16_t rows = 0;
    while (true) {
        const auto status = decoder.step();
        if (status == AnimationDecodeStatus::FrameComplete) break;
        if (status == AnimationDecodeStatus::Progress) continue;
        TEST_ASSERT_EQUAL_INT(AnimationDecodeStatus::RowReady, status);
        const auto row = decoder.row();
        TEST_ASSERT_EQUAL_UINT16(rows, row.y);
        TEST_ASSERT_EQUAL_UINT16(240, row.width);
        TEST_ASSERT_EQUAL_UINT16(480, row.byteCount);
        if (rows == 0 || rows == 1 || rows >= 4) TEST_ASSERT_EQUAL_HEX16(0xf800, row.pixels[0] | (row.pixels[1] << 8));
        if (rows == 2) {
            TEST_ASSERT_EQUAL_HEX16(0xf800, row.pixels[0] | (row.pixels[1] << 8));
            TEST_ASSERT_EQUAL_HEX16(0x07e0, row.pixels[2] | (row.pixels[3] << 8));
        }
        if (rows == 3) TEST_ASSERT_EQUAL_HEX16(0x07e0, row.pixels[0] | (row.pixels[1] << 8));
        decoder.consumeRow();
        ++rows;
    }
    TEST_ASSERT_EQUAL_UINT16(240, rows);
    TEST_ASSERT_EQUAL_UINT16(70, decoder.frameInfo().delayMs);
    TEST_ASSERT_EQUAL_INT(AnimationDecodeStatus::Progress, decoder.step()); // advance directory
    AnimationDecodeStatus deltaStatus = AnimationDecodeStatus::Progress;
    while (deltaStatus == AnimationDecodeStatus::Progress) deltaStatus = decoder.step();
    TEST_ASSERT_EQUAL_INT(AnimationDecodeStatus::RowReady, deltaStatus);
    auto row = decoder.row();
    TEST_ASSERT_EQUAL_UINT16(20, row.x);
    TEST_ASSERT_EQUAL_UINT16(10, row.y);
    TEST_ASSERT_EQUAL_UINT16(2, row.width);
    TEST_ASSERT_EQUAL_HEX16(0x07e0, row.pixels[0] | (row.pixels[1] << 8));
    decoder.consumeRow();
    TEST_ASSERT_EQUAL_INT(AnimationDecodeStatus::FrameComplete, decoder.step());
    TEST_ASSERT_EQUAL_UINT16(80, decoder.frameInfo().delayMs);
    TEST_ASSERT_EQUAL_INT(AnimationDecodeStatus::Progress, decoder.step()); // advance directory
    AnimationDecodeStatus holdStatus = AnimationDecodeStatus::Progress;
    while (holdStatus == AnimationDecodeStatus::Progress) holdStatus = decoder.step();
    TEST_ASSERT_EQUAL_INT(AnimationDecodeStatus::FrameComplete, holdStatus); // hold
    TEST_ASSERT_EQUAL_INT(AnimationDecodeStatus::AnimationComplete, decoder.step());
    TEST_ASSERT_EQUAL_UINT16(90, decoder.frameInfo().delayMs);
    TEST_ASSERT_TRUE(storage.largestRead <= 512);
}

void testV2DecoderRejectsBadDirectoryAndRowPayloads() {
    DecoderStorage storage;
    writeTestAnimation(storage);
    std::array<std::uint8_t, NBIF_V2_ROW_BUFFER_BYTES> output{};
    AnimationV2Metadata metadata{};

    auto malformedDirectory = storage.bytes;
    malformedDirectory[NBIF_V2_HEADER_BYTES + 16] = 1;
    storage.bytes = malformedDirectory;
    AnimationDecoder badDirectory(storage, output.data(), output.size());
    TEST_ASSERT_FALSE(badDirectory.open(metadata));

    writeTestAnimation(storage);
    storage.bytes[NBIF_V2_HEADER_BYTES + 3 * NBIF_V2_DIRECTORY_ENTRY_BYTES + 4 + 3] = 99;
    AnimationDecoder badRow(storage, output.data(), output.size());
    TEST_ASSERT_TRUE(badRow.open(metadata));
    AnimationDecodeStatus badRowStatus = AnimationDecodeStatus::Progress;
    while (badRowStatus == AnimationDecodeStatus::Progress) badRowStatus = badRow.step();
    TEST_ASSERT_EQUAL_INT(AnimationDecodeStatus::Error, badRowStatus);
    TEST_ASSERT_FALSE(badRow.valid());

    writeTestAnimation(storage);
    storage.bytes.pop_back();
    AnimationDecoder truncated(storage, output.data(), output.size());
    TEST_ASSERT_FALSE(truncated.open(metadata));
}

} // namespace

int main() {
    UNITY_BEGIN();
    RUN_TEST(testV2DecoderStreamsAllRowCodecsDeltasAndHolds);
    RUN_TEST(testV2DecoderRejectsBadDirectoryAndRowPayloads);
    return UNITY_END();
}
