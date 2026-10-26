#include <unity.h>

#include "neonbyte/animation_reader.h"
#include "neonbyte/protocol.h"
#include "neonbyte/scene_manager.h"

#include <algorithm>
#include <cstdint>
#include <cstring>
#include <string>
#include <string_view>
#include <vector>

using namespace neonbyte;

namespace {

class FakeClock final : public Clock {
public:
    std::uint64_t currentMillis = 0;
    std::uint64_t currentUnixMillis = 0;

    std::uint64_t monotonicMillis() const override {
        return currentMillis;
    }

    std::uint64_t unixMillis() const override {
        return currentUnixMillis;
    }
};

class FakeStorage final : public Storage {
public:
    bool modeAvailable = false;
    bool modeWriteSucceeds = true;
    DisplayMode storedMode = DisplayMode::automatic;
    std::uint64_t availableBytes = 65'536;
    std::vector<std::uint8_t> animationBytes;
    mutable std::size_t largestRead = 0;

    bool loadMode(DisplayMode& mode) const override {
        if (!modeAvailable) {
            return false;
        }
        mode = storedMode;
        return true;
    }

    bool saveMode(DisplayMode mode) override {
        if (!modeWriteSucceeds) {
            return false;
        }
        storedMode = mode;
        modeAvailable = true;
        return true;
    }

    std::uint64_t freeBytes() const override {
        return availableBytes;
    }

    std::uint32_t animationSize() const override {
        return static_cast<std::uint32_t>(animationBytes.size());
    }

    bool readAnimationAt(std::uint32_t offset, std::uint8_t* destination, std::size_t length) const override {
        largestRead = std::max(largestRead, length);
        if (offset > animationBytes.size() || length > animationBytes.size() - offset) {
            return false;
        }
        std::copy_n(animationBytes.data() + offset, length, destination);
        return true;
    }
};

class FakeDisplay final : public DisplayRenderer {
public:
    enum class LastRender { none, gif, waiting, spotify };
    LastRender lastRender = LastRender::none;
    std::uint64_t displayedProgress = 0;

    void showGif() override {
        lastRender = LastRender::gif;
    }

    void showSpotifyWaiting() override {
        lastRender = LastRender::waiting;
    }

    void showSpotify(const NowPlaying&, std::uint64_t progressMs) override {
        lastRender = LastRender::spotify;
        displayedProgress = progressMs;
    }

    void beginAnimationFrame(std::uint16_t, std::uint16_t) override {}
    void writeAnimationPixels(std::uint32_t, const std::uint8_t*, std::size_t) override {}
    void endAnimationFrame(std::uint16_t) override {}
};

class FakeAuthenticator final : public RequestAuthenticator {
public:
    bool allowRequests = true;

    bool isAuthorized(std::string_view) const override {
        return allowRequests;
    }
};

class FakeNetwork final : public NetworkOperations {
public:
    bool hasRequest = false;
    HttpRequest request{};
    HttpResponse response{};
    bool responseSent = false;

    bool receive(HttpRequest& received) override {
        if (!hasRequest) {
            return false;
        }
        received = request;
        hasRequest = false;
        return true;
    }

