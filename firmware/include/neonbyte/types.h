#pragma once

#include <array>
#include <cstdint>
#include <string_view>

namespace neonbyte {

constexpr std::size_t MAX_TEXT_CODE_POINTS = 256;
constexpr std::size_t MAX_TEXT_UTF8_BYTES = MAX_TEXT_CODE_POINTS * 4;

enum class DisplayMode : std::uint8_t {
    automatic,
    spotify,
    gif,
};

enum class ActiveScene : std::uint8_t {
    spotify,
    gif,
};

struct FixedText {
    std::array<char, MAX_TEXT_UTF8_BYTES> bytes{};
    std::uint16_t length = 0;

    std::string_view view() const {
        return {bytes.data(), length};
    }
};

struct NowPlaying {
    FixedText trackId;
    FixedText title;
    FixedText artist;
    bool isPlaying = false;
    std::uint64_t durationMs = 0;
    std::uint64_t progressMs = 0;
    std::uint64_t sampledAtUnixMs = 0;
};

inline bool isValidMode(DisplayMode mode) {
    return mode == DisplayMode::automatic || mode == DisplayMode::spotify || mode == DisplayMode::gif;
}

inline std::string_view modeName(DisplayMode mode) {
    switch (mode) {
    case DisplayMode::automatic: return "auto";
    case DisplayMode::spotify: return "spotify";
    case DisplayMode::gif: return "gif";
    }
    return "auto";
}

inline std::string_view sceneName(ActiveScene scene) {
    return scene == ActiveScene::spotify ? "spotify" : "gif";
}

} // namespace neonbyte
