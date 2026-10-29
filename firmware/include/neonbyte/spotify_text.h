#pragma once

#include <cstddef>
#include <cstdint>
#include <string_view>

namespace neonbyte {

constexpr std::size_t SPOTIFY_TEXT_ROW_WIDTH = 240;
constexpr std::size_t SPOTIFY_TEXT_ROW_HEIGHT = 20;
constexpr std::size_t SPOTIFY_TEXT_ROW_BYTES = SPOTIFY_TEXT_ROW_WIDTH * 2;
constexpr std::size_t SPOTIFY_TEXT_MAX_CODE_POINTS = 256;

// Compose one clipped, opaque RGB565 scanline using the current Adafruit GFX font.
// Pixels are encoded little-endian, matching the caller-owned display row buffer.
bool composeSpotifyTextRow(std::string_view text, std::uint16_t offset, std::uint8_t row,
                           std::uint16_t color, std::uint8_t* output,
                           std::size_t outputCapacity);

} // namespace neonbyte
