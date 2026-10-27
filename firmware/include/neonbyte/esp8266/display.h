#pragma once
#ifdef ARDUINO_ARCH_ESP8266
#include "neonbyte/esp8266/storage.h"
#include "neonbyte/scene_manager.h"
#include <Adafruit_ST7789.h>
namespace neonbyte {
// Researched from another SD PRO unit. Every display setting is provisional.
constexpr int DISPLAY_DC = 0;
constexpr int DISPLAY_RESET = 2;
constexpr int DISPLAY_BACKLIGHT = 5;
constexpr unsigned SPOTIFY_COVER_SIZE = 176;
constexpr unsigned SPOTIFY_TEXT_COLUMNS = 37;
using SpotifyText = BoundedText<SPOTIFY_TEXT_COLUMNS * 2>;
class BoundedDisplayPanel final : public Adafruit_ST7789 {
public:
    using Adafruit_ST7789::Adafruit_ST7789;
protected:
    void begin(std::uint32_t) override { Adafruit_ST77xx::begin(20'000'000); }
};
class DeviceDisplay final : public DisplayRenderer {
public:
    explicit DeviceDisplay(PersistentStorage& storage) : storage_(storage), animation_(storage), panel_(-1,DISPLAY_DC,DISPLAY_RESET) {}
    void begin();
    void setupCredentials(const DeviceConfiguration& configuration);
    void tick(const SceneManager& scenes, std::uint64_t now);
    void showGif() override;
    void showSpotifyWaiting() override;
    void showSpotify(const NowPlaying& track, std::uint64_t progressMs) override;
    void beginAnimationFrame(std::uint16_t width, std::uint16_t height) override;
    void writeAnimationPixels(std::uint32_t offset, const std::uint8_t* pixels, std::size_t length) override;
    void endAnimationFrame(std::uint16_t delayMs) override;
private:
    void textLine(std::string_view text, int x, int y, unsigned limit, std::uint16_t color);
    void metadataLines(const SpotifyText& text, int firstY, int secondY, std::uint16_t color);
    PersistentStorage& storage_;
    AnimationReader animation_;
    BoundedDisplayPanel panel_;
    std::array<std::uint8_t,480> pixels_{};
    AnimationMetadata metadata_{};
    std::uint32_t revision_ = 0, offset_ = 0;
    std::uint16_t frame_ = 0, coverRow_ = SPOTIFY_COVER_SIZE;
    FixedText displayedTrack_{};
    SpotifyText displayedTitle_{}, displayedArtist_{};
    std::uint64_t nextFrame_ = 0, frameStarted_ = 0;
    int scene_ = -1;
    bool initialized_ = false;
};
} // namespace neonbyte
#endif
