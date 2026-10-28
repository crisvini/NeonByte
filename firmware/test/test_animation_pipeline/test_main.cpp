#define ARDUINO_ARCH_ESP8266 1
#define NEONBYTE_ENABLE_DISPLAY 1

#include "neonbyte/animation_upload.h"
#include "neonbyte/animation_decoder.h"
#include "neonbyte/esp8266/display.h"
#include "neonbyte/hash_job.h"
#include "neonbyte/scene_manager.h"
#include "../test_display/fakes/neonbyte/esp8266/storage.h"
#include "../../src/esp8266/display.cpp"

#include <unity.h>

#include <algorithm>
#include <array>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

using namespace neonbyte;

namespace {

constexpr std::uint32_t UPLOAD_ID = 0x10203040;
constexpr std::string_view ZERO_HASH = "0000000000000000000000000000000000000000000000000000000000000000";

class TestClock final : public Clock {
public:
    std::uint64_t now = 0;
    std::uint64_t monotonicMillis() const override { return now; }
    std::uint64_t unixMillis() const override { return 1'800'000'000'000; }
};

class TestDigest final : public ContentDigest {
public:
    void reset() override { value_ = 2166136261u; }
    void update(const std::uint8_t* bytes, std::size_t length) override {
        for (std::size_t index = 0; index < length; ++index) {
            value_ = (value_ ^ bytes[index]) * 16777619u;
        }
    }
    void finish(char* hex64) override {
        constexpr char digits[] = "0123456789abcdef";
        std::fill_n(hex64, 64, '0');
        for (unsigned index = 0; index < 8; ++index) {
            const auto nibble = static_cast<std::uint8_t>((value_ >> ((7 - index) * 4)) & 0xf);
            hex64[56 + index] = digits[nibble];
        }
    }
private:
    std::uint32_t value_ = 0;
};

class CandidateSource final : public AnimationSource {
public:
    explicit CandidateSource(const PersistentStorage& storage) : storage_(storage) {}
    std::uint32_t size() const override { return storage_.animationCandidateSize(); }
    bool readAt(std::uint32_t offset, std::uint8_t* bytes, std::size_t length) const override {
        return storage_.readAnimationCandidateAt(offset, bytes, length);
    }
private:
    const PersistentStorage& storage_;
};

void append16(std::vector<std::uint8_t>& bytes, std::uint16_t value) {
    bytes.push_back(static_cast<std::uint8_t>(value));
    bytes.push_back(static_cast<std::uint8_t>(value >> 8));
}

void write32(std::vector<std::uint8_t>& bytes, std::size_t offset, std::uint32_t value) {
    for (unsigned index = 0; index < 4; ++index) {
        bytes[offset + index] = static_cast<std::uint8_t>(value >> (index * 8));
    }
}

void appendRow(std::vector<std::uint8_t>& bytes, std::uint8_t y, std::uint8_t x,
               std::uint8_t width, const std::vector<std::uint8_t>& payload) {
    bytes.push_back(y);
    bytes.push_back(x);
    bytes.push_back(width);
    bytes.push_back(3); // Indexed RLE.
    append16(bytes, static_cast<std::uint16_t>(payload.size()));
    bytes.insert(bytes.end(), payload.begin(), payload.end());
}

std::vector<std::uint8_t> makeV2Animation() {
    std::vector<std::uint8_t> keyframe;
    append16(keyframe, 0xf800);
    for (unsigned y = 0; y < 240; ++y) {
        appendRow(keyframe, static_cast<std::uint8_t>(y), 0, 240, {0xff, 0, 0xef, 0});
    }

    std::vector<std::uint8_t> delta;
    append16(delta, 0x07e0);
    appendRow(delta, 10, 20, 2, {0x81, 0});

    const std::uint32_t dataOffset = NBIF_V2_HEADER_BYTES + 2 * NBIF_V2_DIRECTORY_ENTRY_BYTES;
    const std::uint32_t deltaOffset = dataOffset + static_cast<std::uint32_t>(keyframe.size());
    const std::uint32_t fileBytes = deltaOffset + static_cast<std::uint32_t>(delta.size());
    std::vector<std::uint8_t> bytes(fileBytes, 0);
    bytes[0] = 'N'; bytes[1] = 'B'; bytes[2] = 'I'; bytes[3] = 'F'; bytes[4] = 2;
    bytes[6] = 240; bytes[8] = 240; bytes[10] = 2;
    write32(bytes, 12, 100);
    write32(bytes, 16, fileBytes);

    auto writeDirectoryEntry = [&](std::size_t offset, std::uint32_t recordOffset,
                                   std::uint32_t recordBytes, std::uint16_t delay,
                                   std::uint8_t kind, std::uint16_t paletteCount,
                                   std::uint16_t rowCount) {
        write32(bytes, offset, recordOffset);
        write32(bytes, offset + 4, recordBytes);
        bytes[offset + 8] = static_cast<std::uint8_t>(delay);
        bytes[offset + 9] = static_cast<std::uint8_t>(delay >> 8);
        bytes[offset + 10] = kind;
        bytes[offset + 11] = paletteCount ? 1 : 0;
        bytes[offset + 12] = static_cast<std::uint8_t>(paletteCount);
        bytes[offset + 14] = static_cast<std::uint8_t>(rowCount);
        bytes[offset + 15] = static_cast<std::uint8_t>(rowCount >> 8);
    };
    writeDirectoryEntry(24, dataOffset, keyframe.size(), 40, 0, 1, 240);
    writeDirectoryEntry(44, deltaOffset, delta.size(), 60, 1, 1, 1);
    std::copy(keyframe.begin(), keyframe.end(), bytes.begin() + dataOffset);
    std::copy(delta.begin(), delta.end(), bytes.begin() + deltaOffset);
    return bytes;
}

std::vector<std::uint8_t> makeV1Animation() {
    std::vector<std::uint8_t> bytes{'N', 'B', 'I', 'F', 1, 240, 0, 240, 0, 1, 0};
    append16(bytes, 100);
    for (unsigned pixel = 0; pixel < 240 * 240; ++pixel) append16(bytes, 0x1234);
    return bytes;
}

std::string expectedTestDigest(const std::vector<std::uint8_t>& bytes) {
    TestDigest digest;
    digest.reset();
    digest.update(bytes.data(), bytes.size());
    char value[64];
    digest.finish(value);
    return {value, sizeof(value)};
}

void serviceBackgroundLoop(TestClock& clock, SceneManager& scenes, unsigned& wifiServiceTicks) {
    ++clock.now;
    scenes.heartbeat();
    ++wifiServiceTicks;
    TEST_ASSERT_TRUE(scenes.currentState().agentAvailable);
    TEST_ASSERT_EQUAL_INT(ActiveScene::spotify, scenes.currentState().activeScene);
}

void uploadInBoundedChunks(AnimationUploadSession& session, const std::vector<std::uint8_t>& bytes,
                           TestClock& clock, SceneManager& scenes, unsigned& wifiServiceTicks) {
    TEST_ASSERT_EQUAL_INT(AnimationChunkResult::Accepted,
        session.begin(UPLOAD_ID, static_cast<std::uint32_t>(bytes.size()), expectedTestDigest(bytes), clock.now, 0));
    std::array<std::uint8_t, ANIMATION_UPLOAD_WRITE_BUDGET_BYTES> scratch{};
    for (std::size_t offset = 0; offset < bytes.size();) {
        const auto length = std::min<std::size_t>(ANIMATION_UPLOAD_MAX_CHUNK_BYTES, bytes.size() - offset);
        TEST_ASSERT_EQUAL_INT(AnimationChunkResult::Pending,
            session.queueChunk(UPLOAD_ID, static_cast<std::uint32_t>(offset), bytes.data() + offset, length, clock.now));
        AnimationChunkResult result = AnimationChunkResult::Pending;
        while (result == AnimationChunkResult::Pending) {
            result = session.step(clock.now, scratch.data(), scratch.size());
            serviceBackgroundLoop(clock, scenes, wifiServiceTicks);
        }
        TEST_ASSERT_EQUAL_INT(AnimationChunkResult::Accepted, result);
        offset += length;
    }
    TEST_ASSERT_EQUAL_INT(AnimationChunkResult::Accepted, session.complete(UPLOAD_ID, clock.now));
}

void verifyStagedAnimation(AnimationUploadSession& session, PersistentStorage& storage,
                            TestClock& clock, SceneManager& scenes, unsigned& wifiServiceTicks) {
    TestDigest digest;
    CandidateSource candidate(storage);
    HashJob hash(candidate, digest, 0, candidate.size());
    std::array<std::uint8_t, 512> hashBuffer{};
    HashStep hashResult = HashStep::pending;
    while (hashResult == HashStep::pending) {
        hashResult = hash.step(hashBuffer.data(), hashBuffer.size());
        serviceBackgroundLoop(clock, scenes, wifiServiceTicks);
    }
    TEST_ASSERT_EQUAL_INT(HashStep::complete, hashResult);
    char actualHash[64];
    digest.finish(actualHash);
    TEST_ASSERT_EQUAL_STRING_LEN(session.sha256().data(), actualHash, 64);

    std::array<std::uint8_t, NBIF_V2_ROW_BUFFER_BYTES> rowBuffer{};
    std::array<std::uint8_t, NBIF_V2_ROW_BUFFER_BYTES> encodedBuffer{};
    AnimationDecoder decoder(candidate, rowBuffer.data(), rowBuffer.size(), encodedBuffer.data(), encodedBuffer.size());
    AnimationV2Metadata metadata{};
    TEST_ASSERT_TRUE(decoder.open(metadata));
    TEST_ASSERT_EQUAL_UINT16(240, metadata.width);
    TEST_ASSERT_EQUAL_UINT16(240, metadata.height);
    TEST_ASSERT_EQUAL_UINT16(2, metadata.frameCount);
    TEST_ASSERT_EQUAL_UINT32(100, metadata.durationMs);
    std::array<std::uint16_t, 2> delays{};
    unsigned frames = 0;
    while (true) {
        const auto status = decoder.step();
        serviceBackgroundLoop(clock, scenes, wifiServiceTicks);
        if (status == AnimationDecodeStatus::Progress) continue;
        if (status == AnimationDecodeStatus::RowReady) {
            decoder.consumeRow();
            continue;
        }
        if (status == AnimationDecodeStatus::FrameComplete) {
            delays[frames++] = decoder.frameInfo().delayMs;
            continue;
        }
        TEST_ASSERT_EQUAL_INT(AnimationDecodeStatus::AnimationComplete, status);
        break;
    }
    TEST_ASSERT_EQUAL_UINT32(2, frames);
    TEST_ASSERT_EQUAL_UINT16(40, delays[0]);
    TEST_ASSERT_EQUAL_UINT16(60, delays[1]);
    session.markReady(clock.now);
    TEST_ASSERT_EQUAL_INT(AnimationUploadState::Ready, session.state());
}

void testV2UploadValidationAtomicReplacementAndPlaybackPipeline() {
    display_test::panelState = {};
    PersistentStorage storage;
    storage.animationBytes = makeV1Animation();
    const auto oldAnimation = storage.animationBytes;
    TestClock clock;
    SceneManager scenes(clock, storage);
    TEST_ASSERT_TRUE(scenes.setMode(DisplayMode::spotify));
    NowPlaying track;
    track.trackId.bytes[0] = 't'; track.trackId.length = 1;
    track.title.bytes[0] = 'T'; track.title.length = 1;
    track.artist.bytes[0] = 'A'; track.artist.length = 1;
    track.isPlaying = true; track.durationMs = 60'000;
    scenes.updateNowPlaying(track);
    scenes.heartbeat();

    AnimationUploadSession session(storage);
    unsigned wifiServiceTicks = 0;
    const auto replacement = makeV2Animation();
    uploadInBoundedChunks(session, replacement, clock, scenes, wifiServiceTicks);
    TEST_ASSERT_EQUAL_INT(AnimationUploadState::Verifying, session.state());
    TEST_ASSERT_EQUAL_UINT32(oldAnimation.size(), storage.animationBytes.size());
    TEST_ASSERT_EQUAL_UINT32(0, storage.animationRevision);
    TEST_ASSERT_TRUE(storage.animationCandidateSize() == replacement.size());
    verifyStagedAnimation(session, storage, clock, scenes, wifiServiceTicks);
    TEST_ASSERT_EQUAL_UINT32(oldAnimation.size(), storage.animationBytes.size());
    TEST_ASSERT_EQUAL_INT(0, std::memcmp(oldAnimation.data(), storage.animationBytes.data(), oldAnimation.size()));
    TEST_ASSERT_TRUE(wifiServiceTicks > 200);

    TEST_ASSERT_TRUE(scenes.setMode(DisplayMode::gif));
    DeviceDisplay display(storage);
    display.begin();
    auto& panel = display_test::panelState;
    const auto clearCount = panel.screenClears;
    for (unsigned tick = 0; tick < 240; ++tick) display.tick(scenes, 0);
    TEST_ASSERT_EQUAL_UINT32(240, panel.rows.size());
    TEST_ASSERT_EQUAL_UINT32(1, storage.animationRevision);
    session.markInstalled(clock.now); // The authenticated status route observes the new storage generation.
    TEST_ASSERT_EQUAL_INT(AnimationUploadState::Installed, session.state());
    TEST_ASSERT_EQUAL_UINT32(clearCount, panel.screenClears);

    for (unsigned tick = 0; tick < 300 && panel.rows.size() < 480; ++tick) display.tick(scenes, 0);
    TEST_ASSERT_EQUAL_UINT32(480, panel.rows.size());
    for (unsigned y = 0; y < 240; ++y) {
        TEST_ASSERT_EQUAL_INT(y, panel.rows[240 + y].y);
        TEST_ASSERT_EQUAL_INT(0, panel.rows[240 + y].x);
        TEST_ASSERT_EQUAL_UINT32(240, panel.rows[240 + y].pixelCount);
        TEST_ASSERT_EQUAL_HEX16(0xf800, panel.rows[240 + y].firstPixel);
    }
    display.tick(scenes, 0); // Finish the keyframe record without clearing the panel.
    display.tick(scenes, 39);
    TEST_ASSERT_EQUAL_UINT32(480, panel.rows.size());
    for (unsigned tick = 0; tick < 10 && panel.rows.size() < 481; ++tick) display.tick(scenes, 40);
    TEST_ASSERT_EQUAL_UINT32(481, panel.rows.size());
    TEST_ASSERT_EQUAL_INT(20, panel.rows.back().x);
    TEST_ASSERT_EQUAL_INT(10, panel.rows.back().y);
    TEST_ASSERT_EQUAL_UINT32(2, panel.rows.back().pixelCount);
    TEST_ASSERT_EQUAL_HEX16(0x07e0, panel.rows.back().firstPixel);
    TEST_ASSERT_EQUAL_UINT32(clearCount, panel.screenClears);
}

void testInvalidV2CandidateIsDiscardedAndLeavesInstalledV1Untouched() {
    PersistentStorage storage;
    storage.animationBytes = makeV1Animation();
    const auto oldAnimation = storage.animationBytes;
    AnimationUploadSession session(storage);
    std::vector<std::uint8_t> malformed{'N', 'B', 'I', 'F', 2};
    malformed.resize(NBIF_V2_HEADER_BYTES, 0);
    TEST_ASSERT_EQUAL_INT(AnimationChunkResult::Accepted,
        session.begin(UPLOAD_ID, malformed.size(), ZERO_HASH, 0, storage.animationRevision));
    TEST_ASSERT_EQUAL_INT(AnimationChunkResult::Pending,
        session.queueChunk(UPLOAD_ID, 0, malformed.data(), malformed.size(), 0));
    std::array<std::uint8_t, 512> scratch{};
    TEST_ASSERT_EQUAL_INT(AnimationChunkResult::Accepted, session.step(0, scratch.data(), scratch.size()));
    TEST_ASSERT_EQUAL_INT(AnimationChunkResult::Accepted, session.complete(UPLOAD_ID, 0));
    std::array<std::uint8_t, NBIF_V2_ROW_BUFFER_BYTES> rowBuffer{};
    std::array<std::uint8_t, NBIF_V2_ROW_BUFFER_BYTES> encodedBuffer{};
    CandidateSource candidate(storage);
    AnimationDecoder decoder(candidate, rowBuffer.data(), rowBuffer.size(), encodedBuffer.data(), encodedBuffer.size());
    AnimationV2Metadata metadata{};
    TEST_ASSERT_FALSE(decoder.open(metadata));
    session.fail(AnimationUploadError::InvalidAnimation, 1);
    TEST_ASSERT_EQUAL_INT(AnimationUploadState::Failed, session.state());
    TEST_ASSERT_EQUAL_INT(AnimationUploadError::InvalidAnimation, session.error());
    TEST_ASSERT_TRUE(storage.candidate.empty());
    TEST_ASSERT_EQUAL_UINT32(oldAnimation.size(), storage.animationBytes.size());
    TEST_ASSERT_EQUAL_INT(0, std::memcmp(oldAnimation.data(), storage.animationBytes.data(), oldAnimation.size()));
}

} // namespace

int main() {
    UNITY_BEGIN();
    RUN_TEST(testV2UploadValidationAtomicReplacementAndPlaybackPipeline);
    RUN_TEST(testInvalidV2CandidateIsDiscardedAndLeavesInstalledV1Untouched);
    return UNITY_END();
}
