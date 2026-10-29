#define ARDUINO_ARCH_ESP8266 1
#define NEONBYTE_ENABLE_DISPLAY 1

#include "neonbyte/esp8266/display.h"
#include "../../src/esp8266/display.cpp"

#include <unity.h>

#include <cstdlib>
#include <cstdint>
#include <new>
#include <vector>

using namespace neonbyte;

namespace {
bool countHeapAllocations = false;
std::size_t heapAllocationCount = 0;
}

void* operator new(std::size_t size) {
    if (countHeapAllocations) ++heapAllocationCount;
    if (void* memory = std::malloc(size)) return memory;
    throw std::bad_alloc();
}

void* operator new[](std::size_t size) {
    if (countHeapAllocations) ++heapAllocationCount;
    if (void* memory = std::malloc(size)) return memory;
    throw std::bad_alloc();
}

void operator delete(void* memory) noexcept { std::free(memory); }
void operator delete[](void* memory) noexcept { std::free(memory); }
void operator delete(void* memory, std::size_t) noexcept { std::free(memory); }
void operator delete[](void* memory, std::size_t) noexcept { std::free(memory); }

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
    // A reopen also failed while storage was unavailable, so its retry is due at 1050.
    display.tick(scenes, 51); display.tick(scenes, 1049);
    TEST_ASSERT_EQUAL_UINT32(240, panel.rows.size());
    for (unsigned tick = 0; tick < 320 && panel.rows.size() < 480; ++tick) display.tick(scenes, 1050);
    TEST_ASSERT_EQUAL_UINT32(480, panel.rows.size());
    TEST_ASSERT_EQUAL_INT(0, panel.rows[240].x);
    TEST_ASSERT_EQUAL_INT(0, panel.rows[240].y);
    TEST_ASSERT_EQUAL_HEX16(0xf800, panel.rows[240].firstPixel);
}

