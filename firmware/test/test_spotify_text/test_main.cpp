#include "neonbyte/spotify_text.h"

#include <unity.h>

#include <array>
#include <cstddef>
#include <cstdint>

namespace {

constexpr std::uint8_t CLASSIC_A_COLUMNS[] = {0x7c, 0x12, 0x11, 0x12, 0x7c};
constexpr std::uint16_t TITLE_WHITE = 0xffff;
constexpr std::uint16_t ARTIST_GRAY = 0x9cf3;

void assertClassicA(std::uint16_t offset, std::uint8_t row, std::uint16_t color) {
    std::array<std::uint8_t, neonbyte::SPOTIFY_TEXT_ROW_BYTES + 2> output{};
    output.front() = 0xa5;
    output.back() = 0x5a;
    TEST_ASSERT_TRUE(neonbyte::composeSpotifyTextRow(
        "A", offset, row, color, output.data() + 1, neonbyte::SPOTIFY_TEXT_ROW_BYTES));
    TEST_ASSERT_EQUAL_HEX8(0xa5, output.front());
    TEST_ASSERT_EQUAL_HEX8(0x5a, output.back());

    const int letterLeft = 8 - static_cast<int>(offset);
    for (int screenX = 0; screenX < 240; ++screenX) {
        const int sourceX = screenX - letterLeft;
        std::uint16_t expected = 0;
        if (sourceX >= 0 && sourceX < 60 && row < 16) {
            const unsigned column = static_cast<unsigned>(sourceX) / 2;
            const unsigned sourceRow = row / 2;
            if (column < 5 && (CLASSIC_A_COLUMNS[column] & (1U << sourceRow))) expected = color;
        }
        const auto actual = static_cast<std::uint16_t>(output[1 + screenX * 2]) |
            static_cast<std::uint16_t>(static_cast<std::uint16_t>(output[2 + screenX * 2]) << 8);
        TEST_ASSERT_EQUAL_HEX16(expected, actual);
    }
}

void testClassicFontPixelsMatchHandCheckedAsciiAAtEveryScanline() {
    for (std::uint8_t row = 0; row < 20; ++row) {
        assertClassicA(0, row, TITLE_WHITE);
        assertClassicA(0, row, ARTIST_GRAY);
    }
}

void testOddAndEvenPhysicalOffsetsMoveTheClassicGlyphOnePixel() {
    for (const auto offset : {0, 1, 2, 7, 8, 9, 11, 12, 13, 68}) {
        for (std::uint8_t row = 0; row < 16; ++row) assertClassicA(offset, row, TITLE_WHITE);
    }
}

void testTextRowClipsTheGlyphAtBothScreenEdges() {
    for (const auto offset : {9, 11, 12, 13, 60, 67, 68}) assertClassicA(offset, 2, ARTIST_GRAY);

    std::array<std::uint8_t, neonbyte::SPOTIFY_TEXT_ROW_BYTES> output{};
    constexpr char repeatedA[] = "AAAAAAAAAAAAAAAAAAAA";
    TEST_ASSERT_TRUE(neonbyte::composeSpotifyTextRow(
        repeatedA, 0, 2, TITLE_WHITE, output.data(), output.size()));
    TEST_ASSERT_EQUAL_HEX16(0x0000, static_cast<std::uint16_t>(output[0]) |
        static_cast<std::uint16_t>(static_cast<std::uint16_t>(output[1]) << 8));
}

void testInvalidRowsOrSmallBuffersLeaveTheOutputUntouched() {
    std::array<std::uint8_t, neonbyte::SPOTIFY_TEXT_ROW_BYTES> output{};
    output.fill(0x5a);
    TEST_ASSERT_FALSE(neonbyte::composeSpotifyTextRow(
        "A", 0, 20, TITLE_WHITE, output.data(), output.size()));
    TEST_ASSERT_EQUAL_HEX8(0x5a, output.front());
    TEST_ASSERT_FALSE(neonbyte::composeSpotifyTextRow(
        "A", 0, 0, TITLE_WHITE, output.data(), output.size() - 1));
    TEST_ASSERT_EQUAL_HEX8(0x5a, output.front());
    TEST_ASSERT_FALSE(neonbyte::composeSpotifyTextRow(
        "A", 0, 0, TITLE_WHITE, nullptr, output.size()));
}

} // namespace

int main() {
    UNITY_BEGIN();
    RUN_TEST(testClassicFontPixelsMatchHandCheckedAsciiAAtEveryScanline);
    RUN_TEST(testOddAndEvenPhysicalOffsetsMoveTheClassicGlyphOnePixel);
    RUN_TEST(testTextRowClipsTheGlyphAtBothScreenEdges);
    RUN_TEST(testInvalidRowsOrSmallBuffersLeaveTheOutputUntouched);
    return UNITY_END();
}
