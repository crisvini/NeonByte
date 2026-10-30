#ifdef ARDUINO_ARCH_ESP8266
#include "neonbyte/esp8266/display.h"
#include "neonbyte/scene_manager.h"
#include <ESP8266WiFi.h>
#include <algorithm>
#include <cstdio>
#include <cstring>
namespace neonbyte {
namespace {
constexpr unsigned ANIMATION_REOPEN_RETRY_MS = 1000;
constexpr unsigned SPOTIFY_TEXT_ROWS_PER_TICK = 2;
constexpr std::uint32_t ANIMATION_TICK_BUDGET_US = 4000;
constexpr unsigned ANIMATION_ROWS_PER_TICK = 8;
constexpr unsigned ANIMATION_STEPS_PER_TICK = 32;

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
    result.offset = 0; result.reverse = false; result.lastStepMs = now; result.needsRender = true;
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
        if (scene_ == 3) panel_.fillScreen(ST77XX_BLACK);
        textRender_ = {};
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
        textRender_ = {};
        panel_.fillScreen(ST77XX_BLACK); textLine("Waiting for playback",20,116,32,ST77XX_WHITE); scene_ = 1;
    }
}

bool DeviceDisplay::startSpotifyTextRender(std::uint64_t now) {
    if (textRender_.active) return true;

    const auto textWidth = [](const SpotifyMarquee& text) {
        return static_cast<unsigned>(text.length) * 6 * SPOTIFY_TEXT_SIZE;
    };
    const auto endpoint = [&](const SpotifyMarquee& text) {
        const unsigned width = textWidth(text);
        return text.offset == 0 || (width > SPOTIFY_TEXT_VIEWPORT_WIDTH &&
            text.offset == width - SPOTIFY_TEXT_VIEWPORT_WIDTH);
    };
    const auto eligible = [&](const SpotifyMarquee& text) {
        if (text.needsRender) return true;
        if (textWidth(text) <= SPOTIFY_TEXT_VIEWPORT_WIDTH) return false;
        const auto interval = endpoint(text) ? SPOTIFY_MARQUEE_PAUSE_MS : SPOTIFY_MARQUEE_INTERVAL_MS;
        return now - text.lastStepMs >= interval;
    };

    const bool titleEligible = eligible(titleText_);
    const bool artistEligible = eligible(artistText_);
    if (!titleEligible && !artistEligible) return false;

    const bool artist = artistEligible &&
        (!titleEligible || artistText_.lastStepMs < titleText_.lastStepMs);
    auto& text = artist ? artistText_ : titleText_;
    textRender_ = {};
    textRender_.active = true;
    textRender_.artist = artist;
    textRender_.startedAtMs = now;
    textRender_.targetOffset = text.offset;
    textRender_.targetReverse = text.reverse;

    if (!text.needsRender) {
        const unsigned end = textWidth(text) - SPOTIFY_TEXT_VIEWPORT_WIDTH;
        if (text.reverse) {
            textRender_.targetOffset = text.offset > 0
                ? text.offset - SPOTIFY_MARQUEE_STEP_PIXELS : 0;
            textRender_.targetReverse = textRender_.targetOffset != 0;
        } else {
            textRender_.targetOffset = std::min<unsigned>(end,
                text.offset + SPOTIFY_MARQUEE_STEP_PIXELS);
            textRender_.targetReverse = textRender_.targetOffset == end;
        }
        textRender_.moving = true;
        text.needsRender = true;
        // The older deadline moves first, even when both display ticks are late.
        text.lastStepMs = now;
    }
    return true;
}

