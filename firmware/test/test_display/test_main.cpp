#define ARDUINO_ARCH_ESP8266 1
#define NEONBYTE_ENABLE_DISPLAY 1

#include "neonbyte/esp8266/display.h"
#include "../../src/esp8266/display.cpp"

#include <unity.h>

#include <cstdint>
#include <vector>

using namespace neonbyte;

namespace {

class TestClock final : public Clock {
public:
    std::uint64_t now = 0;
    std::uint64_t monotonicMillis() const override { return now; }
    std::uint64_t unixMillis() const override { return 0; }
};

void appendLittleEndian16(std::vector<std::uint8_t>& bytes, std::uint16_t value) {
    bytes.push_back(static_cast<std::uint8_t>(value & 0xff));
    bytes.push_back(static_cast<std::uint8_t>(value >> 8));
}

void appendV2Row(std::vector<std::uint8_t>& bytes, std::uint8_t y, std::uint8_t x,
                 std::uint8_t width, std::uint8_t codec, const std::vector<std::uint8_t>& payload) {
    bytes.push_back(y); bytes.push_back(x); bytes.push_back(width); bytes.push_back(codec);
    appendLittleEndian16(bytes, static_cast<std::uint16_t>(payload.size()));
    bytes.insert(bytes.end(), payload.begin(), payload.end());
}

void installV2Animation(PersistentStorage& storage) {
    std::vector<std::uint8_t> keyframe;
    for (unsigned y = 0; y < 240; ++y) {
        appendV2Row(keyframe, static_cast<std::uint8_t>(y), 0, 240, 1,
            {0xff, 0x00, 0xf8, 0xef, 0x00, 0xf8});
    }
    std::vector<std::uint8_t> delta;
    appendLittleEndian16(delta, 0x07e0);
    appendV2Row(delta, 10, 20, 2, 3, {0x81, 0});
    constexpr std::uint32_t directoryOffset = 24;
    constexpr std::uint32_t recordOffset = directoryOffset + 3 * 20;
    const auto secondOffset = recordOffset + static_cast<std::uint32_t>(keyframe.size());
    const auto totalBytes = secondOffset + static_cast<std::uint32_t>(delta.size());
    storage.animationBytes.assign(totalBytes, 0);
    auto& bytes = storage.animationBytes;
    bytes[0] = 'N'; bytes[1] = 'B'; bytes[2] = 'I'; bytes[3] = 'F'; bytes[4] = 2;
    bytes[6] = 240; bytes[8] = 240; bytes[10] = 3;
    bytes[12] = 44; bytes[13] = 1; bytes[16] = static_cast<std::uint8_t>(totalBytes);
    bytes[17] = static_cast<std::uint8_t>(totalBytes >> 8);
    bytes[18] = static_cast<std::uint8_t>(totalBytes >> 16);
    auto writeEntry = [&](std::size_t offset, std::uint32_t dataOffset, std::uint32_t recordBytes,
                          std::uint16_t delay, std::uint8_t kind, std::uint8_t indexBits,
                          std::uint16_t paletteCount, std::uint16_t rowCount) {
        auto put32 = [&](std::size_t at, std::uint32_t value) {
            bytes[at] = static_cast<std::uint8_t>(value);
            bytes[at + 1] = static_cast<std::uint8_t>(value >> 8);
            bytes[at + 2] = static_cast<std::uint8_t>(value >> 16);
            bytes[at + 3] = static_cast<std::uint8_t>(value >> 24);
        };
        put32(offset, dataOffset); put32(offset + 4, recordBytes);
        bytes[offset + 8] = static_cast<std::uint8_t>(delay);
        bytes[offset + 9] = static_cast<std::uint8_t>(delay >> 8);
        bytes[offset + 10] = kind; bytes[offset + 11] = indexBits;
        bytes[offset + 12] = static_cast<std::uint8_t>(paletteCount);
        bytes[offset + 13] = static_cast<std::uint8_t>(paletteCount >> 8);
        bytes[offset + 14] = static_cast<std::uint8_t>(rowCount);
        bytes[offset + 15] = static_cast<std::uint8_t>(rowCount >> 8);
    };
    writeEntry(24, recordOffset, keyframe.size(), 50, 0, 0, 0, 240);
    writeEntry(44, secondOffset, delta.size(), 50, 1, 1, 1, 1);
    writeEntry(64, totalBytes, 0, 200, 2, 0, 0, 0);
    std::copy(keyframe.begin(), keyframe.end(), bytes.begin() + recordOffset);
    std::copy(delta.begin(), delta.end(), bytes.begin() + secondOffset);
}

void appendFrame(std::vector<std::uint8_t>& bytes, std::uint16_t delayMs, std::uint16_t pixel) {
    appendLittleEndian16(bytes, delayMs);
    for (std::uint32_t index = 0; index < ANIMATION_FRAME_PIXEL_BYTES / 2; ++index) {
        appendLittleEndian16(bytes, pixel);
    }
}

void installTwoFrameAnimation(PersistentStorage& storage) {
    storage.animationBytes = {'N', 'B', 'I', 'F', 1, 240, 0, 240, 0, 2, 0};
    appendFrame(storage.animationBytes, 50, 0x1234);
    appendFrame(storage.animationBytes, 70, 0xabcd);
}

void tickFrame(DeviceDisplay& display, const SceneManager& scenes, std::uint64_t nowMs,
               std::uint16_t expectedPixel) {
    const auto initialRows = display_test::panelState.rows.size();
    for (std::uint16_t row = 0; row < 240; ++row) display.tick(scenes, nowMs);
    TEST_ASSERT_EQUAL_UINT32(initialRows + 240, display_test::panelState.rows.size());
    for (std::uint16_t row = 0; row < 240; ++row) {
        const auto& write = display_test::panelState.rows[initialRows + row];
        TEST_ASSERT_EQUAL_INT(row, write.y);
        TEST_ASSERT_EQUAL_UINT32(240, write.pixelCount);
        TEST_ASSERT_EQUAL_UINT16(expectedPixel, write.firstPixel);
    }
}

void testGifFrameDelayAndLoopingUseDeviceDisplayTick() {
    display_test::panelState.rows.clear();
    PersistentStorage storage;
    installTwoFrameAnimation(storage);
    TestClock clock;
    SceneManager scenes(clock, storage);
    TEST_ASSERT_TRUE(scenes.setMode(DisplayMode::gif));
    DeviceDisplay display(storage);
    display.begin();

    tickFrame(display, scenes, 0, 0x1234);
    display.tick(scenes, 49);
    TEST_ASSERT_EQUAL_UINT32(240, display_test::panelState.rows.size());

    tickFrame(display, scenes, 50, 0xabcd);
    display.tick(scenes, 119);
    TEST_ASSERT_EQUAL_UINT32(480, display_test::panelState.rows.size());

    tickFrame(display, scenes, 120, 0x1234);
}

void testV2PlayerDrawsChangedSpansWithoutClearingAndRestartsAtKeyframe() {
    display_test::panelState = {};
    PersistentStorage storage; installV2Animation(storage);
    TestClock clock; SceneManager scenes(clock, storage);
    TEST_ASSERT_TRUE(scenes.setMode(DisplayMode::gif));
    DeviceDisplay display(storage); display.begin();
    auto& panel = display_test::panelState;
    const auto initialClears = panel.screenClears;
    for (unsigned tick = 0; tick < 300 && panel.rows.size() < 240; ++tick) display.tick(scenes, 0);
    TEST_ASSERT_EQUAL_UINT32(240, panel.rows.size());
    for (unsigned y = 0; y < 240; ++y) {
        TEST_ASSERT_EQUAL_INT(0, panel.rows[y].x);
        TEST_ASSERT_EQUAL_INT(y, panel.rows[y].y);
        TEST_ASSERT_EQUAL_UINT32(240, panel.rows[y].pixelCount);
        TEST_ASSERT_EQUAL_HEX16(0xf800, panel.rows[y].firstPixel);
    }
    display.tick(scenes, 0); // Complete the keyframe before its 50 ms hold.
    for (unsigned tick = 0; tick < 10; ++tick) display.tick(scenes, 49);
    TEST_ASSERT_EQUAL_UINT32(240, panel.rows.size());
    for (unsigned tick = 0; tick < 10 && panel.rows.size() < 241; ++tick) display.tick(scenes, 50);
    TEST_ASSERT_EQUAL_UINT32(241, panel.rows.size());
    TEST_ASSERT_EQUAL_INT(20, panel.rows.back().x);
    TEST_ASSERT_EQUAL_INT(10, panel.rows.back().y);
    TEST_ASSERT_EQUAL_UINT32(2, panel.rows.back().pixelCount);
    TEST_ASSERT_EQUAL_HEX16(0x07e0, panel.rows.back().firstPixel);
    display.tick(scenes, 100); // Complete the delta record.
    display.tick(scenes, 100); // Advance the decoder to the hold record.
    display.tick(scenes, 100); // Start and complete the hold record.
    for (unsigned tick = 0; tick < 20; ++tick) display.tick(scenes, 299);
    TEST_ASSERT_EQUAL_UINT32(241, panel.rows.size());
    for (unsigned tick = 0; tick < 300 && panel.rows.size() < 481; ++tick) display.tick(scenes, 300);
    TEST_ASSERT_EQUAL_UINT32(481, panel.rows.size());
    TEST_ASSERT_EQUAL_INT(0, panel.rows[241].x);
    TEST_ASSERT_EQUAL_INT(0, panel.rows[241].y);
    TEST_ASSERT_EQUAL_INT(0, panel.rows.back().x);
    TEST_ASSERT_EQUAL_INT(239, panel.rows.back().y);
    TEST_ASSERT_EQUAL_HEX16(0xf800, panel.rows.back().firstPixel);
    TEST_ASSERT_EQUAL_UINT32(initialClears, panel.screenClears);
}

void testV2CandidatePromotionWaitsForFrameBoundaryAndRestartsAtKeyframe() {
    display_test::panelState = {};
    PersistentStorage storage; installV2Animation(storage);
    TestClock clock; SceneManager scenes(clock, storage);
    TEST_ASSERT_TRUE(scenes.setMode(DisplayMode::gif));
    DeviceDisplay display(storage); display.begin();
    auto& panel = display_test::panelState;
    for (unsigned tick = 0; tick < 300 && panel.rows.size() < 240; ++tick) display.tick(scenes, 0);
    TEST_ASSERT_EQUAL_UINT32(240, panel.rows.size());
    display.tick(scenes, 0); // Complete the keyframe before its 50 ms hold.
    storage.promotionPending = true;
    for (unsigned tick = 0; tick < 10; ++tick) display.tick(scenes, 49);
    TEST_ASSERT_TRUE(storage.promotionPending);
    TEST_ASSERT_EQUAL_UINT32(240, panel.rows.size());
    for (unsigned tick = 0; tick < 10 && panel.rows.size() < 241; ++tick) display.tick(scenes, 50);
    TEST_ASSERT_EQUAL_UINT32(241, panel.rows.size());
    TEST_ASSERT_TRUE(storage.promotionPending);
    display.tick(scenes, 100); // Finish the delta, then promote at this frame boundary.
    TEST_ASSERT_FALSE(storage.promotionPending);
    TEST_ASSERT_EQUAL_UINT32(1, storage.animationRevision);
    for (unsigned tick = 0; tick < 320 && panel.rows.size() < 481; ++tick) display.tick(scenes, 100);
    TEST_ASSERT_EQUAL_UINT32(481, panel.rows.size());
    TEST_ASSERT_EQUAL_INT(0, panel.rows[241].x);
    TEST_ASSERT_EQUAL_INT(0, panel.rows[241].y);
    TEST_ASSERT_EQUAL_HEX16(0xf800, panel.rows[241].firstPixel);
    TEST_ASSERT_EQUAL_UINT32(1, panel.screenClears);
}

void testV2PlayerReopensFromKeyframeAfterAStorageReadFailure() {
    display_test::panelState = {};
    PersistentStorage storage; installV2Animation(storage);
    TestClock clock; SceneManager scenes(clock, storage);
    TEST_ASSERT_TRUE(scenes.setMode(DisplayMode::gif));
    DeviceDisplay display(storage); display.begin();
    auto& panel = display_test::panelState;
    for (unsigned tick = 0; tick < 300 && panel.rows.size() < 240; ++tick) display.tick(scenes, 0);
    TEST_ASSERT_EQUAL_UINT32(240, panel.rows.size());
    display.tick(scenes, 0); // Finish the first keyframe.
    storage.failAnimationReads = true;
    display.tick(scenes, 50); // Advance to the second frame.
    display.tick(scenes, 50); // Start its palette.
    display.tick(scenes, 50); // Encounter the injected read failure.
    storage.failAnimationReads = false;
    for (unsigned tick = 0; tick < 320 && panel.rows.size() < 480; ++tick) display.tick(scenes, 51);
    TEST_ASSERT_EQUAL_UINT32(480, panel.rows.size());
    TEST_ASSERT_EQUAL_INT(0, panel.rows[240].x);
    TEST_ASSERT_EQUAL_INT(0, panel.rows[240].y);
    TEST_ASSERT_EQUAL_HEX16(0xf800, panel.rows[240].firstPixel);
}

void testSlowFrameRenderingDoesNotAddASecondFullDelay() {
    display_test::panelState.rows.clear();
    PersistentStorage storage;
    installTwoFrameAnimation(storage);
    TestClock clock;
    SceneManager scenes(clock, storage);
    TEST_ASSERT_TRUE(scenes.setMode(DisplayMode::gif));
    DeviceDisplay display(storage);
    display.begin();

    for (std::uint16_t row = 0; row < 240; ++row) display.tick(scenes, row);
    TEST_ASSERT_EQUAL_UINT32(240, display_test::panelState.rows.size());
    display.tick(scenes, 240);
    TEST_ASSERT_EQUAL_UINT32(241, display_test::panelState.rows.size());
    TEST_ASSERT_EQUAL_INT(0, display_test::panelState.rows.back().y);
    TEST_ASSERT_EQUAL_UINT16(0xabcd, display_test::panelState.rows.back().firstPixel);
}

void testDisplayInitializationUsesBoundedSpiAndRetainsProvisionalProfile() {
    display_test::panelState = {};
    PersistentStorage storage;
    DeviceDisplay display(storage);
    display.begin();
    TEST_ASSERT_EQUAL_UINT32(20000000, display_test::panelState.initializationFrequency);
    TEST_ASSERT_EQUAL_UINT32(20000000, display_test::panelState.drawingFrequency);
    TEST_ASSERT_EQUAL_UINT8(SPI_MODE3, display_test::panelState.mode);
    TEST_ASSERT_TRUE(display_test::panelState.inverted);
}

void testDisplayHalfTurnUsesRgbWithoutOverridingRotation() {
    display_test::panelState = {};
    PersistentStorage storage;
    DeviceDisplay display(storage);
    display.begin();
    TEST_ASSERT_EQUAL_UINT8(2, display_test::panelState.rotation);
    // RGB is selected; rotation, offsets, and axis orientation stay unchanged.
    TEST_ASSERT_EQUAL_HEX8(0x00, display_test::panelState.madctl);
}

void setText(FixedText& target, std::string_view value) {
    std::copy(value.begin(), value.end(), target.bytes.begin());
    target.length = value.size();
}

NowPlaying track() {
    NowPlaying value;
    setText(value.trackId, "track"); setText(value.title, "Title"); setText(value.artist, "Artist");
    value.isPlaying = true; value.durationMs = 180000;
    return value;
}

void testSpotifyStreamsLargerCoverAndDoesNotRedrawOnProgress() {
    display_test::panelState = {};
    PersistentStorage storage;
    for (unsigned y=0; y<240; ++y) for (unsigned x=0; x<240; ++x) appendLittleEndian16(storage.coverBytes, y*240+x);
    TestClock clock; SceneManager scenes(clock, storage);
    auto value = track(); scenes.heartbeat(); scenes.updateNowPlaying(value);
    DeviceDisplay display(storage); display.begin();
    for (unsigned row=0; row<176; ++row) display.tick(scenes, row);
    const auto& panel = display_test::panelState;
    TEST_ASSERT_EQUAL_UINT32(176, panel.rows.size());
    for (unsigned row=0; row<176; ++row) {
        const auto& write = panel.rows[row];
        TEST_ASSERT_EQUAL_INT(32, write.x); TEST_ASSERT_EQUAL_INT(4+row, write.y);
        TEST_ASSERT_EQUAL_UINT32(176, write.pixelCount);
        TEST_ASSERT_EQUAL_UINT32((row*240/176)*480, storage.coverReads[row]);
        for (unsigned x=0; x<176; ++x) TEST_ASSERT_EQUAL_UINT16((row*240/176)*240+(x*240/176), write.pixels[x]);
    }
    const auto clears = panel.screenClears;
    const auto texts = panel.texts.size(), rects = panel.rectangles.size();
    for (unsigned now=1000; now<10000; now+=1000) {
        value.progressMs = now; scenes.updateNowPlaying(value); display.tick(scenes, now);
    }
    TEST_ASSERT_EQUAL_UINT32(clears, panel.screenClears);
    TEST_ASSERT_EQUAL_UINT32(texts, panel.texts.size());
    TEST_ASSERT_EQUAL_UINT32(rects, panel.rectangles.size());
    TEST_ASSERT_EQUAL_UINT32(176, panel.rows.size());
}

void testSpotifyMetadataChangesInvalidateOnlyTheirOwnField() {
    display_test::panelState = {};
    PersistentStorage storage; DeviceDisplay display(storage); display.begin();
    auto value = track(); display.showSpotify(value, 0);
    auto& panel = display_test::panelState;
    const auto clears = panel.screenClears;
    panel.texts.clear(); panel.rectangles.clear();
    setText(value.title, "Corrected title"); display.showSpotify(value, 1000);
    TEST_ASSERT_EQUAL_UINT32(1, panel.texts.size());
    TEST_ASSERT_EQUAL_STRING("Corrected title", panel.texts[0].text.c_str());
    TEST_ASSERT_EQUAL_INT(190, panel.texts[0].y);
    TEST_ASSERT_EQUAL_UINT8(2, panel.texts[0].size);
    TEST_ASSERT_EQUAL_UINT32(1, panel.rectangles.size());
    TEST_ASSERT_EQUAL_INT(0, panel.rectangles[0].x);
    TEST_ASSERT_EQUAL_INT(190, panel.rectangles[0].y);
    TEST_ASSERT_EQUAL_INT(240, panel.rectangles[0].width);
    TEST_ASSERT_EQUAL_INT(20, panel.rectangles[0].height);
    panel.texts.clear(); panel.rectangles.clear();
    setText(value.artist, "Corrected artist"); display.showSpotify(value, 2000);
    TEST_ASSERT_EQUAL_UINT32(1, panel.texts.size());
    TEST_ASSERT_EQUAL_INT(211, panel.texts[0].y);
    TEST_ASSERT_EQUAL_UINT8(2, panel.texts[0].size);
    TEST_ASSERT_EQUAL_INT(211, panel.rectangles[0].y);
    TEST_ASSERT_EQUAL_UINT32(clears, panel.screenClears);
    panel.texts.clear(); panel.rectangles.clear();
    ++storage.assetRevision; display.showSpotify(value, 3000);
    TEST_ASSERT_TRUE(panel.texts.empty()); TEST_ASSERT_TRUE(panel.rectangles.empty());
    TEST_ASSERT_EQUAL_UINT32(clears, panel.screenClears);
}

void testSpotifyMarqueeWaitsForCoverAndMovesFieldsIndependently() {
    display_test::panelState = {};
    PersistentStorage storage; TestClock clock; SceneManager scenes(clock, storage);
    for (unsigned y = 0; y < 240; ++y) for (unsigned x = 0; x < 240; ++x)
        appendLittleEndian16(storage.coverBytes, static_cast<std::uint16_t>(y * 240 + x));
    auto value = track();
    setText(value.title, std::string(30, 'T'));
    setText(value.artist, "Short artist");
    scenes.heartbeat(); scenes.updateNowPlaying(value);
    DeviceDisplay display(storage); display.begin();
    for (unsigned row = 0; row < 176; ++row) display.tick(scenes, row * 20);
    auto& panel = display_test::panelState;
    TEST_ASSERT_EQUAL_UINT32(2, panel.texts.size());
    const auto initialRows = panel.rows.size();
    std::vector<std::uint16_t> coverPixels;
    for (unsigned y = 4; y < 180; ++y) for (unsigned x = 32; x < 208; ++x)
        coverPixels.push_back(panel.pixels[y * 240 + x]);
    display.tick(scenes, 4999);
    TEST_ASSERT_EQUAL_UINT32(2, panel.texts.size());
    display.tick(scenes, 5000);
    TEST_ASSERT_GREATER_THAN_UINT32(2, panel.texts.size());
    TEST_ASSERT_EQUAL_INT(190, panel.rectangles.back().y);
    TEST_ASSERT_EQUAL_UINT32(initialRows, panel.rows.size());
    for (const auto& rect : panel.rectangles) TEST_ASSERT_TRUE(rect.y >= 190);
    for (unsigned y = 4; y < 180; ++y) for (unsigned x = 32; x < 208; ++x)
        TEST_ASSERT_EQUAL_HEX16(coverPixels[(y - 4) * 176 + x - 32], panel.pixels[y * 240 + x]);
}

void testMarqueePausesAtBothEndsAndRestartsOnMetadataAndCoverChanges() {
    display_test::panelState = {};
    PersistentStorage storage; TestClock clock; SceneManager scenes(clock, storage);
    auto value = track(); setText(value.title, std::string(20, 'T')); setText(value.artist, std::string(21, 'A'));
    scenes.heartbeat(); scenes.updateNowPlaying(value);
    DeviceDisplay display(storage); display.begin();
    for (unsigned row = 0; row < 176; ++row) display.tick(scenes, row);
    auto& panel = display_test::panelState;
    const auto coverRows = panel.rows.size();
    panel.texts.clear(); panel.rectangles.clear();
    display.tick(scenes, 1675); // Title moves first; artist remains independent.
    TEST_ASSERT_EQUAL_INT(190, panel.rectangles.back().y);
    display.tick(scenes, 1676);
    TEST_ASSERT_EQUAL_INT(211, panel.rectangles.back().y);
    for (unsigned step = 1; step < 6; ++step) {
        display.tick(scenes, 1675 + step * 125);
        display.tick(scenes, 1676 + step * 125);
    }
    const auto beforePause = panel.texts.size();
    display.tick(scenes, 2425); // Title reached its 16-pixel end at 2300.
    TEST_ASSERT_EQUAL_UINT32(beforePause, panel.texts.size());
    ++storage.assetRevision;
    const auto beforeCover = panel.texts.size();
    for (unsigned row = 0; row < 176; ++row) display.tick(scenes, 4000 + row * 20);
    TEST_ASSERT_EQUAL_UINT32(beforeCover, panel.texts.size());
    TEST_ASSERT_EQUAL_UINT32(coverRows + 176, panel.rows.size());
    display.tick(scenes, 9000);
    TEST_ASSERT_EQUAL_UINT32(beforeCover + 1, panel.texts.size());
    const auto rectCount = panel.rectangles.size(), textCount = panel.texts.size();
    setText(value.title, std::string(19, 'Z')); scenes.updateNowPlaying(value); display.tick(scenes, 9001);
    TEST_ASSERT_EQUAL_INT(190, panel.rectangles[rectCount].y);
    TEST_ASSERT_EQUAL_INT(8, panel.texts[textCount].x);
    for (const auto& rect : panel.rectangles) TEST_ASSERT_TRUE(rect.y >= 190);
    display.showGif();
    const auto reentryText = panel.texts.size();
    display.tick(scenes, 9002);
    TEST_ASSERT_EQUAL_INT(8, panel.texts[reentryText].x);
    TEST_ASSERT_EQUAL_INT(190, panel.texts[reentryText].y);
    TEST_ASSERT_EQUAL_INT(4, panel.rows.back().y);
}

void testMarqueeBoundaryAndUnicodeReplacement() {
    display_test::panelState = {};
    PersistentStorage storage; TestClock clock; SceneManager scenes(clock, storage);
    auto value = track(); setText(value.title, std::string(18, 'T'));
    setText(value.artist, std::string(18, 'A') + "\xc3\xa9");
    scenes.heartbeat(); scenes.updateNowPlaying(value);
    DeviceDisplay display(storage); display.begin();
    for (unsigned row = 0; row < 176; ++row) display.tick(scenes, row);
    auto& panel = display_test::panelState;
    TEST_ASSERT_EQUAL_STRING((std::string(18, 'A') + "?").c_str(), panel.texts[1].text.c_str());
    const auto textCount = panel.texts.size();
    display.tick(scenes, 1675);
    TEST_ASSERT_EQUAL_UINT32(textCount + 1, panel.texts.size());
    TEST_ASSERT_EQUAL_INT(211, panel.rectangles.back().y);
}

void testMarqueePausesAfterReturningToStart() {
    display_test::panelState = {};
    PersistentStorage storage; TestClock clock; SceneManager scenes(clock, storage);
    auto value = track(); setText(value.title, std::string(19, 'T'));
    scenes.heartbeat(); scenes.updateNowPlaying(value);
    DeviceDisplay display(storage); display.begin();
    for (unsigned row = 0; row < 176; ++row) display.tick(scenes, row);
    auto& panel = display_test::panelState;
    display.tick(scenes, 1675); display.tick(scenes, 1800);
    TEST_ASSERT_EQUAL_INT(4, panel.texts.back().x);
    const auto farEnd = panel.texts.size();
    display.tick(scenes, 3299); TEST_ASSERT_EQUAL_UINT32(farEnd, panel.texts.size());
    display.tick(scenes, 3300); display.tick(scenes, 3425);
    TEST_ASSERT_EQUAL_INT(8, panel.texts.back().x);
    const auto start = panel.texts.size();
    display.tick(scenes, 4924); TEST_ASSERT_EQUAL_UINT32(start, panel.texts.size());
    display.tick(scenes, 4925); TEST_ASSERT_EQUAL_INT(5, panel.texts.back().x);
}

void testLongMetadataAndRapidTrackChangesKeepArtworkBound() {
    display_test::panelState = {};
    PersistentStorage storage; TestClock clock; SceneManager scenes(clock, storage);
    auto value = track(); setText(value.title, std::string(80, 'T')); setText(value.artist, std::string(80, 'A'));
    scenes.heartbeat(); scenes.updateNowPlaying(value);
    DeviceDisplay display(storage); display.begin(); display.tick(scenes, 0);
    setText(value.trackId, "second-track"); scenes.updateNowPlaying(value); display.tick(scenes, 1);
    setText(value.trackId, "third-track"); scenes.updateNowPlaying(value); display.tick(scenes, 2);
    storage.coverBytes.assign(115200, 0);
    for (unsigned index = 0; index < storage.coverBytes.size(); index += 2) storage.coverBytes[index + 1] = 0xf8;
    storage.coverTrack = "second-track"; ++storage.assetRevision; display.tick(scenes, 3);
    TEST_ASSERT_EQUAL_HEX16(0, display_test::panelState.rows.back().firstPixel);
    storage.coverTrack = "third-track"; ++storage.assetRevision;
    display_test::panelState.rows.clear();
    const auto textCount = display_test::panelState.texts.size();
    for (unsigned row = 0; row < 176; ++row) display.tick(scenes, 4 + row);
    TEST_ASSERT_EQUAL_UINT32(176, display_test::panelState.rows.size());
    TEST_ASSERT_EQUAL_UINT32(textCount, display_test::panelState.texts.size());
    for (unsigned row = 0; row < 176; ++row) {
        TEST_ASSERT_EQUAL_INT(4 + row, display_test::panelState.rows[row].y);
        TEST_ASSERT_EQUAL_HEX16(0xf800, display_test::panelState.rows[row].firstPixel);
    }
    TEST_ASSERT_TRUE(scenes.currentState().nowPlaying->trackId.view() == "third-track");
    TEST_ASSERT_EQUAL_UINT32(80, scenes.currentState().nowPlaying->title.length);
    TEST_ASSERT_EQUAL_UINT32(80, scenes.currentState().nowPlaying->artist.length);
}

void testAutoPauseAndExpiryReturnToPreviouslyInstalledGif() {
    display_test::panelState = {};
    PersistentStorage storage; installTwoFrameAnimation(storage);
    TestClock clock; SceneManager scenes(clock, storage);
    auto value = track(); scenes.heartbeat(); scenes.updateNowPlaying(value);
    DeviceDisplay display(storage); display.begin(); display.tick(scenes, 0);
    value.isPlaying = false; scenes.updateNowPlaying(value);
    tickFrame(display, scenes, 1, 0x1234);
    value.isPlaying = true; scenes.updateNowPlaying(value); display.tick(scenes, 2);
    clock.now = 45001; scenes.heartbeat();
    tickFrame(display, scenes, clock.now, 0x1234);
    scenes.updateNowPlaying(value); display.tick(scenes, clock.now);
    clock.now += 45001;
    tickFrame(display, scenes, clock.now, 0x1234);
}

void testCoverArrivingAfterMetadataAndNewTrackKeepTextStable() {
    display_test::panelState = {};
    PersistentStorage storage; TestClock clock; SceneManager scenes(clock, storage);
    auto value = track(); scenes.heartbeat(); scenes.updateNowPlaying(value);
    DeviceDisplay display(storage); display.begin();
    for (unsigned row=0; row<176; ++row) display.tick(scenes, row);
    auto& panel = display_test::panelState;
    const auto texts = panel.texts.size();
    const auto clears = panel.screenClears;
    storage.coverBytes.assign(115200, 0);
    for (unsigned index=0; index<storage.coverBytes.size(); index+=2) storage.coverBytes[index+1] = 0xf8;
    ++storage.assetRevision; display.tick(scenes, 200);
    TEST_ASSERT_EQUAL_UINT16(0xf800, panel.rows.back().firstPixel);
    TEST_ASSERT_EQUAL_UINT32(texts, panel.texts.size()); TEST_ASSERT_EQUAL_UINT32(clears, panel.screenClears);
    setText(value.trackId, "other-track"); scenes.updateNowPlaying(value); display.tick(scenes, 201);
    // Missing new-track artwork is streamed as black, never read using the old ID.
    TEST_ASSERT_EQUAL_UINT16(0, panel.rows.back().firstPixel);
    TEST_ASSERT_EQUAL_UINT32(texts, panel.texts.size()); TEST_ASSERT_EQUAL_UINT32(clears, panel.screenClears);
}

void testPrimaryColorWordsReachSpiUnchangedFromLittleEndianRows() {
    display_test::panelState = {};
    PersistentStorage storage; DeviceDisplay display(storage); display.begin();
    const std::uint16_t colors[] = {0xf800,0x07e0,0x001f,0xffff,0x0000,0x07ff,0xf81f,0xffe0};
    std::vector<std::uint8_t> row;
    for (unsigned x=0; x<240; ++x) appendLittleEndian16(row, colors[x/30]);
    display.writeAnimationPixels(0,row.data(),row.size());
    const auto& pixels = display_test::panelState.rows.back().pixels;
    for (unsigned x=0; x<240; ++x) TEST_ASSERT_EQUAL_HEX16(colors[x/30], pixels[x]);
}

void testTrackChangeClearsCompletedCoverBeforeNewMetadata() {
    display_test::panelState = {};
    PersistentStorage storage;
    storage.coverBytes.assign(115200, 0);
    for (unsigned index=0; index<storage.coverBytes.size(); index+=2) storage.coverBytes[index+1] = 0xf8;
    TestClock clock; SceneManager scenes(clock, storage); scenes.heartbeat();
    auto value = track(); scenes.updateNowPlaying(value);
    DeviceDisplay display(storage); display.begin();
    for (unsigned row=0; row<176; ++row) display.tick(scenes, row);
    auto& panel = display_test::panelState;
    TEST_ASSERT_EQUAL_UINT32(176, panel.rows.size());
    TEST_ASSERT_EQUAL_HEX16(0xf800, panel.rows.back().firstPixel);
    panel.rectangles.clear();
    const auto clears = panel.screenClears;
    setText(value.trackId,"new-track"); setText(value.title,"New title");
    scenes.updateNowPlaying(value); display.tick(scenes,200);
    TEST_ASSERT_FALSE(panel.rectangles.empty());
    const auto& firstClear = panel.rectangles.front();
    TEST_ASSERT_EQUAL_INT(32, firstClear.x); TEST_ASSERT_EQUAL_INT(4, firstClear.y);
    TEST_ASSERT_EQUAL_INT(176, firstClear.width); TEST_ASSERT_EQUAL_INT(176, firstClear.height);
    TEST_ASSERT_EQUAL_HEX16(ST77XX_BLACK, firstClear.color);
    TEST_ASSERT_EQUAL_UINT32(clears, panel.screenClears);
    TEST_ASSERT_EQUAL_HEX16(0, panel.rows.back().firstPixel);
}

} // namespace

