#ifdef ARDUINO_ARCH_ESP8266
#include "neonbyte/esp8266/display.h"
#include "neonbyte/scene_manager.h"
#include <algorithm>
namespace neonbyte {
namespace {
void metadataText(std::string_view text, SpotifyText& result) {
    result.text.length = 0;
    result.truncated = false;
    for (unsigned char character : text) {
        if ((character & 0xc0) == 0x80) continue;
        if (result.text.length == result.text.bytes.size()) {
            result.truncated = true;
            result.text.length = (SPOTIFY_TEXT_VIEWPORT_WIDTH - 18) / (6 * SPOTIFY_TEXT_SIZE);
            break;
        }
        result.text.bytes[result.text.length++] = character >= 32 && character < 127 ? character : '?';
    }
}
} // namespace

void DeviceDisplay::begin() {
#if NEONBYTE_ENABLE_DISPLAY
    if (initialized_) return;
    pinMode(DISPLAY_BACKLIGHT,OUTPUT); digitalWrite(DISPLAY_BACKLIGHT,HIGH);
    panel_.init(240,240,SPI_MODE3); panel_.setSPISpeed(20'000'000);
    panel_.setRotation(2); // Half turn with Adafruit's 240x240 offsets at (0, 0).
    const std::uint8_t madctl = 0x00; // RGB; keep rotation's half-turn and geometry bits unchanged.
    panel_.sendCommand(ST77XX_MADCTL,&madctl,1);
    panel_.invertDisplay(true); panel_.fillScreen(ST77XX_BLACK);
    digitalWrite(DISPLAY_BACKLIGHT,LOW); initialized_ = true;
#endif
}
void DeviceDisplay::textLine(std::string_view text, int x, int y, unsigned limit, std::uint16_t color,
                             unsigned size) {
    panel_.setCursor(x,y); panel_.setTextColor(color); panel_.setTextSize(size); panel_.setTextWrap(false);
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
void DeviceDisplay::drawSpotifyText(const SpotifyText& text, int y, std::uint16_t color, bool clear) {
    if (clear) panel_.fillRect(0,y,240,SPOTIFY_TEXT_LINE_HEIGHT,ST77XX_BLACK);
    textLine(text.text.view(),SPOTIFY_TEXT_X,y,text.text.length,color,SPOTIFY_TEXT_SIZE);
    if (text.truncated) {
        textLine("...",SPOTIFY_TEXT_X + text.text.length * 6 * SPOTIFY_TEXT_SIZE,y + 7,3,color,1);
    }
}
void DeviceDisplay::showSpotify(const NowPlaying& track, std::uint64_t) {
    if (!initialized_) return;
    const bool entering = scene_ != 2;
    if (entering) panel_.fillScreen(ST77XX_BLACK);
    const bool trackChanged = displayedTrack_.view() != track.trackId.view();
    if (trackChanged && !entering) panel_.fillRect(32,4,SPOTIFY_COVER_SIZE,SPOTIFY_COVER_SIZE,ST77XX_BLACK);
    if (entering || trackChanged || revision_ != storage_.assetRevision) {
        displayedTrack_ = track.trackId;
        coverRow_ = 0; revision_ = storage_.assetRevision;
    }
    scene_ = 2;
    SpotifyText title, artist;
    metadataText(track.title.view(),title);
    metadataText(track.artist.view(),artist);
    if (entering || (title.text.view() != titleText_.text.view() || title.truncated != titleText_.truncated)) {
        titleText_ = title;
        drawSpotifyText(titleText_,SPOTIFY_TITLE_Y,ST77XX_WHITE,!entering);
    }
    if (entering || (artist.text.view() != artistText_.text.view() || artist.truncated != artistText_.truncated)) {
        artistText_ = artist;
        drawSpotifyText(artistText_,SPOTIFY_ARTIST_Y,0x9cf3,!entering);
    }
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
            showSpotify(*state.nowPlaying,state.progressMs);
            // One cover row per loop leaves the HTTP and Wi-Fi services runnable.
            if (coverRow_ < SPOTIFY_COVER_SIZE) {
                if (!storage_.readCover(displayedTrack_.view(),(coverRow_*240/SPOTIFY_COVER_SIZE)*480,pixels_.data(),pixels_.size())) {
                    pixels_.fill(0);
                }
                panel_.startWrite(); panel_.setAddrWindow(32,4+coverRow_,SPOTIFY_COVER_SIZE,1);
                for (unsigned x=0;x<SPOTIFY_COVER_SIZE;++x) {
                    const unsigned source = (x*240/SPOTIFY_COVER_SIZE)*2;
                    panel_.SPI_WRITE16(pixels_[source] | (std::uint16_t(pixels_[source+1])<<8));
                }
                panel_.endWrite(); ++coverRow_;
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
