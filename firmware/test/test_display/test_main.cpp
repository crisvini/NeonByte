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
    std::uint64_t monotonicMillis() const override { return 0; }
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
    TEST_ASSERT_EQUAL_UINT8(0, display_test::panelState.rotation);
    TEST_ASSERT_EQUAL_HEX8(0xc8, display_test::panelState.madctl);
    TEST_ASSERT_TRUE(display_test::panelState.inverted);
}

} // namespace

int main() {
    UNITY_BEGIN();
    RUN_TEST(testGifFrameDelayAndLoopingUseDeviceDisplayTick);
    RUN_TEST(testSlowFrameRenderingDoesNotAddASecondFullDelay);
    RUN_TEST(testDisplayInitializationUsesBoundedSpiAndRetainsProvisionalProfile);
    return UNITY_END();
}