void DeviceDisplay::renderSpotifyTextRows(std::uint64_t now) {
    if (!textRender_.active || scene_ != 2) return;
    auto& text = textRender_.artist ? artistText_ : titleText_;
    const auto* cachedText = encodedWorkspace_.data() +
        (textRender_.artist ? MAX_TEXT_CODE_POINTS : 0);
    const unsigned y = textRender_.artist ? SPOTIFY_ARTIST_Y : SPOTIFY_TITLE_Y;
    const std::uint16_t color = textRender_.artist ? 0x9cf3 : ST77XX_WHITE;

    for (unsigned count = 0; count < SPOTIFY_TEXT_ROWS_PER_TICK &&
         textRender_.nextRow < SPOTIFY_TEXT_ROW_HEIGHT; ++count,++textRender_.nextRow) {
        const std::string_view content{reinterpret_cast<const char*>(cachedText),text.length};
        if (!composeSpotifyTextRow(content,textRender_.targetOffset,textRender_.nextRow,color,
                                   pixels_.data(),pixels_.size())) {
            textRender_ = {};
            return;
        }
        panel_.startWrite(); panel_.setAddrWindow(0,y+textRender_.nextRow,SPOTIFY_TEXT_ROW_WIDTH,1);
        for (unsigned x = 0; x < SPOTIFY_TEXT_ROW_WIDTH; ++x) {
            const auto pixel = static_cast<std::uint16_t>(pixels_[x*2]) |
                static_cast<std::uint16_t>(static_cast<std::uint16_t>(pixels_[x*2+1]) << 8);
            panel_.SPI_WRITE16(pixel);
        }
        panel_.endWrite();
    }
    if (textRender_.nextRow < SPOTIFY_TEXT_ROW_HEIGHT) return;

    const auto render = textRender_;
    text.needsRender = false;
    text.offset = render.targetOffset;
    text.reverse = render.targetReverse;
    const unsigned width = static_cast<unsigned>(text.length) * 6 * SPOTIFY_TEXT_SIZE;
    const unsigned end = width > SPOTIFY_TEXT_VIEWPORT_WIDTH
        ? width - SPOTIFY_TEXT_VIEWPORT_WIDTH : 0;
    const bool atEndpoint = text.offset == 0 || (end != 0 && text.offset == end);
    text.lastStepMs = render.moving && !atEndpoint ? render.startedAtMs : now;
    textRender_ = {};
}
void DeviceDisplay::showSpotify(const NowPlaying& track, std::uint64_t) {
    if (!initialized_) return;
    const bool entering = scene_ != 2;
    if (entering) { panel_.fillScreen(ST77XX_BLACK); textRender_ = {}; }
    const bool trackChanged = displayedTrack_.view() != track.trackId.view();
    if (trackChanged && !entering) panel_.fillRect(32,4,SPOTIFY_COVER_SIZE,SPOTIFY_COVER_SIZE,ST77XX_BLACK);
    const bool coverChanged = entering || trackChanged || coverRevision_ != storage_.assetRevision;
    if (coverChanged) {
        displayedTrack_ = track.trackId;
        coverRow_ = 0; coverRevision_ = storage_.assetRevision;
        if (textRender_.active && textRender_.moving) {
            auto& renderingText = textRender_.artist ? artistText_ : titleText_;
            renderingText.needsRender = true;
            textRender_ = {};
        }
    }
    scene_ = 2;
    auto* titleCache = encodedWorkspace_.data();
    auto* artistCache = titleCache + MAX_TEXT_CODE_POINTS;
    const bool titleChanged = entering || !metadataMatches(track.title.view(),titleText_,titleCache);
    const bool artistChanged = entering || !metadataMatches(track.artist.view(),artistText_,artistCache);
    if (entering || titleChanged) {
        metadataText(track.title.view(),titleText_,titleCache,displayNowMs_);
        if (textRender_.active && !textRender_.artist) textRender_ = {};
    }
    if (entering || artistChanged) {
        metadataText(track.artist.view(),artistText_,artistCache,displayNowMs_);
        if (textRender_.active && textRender_.artist) textRender_ = {};
    }
    if (trackChanged) {
        textRender_ = {};
        for (auto* text : {&titleText_,&artistText_}) {
            text->needsRender = true;
            text->offset = 0; text->reverse = false; text->lastStepMs = displayNowMs_;
        }
    }
}
void DeviceDisplay::beginAnimationFrame(std::uint16_t, std::uint16_t) {}
void DeviceDisplay::writeAnimationPixels(std::uint32_t offset, const std::uint8_t* pixels, std::size_t length) {
    AnimationWindowState window{};
    writeAnimationPixels(offset,pixels,length,window);
}
void DeviceDisplay::writeAnimationPixels(std::uint32_t offset, const std::uint8_t* pixels,
                                         std::size_t length, AnimationWindowState& window) {
    if (!initialized_ || pixels == nullptr || (offset & 1) || (length & 1) || length == 0 || length > 480) return;
    const auto pixelOffset = offset / 2;
    const auto x = pixelOffset % 240;
    const auto y = pixelOffset / 240;
    const auto width = length / 2;
    if (y >= 240 || x + width > 240) return;
    auto* output = pixels_.data();
    if (pixels != output) std::memmove(output,pixels,length);
    for (std::size_t i = 0; i < length; i += 2) std::swap(output[i],output[i+1]);

    const bool continuesWindow = window.valid && window.x == x && window.width == width &&
        static_cast<std::uint32_t>(window.lastY) + 1 == y;
    panel_.startWrite();
    if (!continuesWindow) {
        panel_.setAddrWindow(x,y,width,240-y);
        window = {static_cast<std::uint16_t>(x),static_cast<std::uint16_t>(width),
                  static_cast<std::uint16_t>(y),true};
    } else {
        window.lastY = static_cast<std::uint16_t>(y);
    }
    panel_.writePixelBytes(output,length);
    panel_.endWrite();
    for (std::size_t i = 0; i < length; i += 2) std::swap(output[i],output[i+1]);
}
void DeviceDisplay::endAnimationFrame(std::uint16_t) {}
void DeviceDisplay::tick(const SceneManager& scenes, std::uint64_t now) {
    if (!initialized_) return;
    displayNowMs_ = now;
    const auto state = scenes.currentState();
    if (!state.agentAvailable) {
        std::array<std::uint8_t,4> address{};
        if (WiFi.status() == WL_CONNECTED) {
            const auto ip = WiFi.localIP();
            for (unsigned i = 0; i < address.size(); ++i) address[i] = ip[i];
        }
        const bool entering = scene_ != 3;
        if (entering) {
            panel_.fillScreen(ST77XX_BLACK);
            textRender_ = {};
            scene_ = 3;
            textLine("NEONBYTE",72,42,8,ST77XX_GREEN,2);
            textLine("Agent disconnected",66,75,18,ST77XX_WHITE);
        }
        if (entering || address != diagnosticIp_) {
            if (!entering) panel_.fillRect(0,104,240,44,ST77XX_BLACK);
            diagnosticIp_ = address;
            if (address == std::array<std::uint8_t,4>{}) {
                textLine("Wi-Fi disconnected",66,116,20,ST77XX_WHITE);
            } else {
                char ipText[16];
                std::snprintf(ipText,sizeof(ipText),"%u.%u.%u.%u",unsigned(address[0]),unsigned(address[1]),
                              unsigned(address[2]),unsigned(address[3]));
                const auto length = std::char_traits<char>::length(ipText);
                textLine(ipText,static_cast<int>((240 - length * 12) / 2),116,15,ST77XX_WHITE,2);
            }
        }
        storage_.promoteAnimationCandidateAtBoundary();
        return;
    }
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
            } else {
                startSpotifyTextRender(now);
                renderSpotifyTextRows(now);
            }
        }
        return;
    }
    if (scene_ != 0) {
        showGif();
        if (animationNeedsReopen_) { nextFrame_ = now + ANIMATION_REOPEN_RETRY_MS; return; }
    }
    // Consume the deadline once before promoting a staged asset or decoding its successor.
    if (nextFrame_ && now >= nextFrame_) {
        nextFrame_ = 0;
        storage_.promoteAnimationCandidateAtBoundary();
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
        const auto tickStarted = micros();
        AnimationWindowState window{};
        unsigned steps = 0;
        unsigned rows = 0;
        while (steps < ANIMATION_STEPS_PER_TICK && rows < ANIMATION_ROWS_PER_TICK) {
            if (static_cast<std::uint32_t>(micros() - tickStarted) >= ANIMATION_TICK_BUDGET_US) return;
            const auto status = animationV2_.step();
            ++steps;
            if (status == AnimationDecodeStatus::Error) {
                metadataV2_ = {}; animationNeedsReopen_ = true; return;
            }
            if (status == AnimationDecodeStatus::AnimationComplete) {
                animationV2_.restart(); animationFrameNeedsStart_ = true;
                continue;
            }
            if (animationFrameNeedsStart_) {
                beginAnimationFrame(240,240); frameStarted_ = now; animationFrameNeedsStart_ = false;
            }
            if (status == AnimationDecodeStatus::RowReady) {
                const auto decoded = animationV2_.row();
                const auto pixelByteOffset = (static_cast<std::uint32_t>(decoded.y) * 240 + decoded.x) * 2;
                writeAnimationPixels(pixelByteOffset,decoded.pixels,decoded.byteCount,window);
                animationV2_.consumeRow();
                ++rows;
                continue;
            }
            if (status == AnimationDecodeStatus::FrameComplete) {
                const auto info = animationV2_.frameInfo();
                endAnimationFrame(info.delayMs);
                if (info.kind == AnimationFrameKind::Hold) frameStarted_ = now;
                nextFrame_ = frameStarted_ + info.delayMs;
                animationFrameNeedsStart_ = true;
                return;
            }
        }
        return;
    }
    if (!metadata_.frameCount) return;
    if (now < nextFrame_) return;
    const auto tickStarted = micros();
    AnimationWindowState window{};
    unsigned rows = 0;
    while (rows < ANIMATION_ROWS_PER_TICK) {
        if (static_cast<std::uint32_t>(micros() - tickStarted) >= ANIMATION_TICK_BUDGET_US) return;
        if (!offset_) { beginAnimationFrame(240,240); frameStarted_ = now; }
        std::size_t count = 0;
        if (!animation_.readFrameChunk(frame_,offset_,pixels_.data(),pixels_.size(),count)) {
            metadata_ = {}; animationNeedsReopen_ = true; return;
        }
        writeAnimationPixels(offset_,pixels_.data(),count,window);
        offset_ += count;
        rows += static_cast<unsigned>(count / (240 * 2));
        if (offset_ == ANIMATION_FRAME_PIXEL_BYTES) {
            std::uint16_t delayMs = 0;
            if (!animation_.frameDelayMs(frame_,delayMs)) { metadata_ = {}; animationNeedsReopen_ = true; return; }
            endAnimationFrame(delayMs); nextFrame_ = frameStarted_ + delayMs; offset_ = 0;
            frame_ = (frame_ + 1) % metadata_.frameCount;
            return;
        }
    }
}
} // namespace neonbyte
#endif