int main() {
    UNITY_BEGIN();
    RUN_TEST(testGifFrameDelayAndLoopingUseDeviceDisplayTick);
    RUN_TEST(testV2PlayerDrawsChangedSpansWithoutClearingAndRestartsAtKeyframe);
    RUN_TEST(testV2CandidatePromotionWaitsForFrameBoundaryAndRestartsAtKeyframe);
    RUN_TEST(testV2PlayerReopensFromKeyframeAfterAStorageReadFailure);
    RUN_TEST(testSlowFrameRenderingDoesNotAddASecondFullDelay);
    RUN_TEST(testDisplayInitializationUsesBoundedSpiAndRetainsProvisionalProfile);
    RUN_TEST(testDisplayHalfTurnUsesRgbWithoutOverridingRotation);
    RUN_TEST(testSpotifyStreamsLargerCoverAndDoesNotRedrawOnProgress);
    RUN_TEST(testSpotifyMetadataChangesInvalidateOnlyTheirOwnField);
    RUN_TEST(testSpotifyMarqueeWaitsForCoverAndMovesFieldsIndependently);
    RUN_TEST(testMarqueePausesAtBothEndsAndRestartsOnMetadataAndCoverChanges);
    RUN_TEST(testMarqueeBoundaryAndUnicodeReplacement);
    RUN_TEST(testMarqueePausesAfterReturningToStart);
    RUN_TEST(testLongMetadataAndRapidTrackChangesKeepArtworkBound);
    RUN_TEST(testAutoPauseAndExpiryReturnToPreviouslyInstalledGif);
    RUN_TEST(testCoverArrivingAfterMetadataAndNewTrackKeepTextStable);
    RUN_TEST(testPrimaryColorWordsReachSpiUnchangedFromLittleEndianRows);
    RUN_TEST(testTrackChangeClearsCompletedCoverBeforeNewMetadata);
    return UNITY_END();
}
