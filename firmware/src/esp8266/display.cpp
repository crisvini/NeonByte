#ifdef ARDUINO_ARCH_ESP8266
#include "neonbyte/esp8266/display.h"
#include "neonbyte/scene_manager.h"
#include <algorithm>
namespace neonbyte {
namespace {
constexpr unsigned ANIMATION_REOPEN_RETRY_MS = 1000;

bool metadataMatches(std::string_view text, const SpotifyMarquee& result, const std::uint8_t* cachedText) {
    unsigned index = 0;
    for (unsigned char character : text) {
        if ((character & 0xc0) == 0x80) continue;
        if (index >= result.length || cachedText[index++] !=
            (character >= 32 && character < 127 ? character : '?')) return false;
    }
    return index == result.length;
}
void metadataText(std::string_view text, SpotifyMarquee& result, std::uint8_t* cachedText, std::uint64_t now) {
    result.length = 0;
    for (unsigned char character : text) {
        if ((character & 0xc0) == 0x80) continue;
        if (result.length == MAX_TEXT_CODE_POINTS) break;
        cachedText[result.length++] = character >= 32 && character < 127 ? character : '?';
    }
    result.offset = 0; result.reverse = false; result.lastStepMs = now;
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
        scene_ = 0; offset_ = 0; frame_ = 0; nextFrame_ = 0; animationFrameNeedsStart_ = true;
        animationRevision_ = storage_.animationRevision;
        animationNeedsReopen_ = !openAnimation();
    }
}
bool DeviceDisplay::openAnimation() {
    metadata_ = {}; metadataV2_ = {}; animationV2Active_ = false;
    std::uint8_t version = 0;
    if (!storage_.readAnimationAt(4,&version,1)) return false;
    if (version == 1) return animation_.open(metadata_);
    if (version != 2 || !animationV2_.open(metadataV2_)) return false;
    animationV2Active_ = true;
    return true;
}
void DeviceDisplay::showSpotifyWaiting() {
    if (!initialized_) return;
    if (scene_ != 1) {
        panel_.fillScreen(ST77XX_BLACK); textLine("Waiting for playback",20,116,32,ST77XX_WHITE); scene_ = 1;
    }
}
void DeviceDisplay::drawSpotifyText(const SpotifyMarquee& text, const std::uint8_t* cachedText,
                                  int y, std::uint16_t color, bool clear) {
    if (clear) panel_.fillRect(0,y,240,SPOTIFY_TEXT_LINE_HEIGHT,ST77XX_BLACK);
    constexpr int cellWidth = 6 * SPOTIFY_TEXT_SIZE;
    const int x = static_cast<int>(SPOTIFY_TEXT_X) - text.offset;
    const unsigned first = x < 0 ? static_cast<unsigned>(-x / cellWidth) : 0;
    const unsigned end = std::min<unsigned>(text.length,static_cast<unsigned>((240 - x + cellWidth - 1) / cellWidth));
    const std::string_view visibleText{reinterpret_cast<const char*>(cachedText),text.length};
    if (first < end) textLine(visibleText.substr(first,end-first),x + static_cast<int>(first) * cellWidth,y,end-first,color,SPOTIFY_TEXT_SIZE);
}
bool DeviceDisplay::updateMarquee(SpotifyMarquee& text, const std::uint8_t* cachedText,
                                int y, std::uint16_t color, std::uint64_t now) {
    const unsigned width = text.length * 6 * SPOTIFY_TEXT_SIZE;
    if (width <= SPOTIFY_TEXT_VIEWPORT_WIDTH) return false;
    const unsigned end = width - SPOTIFY_TEXT_VIEWPORT_WIDTH;
    const bool atEnd = text.offset == 0 || text.offset == end;
    const auto interval = atEnd ? SPOTIFY_MARQUEE_PAUSE_MS : SPOTIFY_MARQUEE_INTERVAL_MS;
    if (now - text.lastStepMs < interval) return false;
    if (text.reverse) text.offset = text.offset > SPOTIFY_MARQUEE_STEP_PIXELS ? text.offset - SPOTIFY_MARQUEE_STEP_PIXELS : 0;
    else text.offset = std::min<unsigned>(end,text.offset + SPOTIFY_MARQUEE_STEP_PIXELS);
    if (text.offset == end) text.reverse = true;
    else if (text.offset == 0) text.reverse = false;
    text.lastStepMs = now;
    drawSpotifyText(text,cachedText,y,color,true);
    return true;
}
void DeviceDisplay::showSpotify(const NowPlaying& track, std::uint64_t) {
    if (!initialized_) return;
    const bool entering = scene_ != 2;
    if (entering) panel_.fillScreen(ST77XX_BLACK);
    const bool trackChanged = displayedTrack_.view() != track.trackId.view();
    if (trackChanged && !entering) panel_.fillRect(32,4,SPOTIFY_COVER_SIZE,SPOTIFY_COVER_SIZE,ST77XX_BLACK);
    if (entering || trackChanged || coverRevision_ != storage_.assetRevision) {
        displayedTrack_ = track.trackId;
        coverRow_ = 0; coverRevision_ = storage_.assetRevision;
    }
    scene_ = 2;
    auto* titleCache = encodedWorkspace_.data();
    auto* artistCache = titleCache + MAX_TEXT_CODE_POINTS;
    const bool titleChanged = entering || !metadataMatches(track.title.view(),titleText_,titleCache);
    const bool artistChanged = entering || !metadataMatches(track.artist.view(),artistText_,artistCache);
    if (entering || titleChanged || (trackChanged && titleText_.offset)) {
        metadataText(track.title.view(),titleText_,titleCache,displayNowMs_);
        drawSpotifyText(titleText_,titleCache,SPOTIFY_TITLE_Y,ST77XX_WHITE,!entering);
    }
    if (entering || artistChanged || (trackChanged && artistText_.offset)) {
        metadataText(track.artist.view(),artistText_,artistCache,displayNowMs_);
        drawSpotifyText(artistText_,artistCache,SPOTIFY_ARTIST_Y,0x9cf3,!entering);
    }
    if (trackChanged) { titleText_.lastStepMs = displayNowMs_; artistText_.lastStepMs = displayNowMs_; }
}
void DeviceDisplay::beginAnimationFrame(std::uint16_t, std::uint16_t) {}
void DeviceDisplay::writeAnimationPixels(std::uint32_t offset, const std::uint8_t* pixels, std::size_t length) {
    if (!initialized_ || pixels == nullptr || (offset & 1) || (length & 1) || length == 0 || length > 480) return;
    const auto pixelOffset = offset / 2;
    const auto x = pixelOffset % 240;
    const auto y = pixelOffset / 240;
    const auto width = length / 2;
    if (y >= 240 || x + width > 240) return;
    panel_.startWrite(); panel_.setAddrWindow(x,y,width,1);
    for (std::size_t i=0;i<length;i+=2) panel_.SPI_WRITE16(pixels[i] | (std::uint16_t(pixels[i+1])<<8));
    panel_.endWrite();
}
void DeviceDisplay::endAnimationFrame(std::uint16_t) {}
void DeviceDisplay::tick(const SceneManager& scenes, std::uint64_t now) {
    if (!initialized_) return;
    displayNowMs_ = now;
    const auto state = scenes.currentState();
    if (state.activeScene == ActiveScene::spotify) {
        storage_.promoteAnimationCandidateAtBoundary();
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
                if (coverRow_ == SPOTIFY_COVER_SIZE) {
                    titleText_.lastStepMs = now; artistText_.lastStepMs = now;
                }
            } else if (artistText_.lastStepMs < titleText_.lastStepMs) {
                if (!updateMarquee(artistText_,encodedWorkspace_.data()+MAX_TEXT_CODE_POINTS,SPOTIFY_ARTIST_Y,0x9cf3,now))
                    updateMarquee(titleText_,encodedWorkspace_.data(),SPOTIFY_TITLE_Y,ST77XX_WHITE,now);
            } else if (!updateMarquee(titleText_,encodedWorkspace_.data(),SPOTIFY_TITLE_Y,ST77XX_WHITE,now)) {
                updateMarquee(artistText_,encodedWorkspace_.data()+MAX_TEXT_CODE_POINTS,SPOTIFY_ARTIST_Y,0x9cf3,now);
            }
        }
        return;
    }
    if (scene_ != 0) {
        showGif();
        if (animationNeedsReopen_) { nextFrame_ = now + ANIMATION_REOPEN_RETRY_MS; return; }
    }
    if (!metadata_.frameCount && !metadataV2_.frameCount) storage_.promoteAnimationCandidateAtBoundary();
    if (animationNeedsReopen_ || animationRevision_ != storage_.animationRevision) {
        // Reuse the inactive frame deadline for failed-open backoff. A new asset bypasses it.
        if (animationNeedsReopen_ && animationRevision_ == storage_.animationRevision && now < nextFrame_) return;
        animationRevision_ = storage_.animationRevision; frame_ = 0; offset_ = 0; nextFrame_ = 0;
        animationFrameNeedsStart_ = true;
        if (!openAnimation()) { animationNeedsReopen_ = true; nextFrame_ = now + ANIMATION_REOPEN_RETRY_MS; return; }
        animationNeedsReopen_ = false;
    }
    if (animationV2Active_) {
        if (!metadataV2_.frameCount || now < nextFrame_) return;
        auto status = animationV2_.step();
        if (status == AnimationDecodeStatus::Error) { metadataV2_ = {}; animationNeedsReopen_ = true; return; }
        if (status == AnimationDecodeStatus::AnimationComplete) {
            animationV2_.restart(); animationFrameNeedsStart_ = true; nextFrame_ = now;
            status = animationV2_.step();
            if (status == AnimationDecodeStatus::Error) { metadataV2_ = {}; animationNeedsReopen_ = true; return; }
        }
        if (animationFrameNeedsStart_) {
            beginAnimationFrame(240,240); frameStarted_ = now; animationFrameNeedsStart_ = false;
        }
        if (status == AnimationDecodeStatus::RowReady) {
            const auto decoded = animationV2_.row();
            const auto pixelByteOffset = (static_cast<std::uint32_t>(decoded.y) * 240 + decoded.x) * 2;
            writeAnimationPixels(pixelByteOffset,decoded.pixels,decoded.byteCount);
            animationV2_.consumeRow();
        } else if (status == AnimationDecodeStatus::FrameComplete) {
            const auto info = animationV2_.frameInfo();
            endAnimationFrame(info.delayMs);
            storage_.promoteAnimationCandidateAtBoundary();
            if (info.kind == AnimationFrameKind::Hold) frameStarted_ = now;
            nextFrame_ = frameStarted_ + info.delayMs;
            animationFrameNeedsStart_ = true;
        }
        return;
    }
    if (!metadata_.frameCount) return;
    if (!metadata_.frameCount || now < nextFrame_) return;
    if (!offset_) { beginAnimationFrame(240,240); frameStarted_ = now; }
    std::size_t count = 0;
    if (!animation_.readFrameChunk(frame_,offset_,pixels_.data(),pixels_.size(),count)) { metadata_ = {}; animationNeedsReopen_ = true; return; }
    writeAnimationPixels(offset_,pixels_.data(),count); offset_ += count;
    if (offset_ == ANIMATION_FRAME_PIXEL_BYTES) {
        std::uint16_t delayMs = 0;
        if (!animation_.frameDelayMs(frame_,delayMs)) { metadata_ = {}; animationNeedsReopen_ = true; return; }
        endAnimationFrame(delayMs); nextFrame_ = frameStarted_+delayMs; offset_ = 0; frame_ = (frame_+1)%metadata_.frameCount;
        storage_.promoteAnimationCandidateAtBoundary();
    }
}
} // namespace neonbyte
#endif
