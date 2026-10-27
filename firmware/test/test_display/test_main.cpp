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

void testSpotifyLongUnicodeMetadataUsesSingleLineWithoutPermanentTruncation() {
    display_test::panelState = {};
    PersistentStorage storage; DeviceDisplay display(storage); display.begin();
    auto value = track();
    setText(value.title, std::string(100, 'T')); setText(value.artist, "Artist \xc3\xa9\xf0\x9f\x8e\xb5 " + std::string(100, 'A'));
    display.showSpotify(value, 0);
    const auto& texts = display_test::panelState.texts;
    TEST_ASSERT_EQUAL_UINT32(2, texts.size());
    TEST_ASSERT_EQUAL_UINT8(2, texts[0].size);
    TEST_ASSERT_EQUAL_UINT8(2, texts[1].size);
    TEST_ASSERT_EQUAL_INT(190, texts[0].y);
    TEST_ASSERT_EQUAL_INT(211, texts[1].y);
    TEST_ASSERT_EQUAL_UINT32(20, texts[0].text.size());
    TEST_ASSERT_EQUAL_UINT32(20, texts[1].text.size());
    TEST_ASSERT_EQUAL_STRING(std::string(20, 'T').c_str(), texts[0].text.c_str());
    TEST_ASSERT_TRUE(texts[1].text.find("Artist ?? ") == 0);
    TEST_ASSERT_EQUAL_CHAR('A', texts[1].text.back());
}

void testSpotifyLongTitleScrollsAfterPauseWithoutTouchingArtistOrCover() {
    display_test::panelState = {};
    PersistentStorage storage;
    TestClock clock; SceneManager scenes(clock, storage);
    auto value = track(); setText(value.title, std::string(50, 'T'));
    scenes.heartbeat(); scenes.updateNowPlaying(value);
    DeviceDisplay display(storage); display.begin();
    for (unsigned row = 0; row < 176; ++row) display.tick(scenes, 0);

    auto& panel = display_test::panelState;
    TEST_ASSERT_EQUAL_UINT32(2, panel.texts.size());
    const auto clearCount = panel.rectangles.size();
    display.tick(scenes, 1499);
    display.tick(scenes, 1500);
    TEST_ASSERT_EQUAL_UINT32(2, panel.texts.size());
    display.tick(scenes, 1625);

    TEST_ASSERT_EQUAL_UINT32(3, panel.texts.size());
    TEST_ASSERT_EQUAL_INT(5, panel.texts[2].x);
    TEST_ASSERT_EQUAL_INT(190, panel.texts[2].y);
    TEST_ASSERT_EQUAL_STRING(std::string(20, 'T').c_str(), panel.texts[2].text.c_str());
    TEST_ASSERT_EQUAL_STRING("Artist", panel.texts[1].text.c_str());
    TEST_ASSERT_EQUAL_UINT32(clearCount + 1, panel.rectangles.size());
    TEST_ASSERT_EQUAL_INT(0, panel.rectangles.back().x);
    TEST_ASSERT_EQUAL_INT(190, panel.rectangles.back().y);
    TEST_ASSERT_EQUAL_INT(240, panel.rectangles.back().width);
    TEST_ASSERT_EQUAL_INT(20, panel.rectangles.back().height);
    TEST_ASSERT_EQUAL_UINT32(176, panel.rows.size());
}

void testSpotifyLongArtistScrollsIndependentlyFromStaticTitle() {
    display_test::panelState = {};
    PersistentStorage storage;
    TestClock clock; SceneManager scenes(clock, storage);
    auto value = track(); setText(value.artist, std::string(40, 'A'));
    scenes.heartbeat(); scenes.updateNowPlaying(value);
    DeviceDisplay display(storage); display.begin();
    for (unsigned row = 0; row < 176; ++row) display.tick(scenes, 0);
    display.tick(scenes, 1500); display.tick(scenes, 1625);

    const auto& texts = display_test::panelState.texts;
    TEST_ASSERT_EQUAL_UINT32(3, texts.size());
    TEST_ASSERT_EQUAL_STRING("Title", texts[0].text.c_str());
    TEST_ASSERT_EQUAL_UINT32(20, texts[2].text.size());
    TEST_ASSERT_EQUAL_INT(211, texts[2].y);
    TEST_ASSERT_EQUAL_INT(5, texts[2].x);
}

void testSpotifyLongTitleScrollingRevealsTheCompleteTail() {
    display_test::panelState = {};
    PersistentStorage storage;
    TestClock clock; SceneManager scenes(clock, storage);
    auto value = track(); setText(value.title, std::string(45, 'A') + "TAIL!");
    scenes.heartbeat(); scenes.updateNowPlaying(value);
    DeviceDisplay display(storage); display.begin();
    for (unsigned row = 0; row < 176; ++row) display.tick(scenes, 0);
    display.tick(scenes, 1500);
    display.tick(scenes, 1500 + 140 * 125);

    const auto& texts = display_test::panelState.texts;
    bool tailVisible = false;
    for (const auto& text : texts) {
        if (text.y == 190 && text.text.find("TAIL!") != std::string::npos) tailVisible = true;
    }
    TEST_ASSERT_TRUE(tailVisible);
}

