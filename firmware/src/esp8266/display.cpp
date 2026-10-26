#ifdef ARDUINO_ARCH_ESP8266
#include "neonbyte/esp8266/display.h"
#include "neonbyte/scene_manager.h"
#include <algorithm>
namespace neonbyte {
void DeviceDisplay::begin() {
#if NEONBYTE_ENABLE_DISPLAY
    pinMode(DISPLAY_BACKLIGHT,OUTPUT); digitalWrite(DISPLAY_BACKLIGHT,HIGH);
    panel_.init(240,240,SPI_MODE3); panel_.setSPISpeed(20'000'000);
    panel_.setRotation(0);
    const std::uint8_t bgr = 0xc8; // Rotation-zero MADCTL plus BGR; validate physically.
    panel_.sendCommand(ST77XX_MADCTL,&bgr,1);
    panel_.invertDisplay(true); panel_.fillScreen(ST77XX_BLACK);
    digitalWrite(DISPLAY_BACKLIGHT,LOW); initialized_ = true;
#endif
}
void DeviceDisplay::textLine(std::string_view text, int x, int y, unsigned limit, std::uint16_t color) {
    panel_.setCursor(x,y); panel_.setTextColor(color); panel_.setTextSize(1); panel_.setTextWrap(false);
    unsigned printed=0;
    for (unsigned char c : text) {
        if ((c & 0xc0) == 0x80) continue;
        if (printed++ >= limit) break;
        panel_.write(c >= 32 && c < 127 ? c : '?');
    }
}
void DeviceDisplay::setupCredentials(const DeviceConfiguration& configuration) {
    if (!initialized_) return;
    panel_.fillScreen(ST77XX_BLACK);
    textLine("NeonByte Wi-Fi setup",4,8,38,ST77XX_WHITE);
    textLine("AP password:",4,28,38,ST77XX_WHITE);
    textLine(configuration.apPassword,4,40,38,ST77XX_GREEN);
    textLine("Pairing token:",4,64,38,ST77XX_WHITE);
    for (unsigned line=0;line<4;++line) textLine({configuration.token+line*16,16},4,80+line*12,16,ST77XX_GREEN);
}
void DeviceDisplay::showGif() {
    if (!initialized_) return;
    if (scene_ != 0) {
        panel_.fillScreen(ST77XX_BLACK); scene_ = 0; offset_ = 0; frame_ = 0; nextFrame_ = 0;
        animation_.open(metadata_);
    }
}
void DeviceDisplay::showSpotifyWaiting() {
    if (!initialized_) return;
    if (scene_ != 1) {
        panel_.fillScreen(ST77XX_BLACK); textLine("Waiting for playback",20,116,32,ST77XX_WHITE); scene_ = 1;
    }
}
void DeviceDisplay::showSpotify(const NowPlaying& track, std::uint64_t progressMs) {
    if (!initialized_) return;
    if (scene_ != 2 || displayedTrack_.view() != track.trackId.view() || revision_ != storage_.assetRevision) {
        panel_.fillScreen(ST77XX_BLACK); displayedTrack_ = track.trackId;
        coverRow_ = 0; revision_ = storage_.assetRevision;
    }
    scene_ = 2;
    panel_.fillRect(0,154,240,86,ST77XX_BLACK);
    textLine(track.title.view(),8,162,37,ST77XX_WHITE);
    textLine(track.artist.view(),8,182,37,0x9cf3);
    panel_.fillRect(8,213,224,4,0x2104);
    const auto width = track.durationMs ? (static_cast<double>(progressMs)/track.durationMs)*224 : 0;
    panel_.fillRect(8,213,std::min(224,static_cast<int>(width)),4,ST77XX_GREEN);
}
void DeviceDisplay::beginAnimationFrame(std::uint16_t, std::uint16_t) {}
void DeviceDisplay::writeAnimationPixels(std::uint32_t offset, const std::uint8_t* pixels, std::size_t length) {
    if (!initialized_ || offset%480 || length != 480) return;
    // Copy little-endian RGB565 to aligned host-endian pixels without a full frame.
    panel_.startWrite(); panel_.setAddrWindow(0,offset/480,240,1);
    for (unsigned i=0;i<480;i+=2) panel_.SPI_WRITE16(pixels[i] | (std::uint16_t(pixels[i+1])<<8));
    panel_.endWrite();
}
void DeviceDisplay::endAnimationFrame(std::uint16_t) {}
void DeviceDisplay::tick(const SceneManager& scenes, std::uint64_t now) {
    if (!initialized_) return;
    const auto state = scenes.currentState();
    if (state.activeScene == ActiveScene::spotify) {
        if (state.waiting) showSpotifyWaiting();
        else {
            if (scene_ != 2 || now-lastUi_ >= 1000 || displayedTrack_.view() != state.nowPlaying->trackId.view() || revision_ != storage_.assetRevision) {
                showSpotify(*state.nowPlaying,state.progressMs); lastUi_ = now;
            }
            // One cover row per loop leaves the HTTP and Wi-Fi services runnable.
            if (coverRow_ < 144) {
                if (!storage_.readCover(displayedTrack_.view(),(coverRow_*240/144)*480,pixels_.data(),pixels_.size())) {
                    panel_.fillRect(48,4,144,144,ST77XX_BLACK); coverRow_ = 144;
                } else {
                    panel_.startWrite(); panel_.setAddrWindow(48,4+coverRow_,144,1);
                    for (unsigned x=0;x<144;++x) {
                        const unsigned source = (x*240/144)*2;
                        panel_.SPI_WRITE16(pixels_[source] | (std::uint16_t(pixels_[source+1])<<8));
                    }
                    panel_.endWrite(); ++coverRow_;
                }
            }
        }
        return;
    }
    showGif();
    if (revision_ != storage_.assetRevision) {
        revision_ = storage_.assetRevision; frame_ = 0; offset_ = 0; nextFrame_ = 0;
        animation_.open(metadata_);
    }
    if (!metadata_.frameCount || now < nextFrame_) return;
    if (!offset_) { beginAnimationFrame(240,240); frameStarted_ = now; }
    std::size_t count = 0;
    if (!animation_.readFrameChunk(frame_,offset_,pixels_.data(),pixels_.size(),count)) { metadata_ = {}; return; }
    writeAnimationPixels(offset_,pixels_.data(),count); offset_ += count;
    if (offset_ == ANIMATION_FRAME_PIXEL_BYTES) {
        std::uint16_t delayMs = 0;
        if (!animation_.frameDelayMs(frame_,delayMs)) { metadata_ = {}; return; }
        endAnimationFrame(delayMs); nextFrame_ = frameStarted_+delayMs; offset_ = 0; frame_ = (frame_+1)%metadata_.frameCount;
    }
}
} // namespace neonbyte
#endif