    bool respond(const HttpResponse& sent) override {
        response = sent;
        responseSent = true;
        return true;
    }
};

void setText(FixedText& target, std::string_view value) {
    target.length = static_cast<std::uint16_t>(value.size());
    std::copy(value.begin(), value.end(), target.bytes.begin());
}

NowPlaying makeTrack(bool isPlaying = true, std::uint64_t durationMs = 1'000, std::uint64_t progressMs = 200) {
    NowPlaying track{};
    setText(track.trackId, "track-1");
    setText(track.title, "Example Track");
    setText(track.artist, "Example Artist");
    track.isPlaying = isPlaying;
    track.durationMs = durationMs;
    track.progressMs = progressMs;
    track.sampledAtUnixMs = 1'790'000'000'000;
    return track;
}

HttpRequest jsonRequest(HttpMethod method, std::string_view path, std::string_view body,
                        std::string_view authorization = "Bearer test-token") {
    return {method, path, authorization, "application/json; charset=utf-8", body};
}

void writeLittleEndian16(std::vector<std::uint8_t>& bytes, std::size_t offset, std::uint16_t value) {
    bytes[offset] = static_cast<std::uint8_t>(value & 0xff);
    bytes[offset + 1] = static_cast<std::uint8_t>((value >> 8) & 0xff);
}

std::vector<std::uint8_t> makeAnimation(std::uint16_t frames = 1, std::uint16_t delayMs = 100) {
    constexpr std::size_t headerBytes = 11;
    constexpr std::size_t framePixelBytes = 240U * 240U * 2U;
    std::vector<std::uint8_t> bytes(headerBytes + frames * (2U + framePixelBytes), 0);
    bytes[0] = 'N';
    bytes[1] = 'B';
    bytes[2] = 'I';
    bytes[3] = 'F';
    bytes[4] = 1;
    writeLittleEndian16(bytes, 5, 240);
    writeLittleEndian16(bytes, 7, 240);
    writeLittleEndian16(bytes, 9, frames);
    for (std::uint16_t index = 0; index < frames; ++index) {
        writeLittleEndian16(bytes, headerBytes + index * (2U + framePixelBytes), delayMs);
    }
    return bytes;
}

void testAutoSceneRequiresFreshHeartbeatAndPlayingTrack() {
    FakeClock clock;
    FakeStorage storage;
    SceneManager scenes(clock, storage);
    scenes.heartbeat();
    scenes.updateNowPlaying(makeTrack(true));

    TEST_ASSERT_EQUAL(ActiveScene::spotify, scenes.currentState().activeScene);
    clock.currentMillis = DEFAULT_HEARTBEAT_TIMEOUT_MS;
    TEST_ASSERT_EQUAL(ActiveScene::spotify, scenes.currentState().activeScene);
    clock.currentMillis += 1;
    TEST_ASSERT_EQUAL(ActiveScene::gif, scenes.currentState().activeScene);
}

void testManualModesPersistAndSpotifyShowsWaitingWhenStale() {
    FakeClock clock;
    FakeStorage storage;
    SceneManager scenes(clock, storage);
    TEST_ASSERT_EQUAL(DisplayMode::automatic, scenes.mode());
    TEST_ASSERT_TRUE(scenes.setMode(DisplayMode::spotify));
    TEST_ASSERT_EQUAL(DisplayMode::spotify, storage.storedMode);
    SceneManager restarted(clock, storage);
    TEST_ASSERT_EQUAL(DisplayMode::spotify, restarted.mode());
    TEST_ASSERT_TRUE(scenes.currentState().waiting);

    scenes.updateNowPlaying(makeTrack(false));
    scenes.heartbeat();
    TEST_ASSERT_TRUE(scenes.currentState().waiting);
    TEST_ASSERT_EQUAL(ActiveScene::spotify, scenes.currentState().activeScene);
    scenes.updateNowPlaying(makeTrack(true));
    clock.currentMillis += DEFAULT_HEARTBEAT_TIMEOUT_MS + 1;
    TEST_ASSERT_TRUE(scenes.currentState().waiting);
    TEST_ASSERT_EQUAL(ActiveScene::spotify, scenes.currentState().activeScene);

    TEST_ASSERT_TRUE(scenes.setMode(DisplayMode::gif));
    TEST_ASSERT_EQUAL(ActiveScene::gif, scenes.currentState().activeScene);
}

void testFailedModePersistenceDoesNotChangeCurrentMode() {
    FakeClock clock;
    FakeStorage storage;
    SceneManager scenes(clock, storage);
    storage.modeWriteSucceeds = false;

    TEST_ASSERT_FALSE(scenes.setMode(DisplayMode::gif));
    TEST_ASSERT_EQUAL(DisplayMode::automatic, scenes.mode());
}

void testPlaybackProgressAdvancesClampsAndStopsWhenPaused() {
    FakeClock clock;
    FakeStorage storage;
    SceneManager scenes(clock, storage);
    scenes.updateNowPlaying(makeTrack(true, 1'000, 900));
    clock.currentMillis = 250;
    TEST_ASSERT_EQUAL_UINT64(1'000, scenes.currentState().progressMs);

    scenes.updateNowPlaying(makeTrack(false, 1'000, 400));
    clock.currentMillis += 250;
    TEST_ASSERT_EQUAL_UINT64(400, scenes.currentState().progressMs);
}

void testPlayingProgressAccountsForTimeSinceTheAgentSample() {
    FakeClock clock;
    FakeStorage storage;
    SceneManager scenes(clock, storage);
    clock.currentMillis = 100;
    clock.currentUnixMillis = 1'000;
    NowPlaying track = makeTrack(true, 1'000, 200);
    track.sampledAtUnixMs = 700;
    scenes.updateNowPlaying(track);

    TEST_ASSERT_EQUAL_UINT64(500, scenes.currentState().progressMs);
    clock.currentMillis += 100;
    TEST_ASSERT_EQUAL_UINT64(600, scenes.currentState().progressMs);
}

void testSceneManagerRendersOnlyOneOfTheTwoScenes() {
    FakeClock clock;
    FakeStorage storage;
    SceneManager scenes(clock, storage);
    FakeDisplay display;

    scenes.render(display);
    TEST_ASSERT_EQUAL(FakeDisplay::LastRender::gif, display.lastRender);
    TEST_ASSERT_TRUE(scenes.setMode(DisplayMode::spotify));
    scenes.render(display);
    TEST_ASSERT_EQUAL(FakeDisplay::LastRender::waiting, display.lastRender);
    scenes.heartbeat();
    scenes.updateNowPlaying(makeTrack(true));
    scenes.render(display);
    TEST_ASSERT_EQUAL(FakeDisplay::LastRender::spotify, display.lastRender);
}

void testProtocolStatusMatchesV1AndDoesNotRequireAuthentication() {
    FakeClock clock;
    FakeStorage storage;
    SceneManager scenes(clock, storage);
    FakeAuthenticator authenticator;
    authenticator.allowRequests = false;
    ProtocolHandler protocol(scenes, storage, authenticator);

    const HttpResponse response = protocol.handle({HttpMethod::get, "/api/v1/status", {}, {}, {}},
                                                  {"0.1.0", "192.0.2.1"});
    TEST_ASSERT_EQUAL_UINT16(200, response.statusCode);
    TEST_ASSERT_NOT_NULL(std::strstr(response.body.data(), "\"protocolVersion\":\"v1\""));
    TEST_ASSERT_NOT_NULL(std::strstr(response.body.data(), "\"mode\":\"auto\""));
    TEST_ASSERT_NOT_NULL(std::strstr(response.body.data(), "\"activeScene\":\"gif\""));
    TEST_ASSERT_NOT_NULL(std::strstr(response.body.data(), "\"freeStorageBytes\":65536"));
}

void testStatusStringLimitsCountUtf8CodePointsLikeTheV1Schema() {
    FakeClock clock;
    FakeStorage storage;
    SceneManager scenes(clock, storage);
    FakeAuthenticator authenticator;
    ProtocolHandler protocol(scenes, storage, authenticator);
    std::string firmwareVersion;
    for (std::size_t index = 0; index < 64; ++index) {
        firmwareVersion.append("\xf0\x9f\x9a\x80");
    }

    const HttpResponse response = protocol.handle({HttpMethod::get, "/api/v1/status", {}, {}, {}},
                                                  {firmwareVersion, "192.0.2.1"});
    TEST_ASSERT_EQUAL_UINT16(200, response.statusCode);
}

void testProtocolModeRouteValidatesPersistsAndRequiresAuthentication() {
    FakeClock clock;
    FakeStorage storage;
    SceneManager scenes(clock, storage);
    FakeAuthenticator authenticator;
    ProtocolHandler protocol(scenes, storage, authenticator);
    const auto request = jsonRequest(HttpMethod::put, "/api/v1/mode", R"({"mode":"spotify"})");

    const HttpResponse response = protocol.handle(request, {"0.1.0", "192.0.2.1"});
    TEST_ASSERT_EQUAL_UINT16(204, response.statusCode);
    TEST_ASSERT_EQUAL(DisplayMode::spotify, scenes.mode());
    TEST_ASSERT_EQUAL(DisplayMode::spotify, storage.storedMode);

    authenticator.allowRequests = false;
    const HttpResponse unauthorized = protocol.handle(request, {"0.1.0", "192.0.2.1"});
    TEST_ASSERT_EQUAL_UINT16(401, unauthorized.statusCode);
    TEST_ASSERT_NOT_NULL(std::strstr(unauthorized.body.data(), "\"code\":\"unauthorized\""));
}

void testBearerAuthenticatorChecksSchemeAndExactConfiguredToken() {
    BearerTokenAuthenticator authenticator("secret-token");

    TEST_ASSERT_TRUE(authenticator.isAuthorized("Bearer secret-token"));
    TEST_ASSERT_FALSE(authenticator.isAuthorized("secret-token"));
    TEST_ASSERT_FALSE(authenticator.isAuthorized("Bearer secret-token-extra"));
    TEST_ASSERT_FALSE(authenticator.isAuthorized("Bearer wrong-token"));
}

void testProtocolRejectsInvalidClosedSchemaAndMalformedJson() {
    FakeClock clock;
    FakeStorage storage;
    SceneManager scenes(clock, storage);
    FakeAuthenticator authenticator;
    ProtocolHandler protocol(scenes, storage, authenticator);

    TEST_ASSERT_EQUAL_UINT16(400, protocol.handle(jsonRequest(HttpMethod::put, "/api/v1/mode", R"({"mode":"dance"})"),
                                                  {"0.1.0", "192.0.2.1"}).statusCode);
    TEST_ASSERT_EQUAL_UINT16(400, protocol.handle(jsonRequest(HttpMethod::put, "/api/v1/mode", R"({"mode":"gif","extra":1})"),
                                                  {"0.1.0", "192.0.2.1"}).statusCode);
    TEST_ASSERT_EQUAL_UINT16(400, protocol.handle(jsonRequest(HttpMethod::put, "/api/v1/mode", R"({"mode":"gif")"),
                                                  {"0.1.0", "192.0.2.1"}).statusCode);
}

void testProtocolSpotifyRouteValidatesFieldsAndClampsProgress() {
    FakeClock clock;
    FakeStorage storage;
    SceneManager scenes(clock, storage);
    FakeAuthenticator authenticator;
    ProtocolHandler protocol(scenes, storage, authenticator);
    const auto valid = jsonRequest(HttpMethod::put, "/api/v1/spotify",
        R"({"trackId":"example-track-id","title":"\ud83d\ude80","artist":"Example Artist","isPlaying":true,"durationMs":180000.0,"progressMs":42000,"sampledAtUnixMs":1790000000000})");

    TEST_ASSERT_EQUAL_UINT16(204, protocol.handle(valid, {"0.1.0", "192.0.2.1"}).statusCode);
    TEST_ASSERT_EQUAL_UINT64(42'000, scenes.currentState().progressMs);
    TEST_ASSERT_EQUAL_STRING("\xf0\x9f\x9a\x80", scenes.nowPlaying()->title.view().data());
    TEST_ASSERT_EQUAL_UINT16(400, protocol.handle(jsonRequest(HttpMethod::put, "/api/v1/spotify",
        R"({"trackId":"id","title":"title","artist":"artist","isPlaying":true,"durationMs":100,"progressMs":0,"sampledAtUnixMs":1,"unexpected":true})"),
        {"0.1.0", "192.0.2.1"}).statusCode);
    TEST_ASSERT_EQUAL_UINT16(400, protocol.handle(jsonRequest(HttpMethod::put, "/api/v1/spotify",
        R"({"trackId":"id","title":"title","artist":"artist","isPlaying":true,"durationMs":100,"progressMs":0,"sampledAtUnixMs":1.5})"),
        {"0.1.0", "192.0.2.1"}).statusCode);
}

void testHeartbeatRefreshesTimeoutAndBinaryRoutesStayExplicitlyUnavailable() {
    FakeClock clock;
    FakeStorage storage;
    SceneManager scenes(clock, storage);
    FakeAuthenticator authenticator;
    ProtocolHandler protocol(scenes, storage, authenticator);

    TEST_ASSERT_EQUAL_UINT16(204, protocol.handle({HttpMethod::post, "/api/v1/heartbeat", "Bearer test-token", {}, {}},
                                                  {"0.1.0", "192.0.2.1"}).statusCode);
    TEST_ASSERT_EQUAL_UINT16(415, protocol.handle({HttpMethod::put, "/api/v1/animation", "Bearer test-token", "application/octet-stream", {}},
                                                  {"0.1.0", "192.0.2.1"}).statusCode);
    TEST_ASSERT_EQUAL_UINT16(404, protocol.handle({HttpMethod::get, "/api/v2/status", {}, {}, {}},
                                                  {"0.1.0", "192.0.2.1"}).statusCode);
}

void testNetworkAdapterDispatchesOneRequestWithoutTransportCoupling() {
    FakeClock clock;
    FakeStorage storage;
    SceneManager scenes(clock, storage);
    FakeAuthenticator authenticator;
    ProtocolHandler protocol(scenes, storage, authenticator);
    FakeNetwork network;
    network.hasRequest = true;
    network.request = {HttpMethod::post, "/api/v1/heartbeat", "Bearer test-token", {}, {}};

    TEST_ASSERT_TRUE(dispatchOneRequest(network, protocol, {"0.1.0", "192.0.2.1"}));
    TEST_ASSERT_TRUE(network.responseSent);
    TEST_ASSERT_EQUAL_UINT16(204, network.response.statusCode);
}

void testAnimationReaderValidatesHeaderAndReadsRgb565InBoundedChunks() {
    FakeStorage storage;
    storage.animationBytes = makeAnimation(2, 120);
    AnimationReader reader(storage);
    AnimationMetadata metadata{};

    TEST_ASSERT_TRUE(reader.open(metadata));
    TEST_ASSERT_EQUAL_UINT16(240, metadata.width);
    TEST_ASSERT_EQUAL_UINT16(240, metadata.height);
    TEST_ASSERT_EQUAL_UINT16(2, metadata.frameCount);
    TEST_ASSERT_EQUAL_UINT32(240, metadata.durationMs);
    std::uint16_t frameDelayMs = 0;
    TEST_ASSERT_TRUE(reader.frameDelayMs(1, frameDelayMs));
    TEST_ASSERT_EQUAL_UINT16(120, frameDelayMs);
    TEST_ASSERT_FALSE(reader.frameDelayMs(metadata.frameCount, frameDelayMs));

    std::uint8_t chunk[256]{};
    std::size_t bytesRead = 0;
    TEST_ASSERT_TRUE(reader.readFrameChunk(1, 0, chunk, sizeof(chunk), bytesRead));
    TEST_ASSERT_EQUAL_UINT32(sizeof(chunk), bytesRead);
    TEST_ASSERT_EQUAL_UINT32(0, chunk[0]);
    TEST_ASSERT_TRUE(storage.largestRead <= sizeof(chunk));
    TEST_ASSERT_TRUE(sizeof(reader) < 240U * 240U * 2U);
}

void testAnimationReaderRejectsMalformedLengthsAndTiming() {
    FakeStorage storage;
    AnimationReader reader(storage);
    AnimationMetadata metadata{};

    storage.animationBytes = makeAnimation(1, 100);
    storage.animationBytes.pop_back();
    metadata.frameCount = 7;
    TEST_ASSERT_FALSE(reader.open(metadata));
    TEST_ASSERT_EQUAL_UINT16(0, metadata.frameCount);

    storage.animationBytes = makeAnimation(1, 19);
    TEST_ASSERT_FALSE(reader.open(metadata));

    storage.animationBytes = makeAnimation(1, 100);
    storage.animationBytes.push_back(0);
    TEST_ASSERT_FALSE(reader.open(metadata));

    storage.animationBytes = makeAnimation(20, 1'501);
    TEST_ASSERT_FALSE(reader.open(metadata));
}

} // namespace

int main(int, char**) {
    UNITY_BEGIN();
    RUN_TEST(testAutoSceneRequiresFreshHeartbeatAndPlayingTrack);
    RUN_TEST(testManualModesPersistAndSpotifyShowsWaitingWhenStale);
    RUN_TEST(testFailedModePersistenceDoesNotChangeCurrentMode);
    RUN_TEST(testPlaybackProgressAdvancesClampsAndStopsWhenPaused);
    RUN_TEST(testPlayingProgressAccountsForTimeSinceTheAgentSample);
    RUN_TEST(testSceneManagerRendersOnlyOneOfTheTwoScenes);
    RUN_TEST(testProtocolStatusMatchesV1AndDoesNotRequireAuthentication);
    RUN_TEST(testStatusStringLimitsCountUtf8CodePointsLikeTheV1Schema);
    RUN_TEST(testProtocolModeRouteValidatesPersistsAndRequiresAuthentication);
    RUN_TEST(testBearerAuthenticatorChecksSchemeAndExactConfiguredToken);
    RUN_TEST(testProtocolRejectsInvalidClosedSchemaAndMalformedJson);
    RUN_TEST(testProtocolSpotifyRouteValidatesFieldsAndClampsProgress);
    RUN_TEST(testHeartbeatRefreshesTimeoutAndBinaryRoutesStayExplicitlyUnavailable);
    RUN_TEST(testNetworkAdapterDispatchesOneRequestWithoutTransportCoupling);
    RUN_TEST(testAnimationReaderValidatesHeaderAndReadsRgb565InBoundedChunks);
    RUN_TEST(testAnimationReaderRejectsMalformedLengthsAndTiming);
    return UNITY_END();
}