void testSpotifyTrackChangeResetsMarqueePositionAndDelay() {
    display_test::panelState = {};
    PersistentStorage storage;
    TestClock clock; SceneManager scenes(clock, storage);
    auto value = track(); setText(value.title, std::string(50, 'T'));
    scenes.heartbeat(); scenes.updateNowPlaying(value);
    DeviceDisplay display(storage); display.begin();
    for (unsigned row = 0; row < 176; ++row) display.tick(scenes, 0);
    display.tick(scenes, 1500); display.tick(scenes, 1625);
    TEST_ASSERT_EQUAL_INT(5, display_test::panelState.texts[2].x);

    setText(value.trackId, "next-track"); scenes.updateNowPlaying(value);
    display.tick(scenes, 2000);
    const auto resetTextCount = display_test::panelState.texts.size();
    TEST_ASSERT_EQUAL_INT(8, display_test::panelState.texts[resetTextCount - 2].x);
    display.tick(scenes, 3499);
    display.tick(scenes, 3500);
    TEST_ASSERT_EQUAL_UINT32(resetTextCount, display_test::panelState.texts.size());
    display.tick(scenes, 3625);
    TEST_ASSERT_EQUAL_INT(5, display_test::panelState.texts[resetTextCount].x);
}

void testSpotifyMarqueeLoopsAtTheStartAndPausesBeforeNextPass() {
    display_test::panelState = {};
    PersistentStorage storage;
    TestClock clock; SceneManager scenes(clock, storage);
    auto value = track(); setText(value.title, std::string(40, 'T'));
    scenes.heartbeat(); scenes.updateNowPlaying(value);
    DeviceDisplay display(storage); display.begin();
    for (unsigned row = 0; row < 176; ++row) display.tick(scenes, 0);
    display.tick(scenes, 1500);
    for (unsigned step = 1; step <= 168; ++step) display.tick(scenes, 1500 + step * 125);

    auto& panel = display_test::panelState;
    TEST_ASSERT_EQUAL_INT(8, panel.texts.back().x);
    const auto loopTextCount = panel.texts.size();
    display.tick(scenes, 22500 + 1499);
    display.tick(scenes, 22500 + 1500);
    TEST_ASSERT_EQUAL_UINT32(loopTextCount, panel.texts.size());
    display.tick(scenes, 22500 + 1625);
    TEST_ASSERT_EQUAL_INT(5, panel.texts[loopTextCount].x);
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
    TEST_ASSERT_EQUAL_UINT32(texts + 2, panel.texts.size()); TEST_ASSERT_EQUAL_UINT32(clears, panel.screenClears);
    TEST_ASSERT_EQUAL_INT(8, panel.texts[panel.texts.size() - 2].x);
    TEST_ASSERT_EQUAL_INT(190, panel.texts[panel.texts.size() - 2].y);
    TEST_ASSERT_EQUAL_INT(8, panel.texts.back().x);
    TEST_ASSERT_EQUAL_INT(211, panel.texts.back().y);
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
    RUN_TEST(testSlowFrameRenderingDoesNotAddASecondFullDelay);
    RUN_TEST(testDisplayInitializationUsesBoundedSpiAndRetainsProvisionalProfile);
    RUN_TEST(testDisplayHalfTurnUsesRgbWithoutOverridingRotation);
    RUN_TEST(testSpotifyStreamsLargerCoverAndDoesNotRedrawOnProgress);
    RUN_TEST(testSpotifyMetadataChangesInvalidateOnlyTheirOwnField);
    RUN_TEST(testSpotifyLongUnicodeMetadataUsesSingleLineWithoutPermanentTruncation);
    RUN_TEST(testSpotifyLongTitleScrollsAfterPauseWithoutTouchingArtistOrCover);
    RUN_TEST(testSpotifyLongArtistScrollsIndependentlyFromStaticTitle);
    RUN_TEST(testSpotifyLongTitleScrollingRevealsTheCompleteTail);
    RUN_TEST(testSpotifyTrackChangeResetsMarqueePositionAndDelay);
    RUN_TEST(testSpotifyMarqueeLoopsAtTheStartAndPausesBeforeNextPass);
    RUN_TEST(testAutoPauseAndExpiryReturnToPreviouslyInstalledGif);
    RUN_TEST(testCoverArrivingAfterMetadataAndNewTrackKeepTextStable);
    RUN_TEST(testPrimaryColorWordsReachSpiUnchangedFromLittleEndianRows);
    RUN_TEST(testTrackChangeClearsCompletedCoverBeforeNewMetadata);
    return UNITY_END();
}