void testV2PlaybackPreservesFrameOrderAcrossLoopsWithSlowReadsAndServiceGaps() {
    display_test::panelState = {};
    PersistentStorage storage; installV2Animation(storage);
    std::uint64_t simulatedTime = 0;
    storage.simulatedReadClock = &simulatedTime;
    storage.simulatedReadDelayMs = 1;
    TestClock clock; SceneManager scenes(clock, storage);
    TEST_ASSERT_TRUE(scenes.setMode(DisplayMode::gif));
    DeviceDisplay display(storage); display.begin();
    auto& rows = display_test::panelState.rows;
    for (unsigned tick = 0; tick < 10000 && rows.size() < 5 * 241; ++tick) {
        clock.now = simulatedTime;
        display.tick(scenes, simulatedTime);
        simulatedTime += tick % 37 == 0 ? 12 : 1;
    }
    TEST_ASSERT_EQUAL_UINT32(5 * 241, rows.size());
    for (unsigned loop = 0; loop < 5; ++loop) {
        for (unsigned y = 0; y < 240; ++y) {
            const auto& row = rows[loop * 241 + y];
            TEST_ASSERT_EQUAL_INT(y, row.y);
            TEST_ASSERT_EQUAL_UINT32(240, row.pixelCount);
            TEST_ASSERT_EQUAL_HEX16(0xf800, row.firstPixel);
        }
        const auto& delta = rows[loop * 241 + 240];
        TEST_ASSERT_EQUAL_INT(10, delta.y);
        TEST_ASSERT_EQUAL_INT(20, delta.x);
        TEST_ASSERT_EQUAL_UINT32(2, delta.pixelCount);
        TEST_ASSERT_EQUAL_HEX16(0x07e0, delta.firstPixel);
    }
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

void finishInitialSpotifyText(DeviceDisplay& display, const SceneManager& scenes, unsigned now) {
    // The title and artist each compose a 20-row band over ten cooperative ticks.
    for (unsigned tick = 0; tick < 20; ++tick) display.tick(scenes, now + tick);
}

std::size_t countTextRows(const display_test::PanelState& panel, int firstY, int lastY) {
    return static_cast<std::size_t>(std::count_if(panel.rows.begin(), panel.rows.end(),
        [&](const auto& row) { return row.y >= firstY && row.y < lastY; }));
}

void assertTextBand(const display_test::PanelState& panel, std::size_t firstRow,
                    std::string_view text, std::uint16_t offset, unsigned y,
                    std::uint16_t color) {
    std::array<std::uint8_t, SPOTIFY_TEXT_ROW_BYTES> expected{};
    for (unsigned row = 0; row < SPOTIFY_TEXT_ROW_HEIGHT; ++row) {
        TEST_ASSERT_TRUE(composeSpotifyTextRow(text, offset, row, color, expected.data(), expected.size()));
        const auto& written = panel.rows[firstRow + row];
        TEST_ASSERT_EQUAL_INT(0, written.x);
        TEST_ASSERT_EQUAL_INT(y + row, written.y);
        TEST_ASSERT_EQUAL_UINT32(SPOTIFY_TEXT_ROW_WIDTH, written.pixelCount);
        for (unsigned x = 0; x < SPOTIFY_TEXT_ROW_WIDTH; ++x) {
            const auto pixel = static_cast<std::uint16_t>(expected[x * 2]) |
                static_cast<std::uint16_t>(static_cast<std::uint16_t>(expected[x * 2 + 1]) << 8);
            TEST_ASSERT_EQUAL_HEX16(pixel, written.pixels[x]);
        }
    }
}

void testSpotifyStreamsLargerCoverAndDoesNotRedrawOnProgress() {
    display_test::panelState = {};
    PersistentStorage storage;
    for (unsigned y=0; y<240; ++y) for (unsigned x=0; x<240; ++x) appendLittleEndian16(storage.coverBytes, y*240+x);
    TestClock clock; SceneManager scenes(clock, storage);
    auto value = track(); scenes.heartbeat(); scenes.updateNowPlaying(value);
    DeviceDisplay display(storage); display.begin();
    for (unsigned row=0; row<176; ++row) display.tick(scenes, row);
    finishInitialSpotifyText(display, scenes, 176);
    const auto& panel = display_test::panelState;
    TEST_ASSERT_EQUAL_UINT32(216, panel.rows.size());
    for (unsigned row=0; row<176; ++row) {
        const auto& write = panel.rows[row];
        TEST_ASSERT_EQUAL_INT(32, write.x); TEST_ASSERT_EQUAL_INT(4+row, write.y);
        TEST_ASSERT_EQUAL_UINT32(176, write.pixelCount);
        TEST_ASSERT_EQUAL_UINT32((row*240/176)*480, storage.coverReads[row]);
        for (unsigned x=0; x<176; ++x) TEST_ASSERT_EQUAL_UINT16((row*240/176)*240+(x*240/176), write.pixels[x]);
    }
    const auto clears = panel.screenClears;
    const auto textRows = countTextRows(panel, 190, 231);
    for (unsigned now=1000; now<10000; now+=1000) {
        value.progressMs = now; scenes.updateNowPlaying(value); display.tick(scenes, now);
    }
    TEST_ASSERT_EQUAL_UINT32(clears, panel.screenClears);
    TEST_ASSERT_EQUAL_UINT32(textRows, countTextRows(panel, 190, 231));
    TEST_ASSERT_EQUAL_UINT32(216, panel.rows.size());
}

void testSpotifyMetadataChangesInvalidateOnlyTheirOwnField() {
    display_test::panelState = {};
    PersistentStorage storage; TestClock clock; SceneManager scenes(clock, storage);
    auto value = track(); scenes.heartbeat(); scenes.updateNowPlaying(value);
    DeviceDisplay display(storage); display.begin();
    for (unsigned row = 0; row < 176; ++row) display.tick(scenes, row);
    finishInitialSpotifyText(display, scenes, 176);
    auto& panel = display_test::panelState;
    const auto clears = panel.screenClears;
    const auto firstTitle = panel.rows.size();
    setText(value.title, "Corrected title"); scenes.updateNowPlaying(value);
    for (unsigned tick = 0; tick < 10; ++tick) display.tick(scenes, 1000 + tick);
    TEST_ASSERT_EQUAL_UINT32(firstTitle + 20, panel.rows.size());
    TEST_ASSERT_EQUAL_UINT32(40, countTextRows(panel, 190, 210));
    TEST_ASSERT_EQUAL_UINT32(20, countTextRows(panel, 211, 231));
    assertTextBand(panel, firstTitle, "Corrected title", 0, 190, ST77XX_WHITE);

    const auto firstArtist = panel.rows.size();
    setText(value.artist, "Corrected artist"); scenes.updateNowPlaying(value);
    for (unsigned tick = 0; tick < 10; ++tick) display.tick(scenes, 2000 + tick);
    TEST_ASSERT_EQUAL_UINT32(40, countTextRows(panel, 190, 210));
    TEST_ASSERT_EQUAL_UINT32(40, countTextRows(panel, 211, 231));
    assertTextBand(panel, firstArtist, "Corrected artist", 0, 211, 0x9cf3);
    TEST_ASSERT_EQUAL_UINT32(clears, panel.screenClears);
    ++storage.assetRevision;
    const auto beforeCover = panel.rows.size();
    for (unsigned row = 0; row < 176; ++row) display.tick(scenes, 3000 + row);
    TEST_ASSERT_EQUAL_UINT32(beforeCover + 176, panel.rows.size());
    TEST_ASSERT_EQUAL_UINT32(40, countTextRows(panel, 190, 210));
    TEST_ASSERT_EQUAL_UINT32(40, countTextRows(panel, 211, 231));
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
    finishInitialSpotifyText(display, scenes, 4000);
    auto& panel = display_test::panelState;
    const auto initialRows = panel.rows.size();
    std::vector<std::uint16_t> coverPixels;
    for (unsigned y = 4; y < 180; ++y) for (unsigned x = 32; x < 208; ++x)
        coverPixels.push_back(panel.pixels[y * 240 + x]);
    display.tick(scenes, 5508);
    TEST_ASSERT_EQUAL_UINT32(initialRows, panel.rows.size());
    display.tick(scenes, 5509);
    TEST_ASSERT_EQUAL_UINT32(initialRows + 2, panel.rows.size());
    for (unsigned tick = 1; tick < 10; ++tick) display.tick(scenes, 5509 + tick);
    const auto titleBand = panel.rows.size() - 20;
    assertTextBand(panel, titleBand, std::string(30, 'T'), 1, 190, ST77XX_WHITE);
    TEST_ASSERT_EQUAL_UINT32(initialRows + 20, panel.rows.size());
    for (const auto& row : panel.rows) TEST_ASSERT_TRUE(row.y < 180 || row.y >= 190);
    for (unsigned y = 4; y < 180; ++y) for (unsigned x = 32; x < 208; ++x)
        TEST_ASSERT_EQUAL_HEX16(coverPixels[(y - 4) * 176 + x - 32], panel.pixels[y * 240 + x]);
}

void testLongArtistMovesWhenEveryDisplayTickIsOverdue() {
    display_test::panelState = {};
    PersistentStorage storage; TestClock clock; SceneManager scenes(clock, storage);
    auto value = track();
    setText(value.title, std::string(30, 'T'));
    setText(value.artist, std::string(30, 'A'));
    scenes.heartbeat(); scenes.updateNowPlaying(value);
    DeviceDisplay display(storage); display.begin();
    for (unsigned row = 0; row < 176; ++row) display.tick(scenes, row);
    finishInitialSpotifyText(display, scenes, 176);
    auto& panel = display_test::panelState;
    const auto titleBefore = countTextRows(panel, 190, 210);
    const auto artistBefore = countTextRows(panel, 211, 231);
    for (unsigned tick = 0; tick < 20; ++tick) display.tick(scenes, 1700 + tick * 200);
    TEST_ASSERT_GREATER_THAN_UINT32(titleBefore, countTextRows(panel, 190, 210));
    TEST_ASSERT_GREATER_THAN_UINT32(artistBefore, countTextRows(panel, 211, 231));
}

void testMarqueeMovementComposesCompleteRowsWithoutASeparateBlackClear() {
    display_test::panelState = {};
    PersistentStorage storage; TestClock clock; SceneManager scenes(clock, storage);
    auto value = track();
    setText(value.title, "A title long enough to scroll smoothly");
    setText(value.artist, "An independent artist marquee");
    scenes.heartbeat(); scenes.updateNowPlaying(value);
    DeviceDisplay display(storage); display.begin();
    for (unsigned row = 0; row < 176; ++row) display.tick(scenes, row);
    finishInitialSpotifyText(display, scenes, 176);

    auto& panel = display_test::panelState;
    panel.rectangles.clear();
    const auto rowsBefore = panel.rows.size();
    const auto now = 1685;
    display.tick(scenes, now);

    TEST_ASSERT_EQUAL_UINT32(2, panel.rows.size() - rowsBefore);
    TEST_ASSERT_TRUE(panel.rectangles.empty());
    TEST_ASSERT_EQUAL_INT(190, panel.rows[rowsBefore].y);
    TEST_ASSERT_EQUAL_INT(191, panel.rows[rowsBefore + 1].y);
    TEST_ASSERT_EQUAL_UINT32(240, panel.rows[rowsBefore].pixelCount);
    TEST_ASSERT_EQUAL_UINT32(240, panel.rows[rowsBefore + 1].pixelCount);
    for (unsigned tick = 1; tick < 10; ++tick) display.tick(scenes, now);
    TEST_ASSERT_EQUAL_UINT32(20, panel.rows.size() - rowsBefore);
    assertTextBand(panel, rowsBefore, "A title long enough to scroll smoothly", 1, 190, ST77XX_WHITE);
}

void testMarqueePausesAtBothEndsAndRestartsOnMetadataAndCoverChanges() {
    display_test::panelState = {};
    PersistentStorage storage; TestClock clock; SceneManager scenes(clock, storage);
    auto value = track(); setText(value.title, std::string(20, 'T')); setText(value.artist, "Short artist");
    scenes.heartbeat(); scenes.updateNowPlaying(value);
    DeviceDisplay display(storage); display.begin();
    for (unsigned row = 0; row < 176; ++row) display.tick(scenes, row);
    finishInitialSpotifyText(display, scenes, 176);
    auto& panel = display_test::panelState;
    const auto coverRows = panel.rows.size();
    panel.rectangles.clear();
    const auto beforePause = panel.rows.size();
    display.tick(scenes, 1684);
    TEST_ASSERT_EQUAL_UINT32(beforePause, panel.rows.size());
    for (unsigned step = 0; step < 16; ++step) {
        const auto now = 1685 + step * SPOTIFY_MARQUEE_INTERVAL_MS;
        for (unsigned rowTick = 0; rowTick < 10; ++rowTick) display.tick(scenes, now);
    }
    TEST_ASSERT_EQUAL_UINT32(beforePause + 16 * 20, panel.rows.size());
    TEST_ASSERT_TRUE(panel.rectangles.empty());
    assertTextBand(panel, panel.rows.size() - 20, std::string(20, 'T'), 16, 190, ST77XX_WHITE);
    const auto farEdgeRows = panel.rows.size();
    display.tick(scenes, 2285 + SPOTIFY_MARQUEE_PAUSE_MS - 1);
    TEST_ASSERT_EQUAL_UINT32(farEdgeRows, panel.rows.size());
    for (unsigned rowTick = 0; rowTick < 10; ++rowTick)
        display.tick(scenes, 2285 + SPOTIFY_MARQUEE_PAUSE_MS);
    TEST_ASSERT_EQUAL_UINT32(farEdgeRows + 20, panel.rows.size());
    assertTextBand(panel, panel.rows.size() - 20, std::string(20, 'T'), 15, 190, ST77XX_WHITE);

    ++storage.assetRevision;
    const auto beforeCover = panel.rows.size();
    for (unsigned row = 0; row < 176; ++row) display.tick(scenes, 5000 + row);
    TEST_ASSERT_EQUAL_UINT32(beforeCover + 176, panel.rows.size());
    TEST_ASSERT_EQUAL_UINT32(coverRows + 16 * 20 + 20 + 176, panel.rows.size());
    const auto priorTitleRows = countTextRows(panel, 190, 210);
    const auto priorArtistRows = countTextRows(panel, 211, 231);
    const auto updatedTitle = panel.rows.size();
    setText(value.title, "Short replacement"); scenes.updateNowPlaying(value);
    for (unsigned rowTick = 0; rowTick < 10; ++rowTick) display.tick(scenes, 6000 + rowTick);
    assertTextBand(panel, updatedTitle, "Short replacement", 0, 190, ST77XX_WHITE);
    TEST_ASSERT_EQUAL_UINT32(priorTitleRows + 20, countTextRows(panel, 190, 210));
    TEST_ASSERT_EQUAL_UINT32(priorArtistRows, countTextRows(panel, 211, 231));
}

void testMarqueeBoundaryAndUnicodeReplacement() {
    display_test::panelState = {};
    PersistentStorage storage; TestClock clock; SceneManager scenes(clock, storage);
    auto value = track(); setText(value.title, std::string(18, 'T'));
    setText(value.artist, std::string(18, 'A') + "\xc3\xa9");
    scenes.heartbeat(); scenes.updateNowPlaying(value);
    DeviceDisplay display(storage); display.begin();
    for (unsigned row = 0; row < 176; ++row) display.tick(scenes, row);
    finishInitialSpotifyText(display, scenes, 176);
    auto& panel = display_test::panelState;
    const auto firstArtistRow = panel.rows.size() - 20;
    assertTextBand(panel, firstArtistRow, std::string(18, 'A') + "?", 0, 211, 0x9cf3);
    const auto rowsBeforeMove = panel.rows.size();
    for (unsigned rowTick = 0; rowTick < 10; ++rowTick) display.tick(scenes, 1700 + rowTick);
    TEST_ASSERT_EQUAL_UINT32(rowsBeforeMove + 20, panel.rows.size());
    assertTextBand(panel, panel.rows.size() - 20, std::string(18, 'A') + "?", 1, 211, 0x9cf3);
}

void testMarqueeStateFitsMetadataOnlyBudget() {
    // Text belongs in the inactive decoder workspace, not in each motion state.
    TEST_ASSERT_LESS_OR_EQUAL_UINT32(24, sizeof(SpotifyMarquee));
    TEST_ASSERT_LESS_OR_EQUAL_UINT32(24, sizeof(SpotifyTextRender));
    TEST_ASSERT_EQUAL_UINT32(480, SPOTIFY_TEXT_ROW_BYTES);
}

void testSpotifyTextUpdatesDoNotAllocateFromTheHeap() {
    display_test::panelState = {};
    PersistentStorage storage; TestClock clock; SceneManager scenes(clock, storage);
    auto value = track(); setText(value.title, std::string(40, 'T'));
    scenes.heartbeat(); scenes.updateNowPlaying(value);
    DeviceDisplay display(storage); display.begin();
    for (unsigned row = 0; row < 176; ++row) display.tick(scenes, row);
    finishInitialSpotifyText(display, scenes, 176);
    display_test::panelState.captureRowHistory = false;

    heapAllocationCount = 0;
    countHeapAllocations = true;
    for (unsigned tick = 0; tick < 10; ++tick) display.tick(scenes, 1685);
    countHeapAllocations = false;
    TEST_ASSERT_EQUAL_UINT32(0, heapAllocationCount);
}

void testGifSceneEntryRetriesTransientOpenFailuresOncePerTick() {
    for (bool fromSpotify : {false, true}) for (unsigned failedRead = 1; failedRead <= 5; ++failedRead) {
        display_test::panelState = {};
        PersistentStorage storage; installV2Animation(storage);
        TestClock clock; SceneManager scenes(clock, storage);
        auto value = track(); scenes.heartbeat(); scenes.updateNowPlaying(value);
        DeviceDisplay display(storage); display.begin();
        if (fromSpotify) display.tick(scenes, 0);
        TEST_ASSERT_TRUE(scenes.setMode(DisplayMode::gif));
        storage.failAnimationReadCall = storage.animationReadCalls + failedRead;
        const auto previousRows = display_test::panelState.rows.size();
        display.tick(scenes, 0);
        TEST_ASSERT_EQUAL_UINT32(storage.failAnimationReadCall, storage.animationReadCalls);
        TEST_ASSERT_EQUAL_UINT32(previousRows, display_test::panelState.rows.size());
        display.tick(scenes, 1); display.tick(scenes, 999);
        TEST_ASSERT_EQUAL_UINT32(storage.failAnimationReadCall, storage.animationReadCalls);
        for (unsigned tick = 0; tick < 300 && display_test::panelState.rows.size() < previousRows + 240; ++tick)
            display.tick(scenes, 1000);
        TEST_ASSERT_EQUAL_UINT32(previousRows + 240, display_test::panelState.rows.size());
        for (unsigned row = 0; row < 240; ++row) {
            const auto& written = display_test::panelState.rows[previousRows + row];
            TEST_ASSERT_EQUAL_INT(row, written.y);
            TEST_ASSERT_EQUAL_HEX16(0xf800, written.firstPixel);
        }
    }
}

void testPersistentGifOpenFailureBacksOffAndNewRevisionBypassesWait() {
    display_test::panelState = {};
    PersistentStorage storage; installV2Animation(storage); storage.failAnimationReads = true;
    TestClock clock; SceneManager scenes(clock, storage);
    TEST_ASSERT_TRUE(scenes.setMode(DisplayMode::gif));
    DeviceDisplay display(storage); display.begin();
    display.tick(scenes, 0);
    TEST_ASSERT_EQUAL_UINT32(1, storage.animationReadCalls);
    for (unsigned now = 1; now < 1000; ++now) display.tick(scenes, now);
    TEST_ASSERT_EQUAL_UINT32(1, storage.animationReadCalls);
    display.tick(scenes, 1000);
    TEST_ASSERT_EQUAL_UINT32(2, storage.animationReadCalls);
    display.tick(scenes, 1001);
    TEST_ASSERT_EQUAL_UINT32(2, storage.animationReadCalls);
    storage.failAnimationReads = false; ++storage.animationRevision;
    for (unsigned tick = 0; tick < 300 && display_test::panelState.rows.size() < 240; ++tick)
        display.tick(scenes, 1002);
    TEST_ASSERT_EQUAL_UINT32(240, display_test::panelState.rows.size());
    TEST_ASSERT_EQUAL_HEX16(0xf800, display_test::panelState.rows.front().firstPixel);
}

void testRapidSceneChangesKeepPartialCoversAndDecodedRowsIsolated() {
    display_test::panelState = {};
    PersistentStorage storage; installV2Animation(storage);
    for (unsigned y = 0; y < 240; ++y) for (unsigned x = 0; x < 240; ++x)
        appendLittleEndian16(storage.coverBytes, static_cast<std::uint16_t>(y * 240 + x));
    TestClock clock; SceneManager scenes(clock, storage);
    auto value = track(); setText(value.title, std::string(256, 'T')); setText(value.artist, std::string(256, 'A'));
    scenes.heartbeat(); scenes.updateNowPlaying(value);
    DeviceDisplay display(storage); display.begin();
    auto& panel = display_test::panelState;
    std::uint64_t now = 0;
    for (unsigned gifTicks : {0U, 1U, 2U, 120U, 240U, 241U, 242U, 243U, 244U, 245U, 246U}) {
        TEST_ASSERT_TRUE(scenes.setMode(DisplayMode::spotify));
        for (unsigned row = 0; row < 3; ++row) display.tick(scenes, now++);
        TEST_ASSERT_TRUE(scenes.setMode(DisplayMode::gif));
        display.showGif();
        for (unsigned tick = 0; tick < gifTicks; ++tick) display.tick(scenes, now++);
        TEST_ASSERT_TRUE(scenes.setMode(DisplayMode::spotify));
        const auto textStart = panel.rows.size();
        for (unsigned row = 0; row < 176; ++row) display.tick(scenes, now++);
        for (unsigned row = 0; row < 20; ++row) display.tick(scenes, now++);
        TEST_ASSERT_EQUAL_UINT32(textStart + 216, panel.rows.size());
        assertTextBand(panel, textStart + 176, std::string(256, 'T').substr(0, 20), 0,
                       190, ST77XX_WHITE);
        assertTextBand(panel, textStart + 196, std::string(256, 'A').substr(0, 20), 0,
                       211, 0x9cf3);
        for (unsigned y = 4; y < 180; ++y) for (unsigned x = 32; x < 208; ++x) {
            const auto sourceY = (y - 4) * 240 / 176;
            const auto sourceX = (x - 32) * 240 / 176;
            TEST_ASSERT_EQUAL_HEX16(sourceY * 240 + sourceX, panel.pixels[y * 240 + x]);
        }
    }
}

void testFullLengthMarqueesAndGifReentryPreserveTheSharedWorkspace() {
    display_test::panelState = {};
    PersistentStorage storage; installV2Animation(storage);
    storage.coverBytes.assign(115200, 0xa5);
    TestClock clock; SceneManager scenes(clock, storage);
    auto value = track();
    const std::string title = std::string(240, 'T') + "TITLE-END-123456";
    const std::string artist = std::string(240, 'A') + "ARTIST-END-12345";
    TEST_ASSERT_EQUAL_UINT32(256, title.size());
    TEST_ASSERT_EQUAL_UINT32(256, artist.size());
    setText(value.title, title); setText(value.artist, artist);
    scenes.heartbeat(); scenes.updateNowPlaying(value);
    DeviceDisplay display(storage); display.begin();
    auto& panel = display_test::panelState;
    std::uint64_t now = 0;
    TEST_ASSERT_TRUE(scenes.setMode(DisplayMode::gif));
    const auto rowsBeforeGif = panel.rows.size();
    // Interrupt frame zero while its encoded workspace retains a row header.
    for (unsigned tick = 0; tick < 20 && panel.rows.size() == rowsBeforeGif; ++tick)
        display.tick(scenes, now++);
    TEST_ASSERT_EQUAL_UINT32(rowsBeforeGif + 1, panel.rows.size());
    TEST_ASSERT_EQUAL_INT(0, panel.rows.back().y);
    TEST_ASSERT_EQUAL_HEX16(0xf800, panel.rows.back().firstPixel);

    TEST_ASSERT_TRUE(scenes.setMode(DisplayMode::spotify));
    const auto textStart = panel.rows.size();
    for (unsigned row = 0; row < 176; ++row) display.tick(scenes, now++);
    for (unsigned row = 0; row < 20; ++row) display.tick(scenes, now++);
    assertTextBand(panel, textStart + 176, title.substr(0, 20), 0, 190, ST77XX_WHITE);
    assertTextBand(panel, textStart + 196, artist.substr(0, 20), 0, 211, 0x9cf3);
    const auto coverWrites = panel.totalRowWrites;
    panel.captureRowHistory = false;
    auto current = now + SPOTIFY_MARQUEE_PAUSE_MS;
    constexpr std::uint16_t endOffset = 256 * 12 - SPOTIFY_TEXT_VIEWPORT_WIDTH;
    for (unsigned step = 0; step < endOffset; ++step) {
        for (unsigned field = 0; field < 2; ++field)
            for (unsigned rowTick = 0; rowTick < 10; ++rowTick) display.tick(scenes, current);
        current += SPOTIFY_MARQUEE_INTERVAL_MS;
    }
    TEST_ASSERT_EQUAL_UINT32(coverWrites + endOffset * 40, panel.totalRowWrites);
    for (unsigned row = 0; row < 20; ++row) {
        std::array<std::uint8_t, SPOTIFY_TEXT_ROW_BYTES> expected{};
        TEST_ASSERT_TRUE(composeSpotifyTextRow(title, endOffset, row, ST77XX_WHITE,
                                               expected.data(), expected.size()));
        for (unsigned x = 0; x < 240; ++x) {
            const auto pixel = static_cast<std::uint16_t>(expected[x * 2]) |
                static_cast<std::uint16_t>(static_cast<std::uint16_t>(expected[x * 2 + 1]) << 8);
            TEST_ASSERT_EQUAL_HEX16(pixel, panel.pixels[(190 + row) * 240 + x]);
        }
        TEST_ASSERT_TRUE(composeSpotifyTextRow(artist, endOffset, row, 0x9cf3,
                                               expected.data(), expected.size()));
        for (unsigned x = 0; x < 240; ++x) {
            const auto pixel = static_cast<std::uint16_t>(expected[x * 2]) |
                static_cast<std::uint16_t>(static_cast<std::uint16_t>(expected[x * 2 + 1]) << 8);
            TEST_ASSERT_EQUAL_HEX16(pixel, panel.pixels[(211 + row) * 240 + x]);
        }
    }
}

void testMarqueePausesAfterReturningToStart() {
    display_test::panelState = {};
    PersistentStorage storage; TestClock clock; SceneManager scenes(clock, storage);
    auto value = track(); setText(value.title, std::string(19, 'T'));
    scenes.heartbeat(); scenes.updateNowPlaying(value);
    DeviceDisplay display(storage); display.begin();
    for (unsigned row = 0; row < 176; ++row) display.tick(scenes, row);
    finishInitialSpotifyText(display, scenes, 176);
    auto& panel = display_test::panelState;
    const auto first = panel.rows.size();
    for (unsigned step = 0; step < 4; ++step)
        for (unsigned rowTick = 0; rowTick < 10; ++rowTick)
            display.tick(scenes, 1685 + step * SPOTIFY_MARQUEE_INTERVAL_MS);
    assertTextBand(panel, panel.rows.size() - 20, std::string(19, 'T'), 4, 190, ST77XX_WHITE);
    const auto farEnd = panel.rows.size();
    display.tick(scenes, 1805 + SPOTIFY_MARQUEE_PAUSE_MS - 1);
    TEST_ASSERT_EQUAL_UINT32(farEnd, panel.rows.size());
    for (unsigned rowTick = 0; rowTick < 10; ++rowTick)
        display.tick(scenes, 1805 + SPOTIFY_MARQUEE_PAUSE_MS);
    assertTextBand(panel, panel.rows.size() - 20, std::string(19, 'T'), 3, 190, ST77XX_WHITE);
    for (unsigned step = 1; step < 4; ++step)
        for (unsigned rowTick = 0; rowTick < 10; ++rowTick)
            display.tick(scenes, 3305 + step * SPOTIFY_MARQUEE_INTERVAL_MS);
    assertTextBand(panel, panel.rows.size() - 20, std::string(19, 'T'), 0, 190, ST77XX_WHITE);
    const auto start = panel.rows.size();
    display.tick(scenes, 3425 + SPOTIFY_MARQUEE_PAUSE_MS - 1);
    TEST_ASSERT_EQUAL_UINT32(start, panel.rows.size());
    for (unsigned rowTick = 0; rowTick < 10; ++rowTick)
        display.tick(scenes, 3425 + SPOTIFY_MARQUEE_PAUSE_MS);
    assertTextBand(panel, panel.rows.size() - 20, std::string(19, 'T'), 1, 190, ST77XX_WHITE);
    TEST_ASSERT_GREATER_THAN_UINT32(first, panel.rows.size());
}

void testMetadataChangesCancelAnObsoletePartialComposition() {
    display_test::panelState = {};
    PersistentStorage storage; TestClock clock; SceneManager scenes(clock, storage);
    auto value = track(); setText(value.title, std::string(40, 'O'));
    scenes.heartbeat(); scenes.updateNowPlaying(value);
    DeviceDisplay display(storage); display.begin();
    for (unsigned row = 0; row < 176; ++row) display.tick(scenes, row);
    finishInitialSpotifyText(display, scenes, 176);
    auto& panel = display_test::panelState;

    const auto beforeMove = panel.rows.size();
    display.tick(scenes, 1685);
    TEST_ASSERT_EQUAL_UINT32(beforeMove + 2, panel.rows.size());
    setText(value.title, "New metadata");
    scenes.updateNowPlaying(value);
    const auto beforeReplacement = panel.rows.size();
    for (unsigned rowTick = 0; rowTick < 10; ++rowTick) display.tick(scenes, 1700 + rowTick);
    TEST_ASSERT_EQUAL_UINT32(beforeReplacement + 20, panel.rows.size());
    assertTextBand(panel, panel.rows.size() - 20, "New metadata", 0, 190, ST77XX_WHITE);

    setText(value.title, "");
    scenes.updateNowPlaying(value);
    const auto beforeRemoval = panel.rows.size();
    for (unsigned rowTick = 0; rowTick < 10; ++rowTick) display.tick(scenes, 1800 + rowTick);
    TEST_ASSERT_EQUAL_UINT32(beforeRemoval + 20, panel.rows.size());
    assertTextBand(panel, panel.rows.size() - 20, "", 0, 190, ST77XX_WHITE);
}

void testSpotifyGifTransitionsCancelAndRebuildPartialTextComposition() {
    display_test::panelState = {};
    PersistentStorage storage; installV2Animation(storage);
    TestClock clock; SceneManager scenes(clock, storage);
    auto value = track();
    setText(value.title, "A Spotify title which scrolls");
    setText(value.artist, "An independent Spotify artist");
    scenes.heartbeat(); scenes.updateNowPlaying(value);
    DeviceDisplay display(storage); display.begin();
    for (unsigned row = 0; row < 176; ++row) display.tick(scenes, row);
    finishInitialSpotifyText(display, scenes, 176);
    auto& panel = display_test::panelState;

    display.tick(scenes, 1685);
    TEST_ASSERT_EQUAL_INT(191, panel.rows.back().y);
    TEST_ASSERT_TRUE(scenes.setMode(DisplayMode::gif));
    const auto rowsBeforeGif = panel.rows.size();
    for (unsigned tick = 0; tick < 300 && panel.rows.size() == rowsBeforeGif; ++tick)
        display.tick(scenes, 1686 + tick);
    TEST_ASSERT_GREATER_THAN_UINT32(rowsBeforeGif, panel.rows.size());
    TEST_ASSERT_EQUAL_INT(0, panel.rows.back().y);

    TEST_ASSERT_TRUE(scenes.setMode(DisplayMode::spotify));
    const auto newCoverStart = panel.rows.size();
    for (unsigned row = 0; row < 176; ++row) display.tick(scenes, 2000 + row);
    for (unsigned row = 0; row < 20; ++row) display.tick(scenes, 2200 + row);
    TEST_ASSERT_EQUAL_UINT32(newCoverStart + 216, panel.rows.size());
    assertTextBand(panel, newCoverStart + 176, "A Spotify title which scrolls", 0,
                   190, ST77XX_WHITE);
    assertTextBand(panel, newCoverStart + 196, "An independent Spotify artist", 0,
                   211, 0x9cf3);
}

void testCoverLoadingSuspendsAndResumesPartialMarqueeComposition() {
    display_test::panelState = {};
    PersistentStorage storage;
    storage.coverBytes.assign(115200, 0);
    storage.coverTrack = "track";
    TestClock clock; SceneManager scenes(clock, storage);
    auto value = track(); setText(value.title, std::string(40, 'T'));
    scenes.heartbeat(); scenes.updateNowPlaying(value);
    DeviceDisplay display(storage); display.begin();
    for (unsigned row = 0; row < 176; ++row) display.tick(scenes, row);
    finishInitialSpotifyText(display, scenes, 176);
    auto& panel = display_test::panelState;
    const auto initialTitleRows = countTextRows(panel, 190, 210);

    display.tick(scenes, 1685);
    TEST_ASSERT_EQUAL_UINT32(initialTitleRows + 2, countTextRows(panel, 190, 210));
    ++storage.assetRevision;
    const auto coverStart = panel.rows.size();
    display.tick(scenes, 1686);
    TEST_ASSERT_EQUAL_INT(4, panel.rows.back().y);
    for (unsigned row = 1; row < 176; ++row) display.tick(scenes, 1686 + row);
    TEST_ASSERT_EQUAL_UINT32(coverStart + 176, panel.rows.size());
    TEST_ASSERT_EQUAL_UINT32(initialTitleRows + 2, countTextRows(panel, 190, 210));

    const auto resumedAt = panel.rows.size();
    display.tick(scenes, 3000);
    TEST_ASSERT_EQUAL_UINT32(resumedAt + 2, panel.rows.size());
    for (unsigned rowTick = 1; rowTick < 10; ++rowTick) display.tick(scenes, 3000 + rowTick);
    assertTextBand(panel, panel.rows.size() - 20, std::string(40, 'T'), 0, 190, ST77XX_WHITE);
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
    for (unsigned row = 0; row < 176; ++row) display.tick(scenes, 4 + row);
    TEST_ASSERT_EQUAL_UINT32(176, display_test::panelState.rows.size());
    TEST_ASSERT_EQUAL_UINT32(0, countTextRows(display_test::panelState, 190, 231));
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
    finishInitialSpotifyText(display, scenes, 176);
    auto& panel = display_test::panelState;
    const auto titleRows = countTextRows(panel, 190, 210);
    const auto artistRows = countTextRows(panel, 211, 231);
    const auto clears = panel.screenClears;
    storage.coverBytes.assign(115200, 0);
    for (unsigned index=0; index<storage.coverBytes.size(); index+=2) storage.coverBytes[index+1] = 0xf8;
    storage.coverTrack = "track";
    ++storage.assetRevision; display.tick(scenes, 200);
    TEST_ASSERT_EQUAL_UINT16(0xf800, panel.rows.back().firstPixel);
    TEST_ASSERT_EQUAL_UINT32(titleRows, countTextRows(panel, 190, 210));
    TEST_ASSERT_EQUAL_UINT32(artistRows, countTextRows(panel, 211, 231));
    TEST_ASSERT_EQUAL_UINT32(clears, panel.screenClears);
    setText(value.trackId, "other-track"); scenes.updateNowPlaying(value); display.tick(scenes, 201);
    // Missing new-track artwork is streamed as black, never read using the old ID.
    TEST_ASSERT_EQUAL_UINT16(0, panel.rows.back().firstPixel);
    TEST_ASSERT_EQUAL_UINT32(titleRows, countTextRows(panel, 190, 210));
    TEST_ASSERT_EQUAL_UINT32(artistRows, countTextRows(panel, 211, 231));
    TEST_ASSERT_EQUAL_UINT32(clears, panel.screenClears);
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
    RUN_TEST(testV2PlaybackPreservesFrameOrderAcrossLoopsWithSlowReadsAndServiceGaps);
    RUN_TEST(testSlowFrameRenderingDoesNotAddASecondFullDelay);
    RUN_TEST(testDisplayInitializationUsesBoundedSpiAndRetainsProvisionalProfile);
    RUN_TEST(testDisplayHalfTurnUsesRgbWithoutOverridingRotation);
    RUN_TEST(testSpotifyStreamsLargerCoverAndDoesNotRedrawOnProgress);
    RUN_TEST(testSpotifyMetadataChangesInvalidateOnlyTheirOwnField);
    RUN_TEST(testSpotifyMarqueeWaitsForCoverAndMovesFieldsIndependently);
    RUN_TEST(testLongArtistMovesWhenEveryDisplayTickIsOverdue);
    RUN_TEST(testMarqueeMovementComposesCompleteRowsWithoutASeparateBlackClear);
    RUN_TEST(testMarqueePausesAtBothEndsAndRestartsOnMetadataAndCoverChanges);
    RUN_TEST(testMarqueeBoundaryAndUnicodeReplacement);
    RUN_TEST(testMarqueeStateFitsMetadataOnlyBudget);
    RUN_TEST(testSpotifyTextUpdatesDoNotAllocateFromTheHeap);
    RUN_TEST(testMetadataChangesCancelAnObsoletePartialComposition);
    RUN_TEST(testSpotifyGifTransitionsCancelAndRebuildPartialTextComposition);
    RUN_TEST(testCoverLoadingSuspendsAndResumesPartialMarqueeComposition);
    RUN_TEST(testGifSceneEntryRetriesTransientOpenFailuresOncePerTick);
    RUN_TEST(testPersistentGifOpenFailureBacksOffAndNewRevisionBypassesWait);
    RUN_TEST(testRapidSceneChangesKeepPartialCoversAndDecodedRowsIsolated);
    RUN_TEST(testFullLengthMarqueesAndGifReentryPreserveTheSharedWorkspace);
    RUN_TEST(testMarqueePausesAfterReturningToStart);
    RUN_TEST(testLongMetadataAndRapidTrackChangesKeepArtworkBound);
    RUN_TEST(testAutoPauseAndExpiryReturnToPreviouslyInstalledGif);
    RUN_TEST(testCoverArrivingAfterMetadataAndNewTrackKeepTextStable);
    RUN_TEST(testPrimaryColorWordsReachSpiUnchangedFromLittleEndianRows);
    RUN_TEST(testTrackChangeClearsCompletedCoverBeforeNewMetadata);
    return UNITY_END();
}
