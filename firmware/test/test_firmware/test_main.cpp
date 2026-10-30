#include <unity.h>

#include "neonbyte/animation_reader.h"
#include "neonbyte/protocol.h"
#include "neonbyte/scene_manager.h"

#include <algorithm>
#include <cstdlib>
#include <cstdint>
#include <cstring>
#include <limits>
#include <new>
#include <string>
#include <string_view>
#include <vector>

using namespace neonbyte;

namespace {
bool countAllocations = false;
bool failAllocations = false;
std::size_t allocationCount = 0;
}

void* operator new(std::size_t size) {
    if (countAllocations) ++allocationCount;
    if (failAllocations) throw std::bad_alloc();
    if (void* memory = std::malloc(size)) return memory;
    throw std::bad_alloc();
}
void* operator new[](std::size_t size) {
    if (countAllocations) ++allocationCount;
    if (failAllocations) throw std::bad_alloc();
    if (void* memory = std::malloc(size)) return memory;
    throw std::bad_alloc();
}
void* operator new(std::size_t size, const std::nothrow_t&) noexcept {
    try { return ::operator new(size); } catch (...) { return nullptr; }
}
void* operator new[](std::size_t size, const std::nothrow_t&) noexcept {
    try { return ::operator new[](size); } catch (...) { return nullptr; }
}
void operator delete(void* memory) noexcept { std::free(memory); }
void operator delete[](void* memory) noexcept { std::free(memory); }
void operator delete(void* memory, std::size_t) noexcept { std::free(memory); }
void operator delete[](void* memory, std::size_t) noexcept { std::free(memory); }
void operator delete(void* memory, const std::nothrow_t&) noexcept { std::free(memory); }
void operator delete[](void* memory, const std::nothrow_t&) noexcept { std::free(memory); }

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
    std::uint32_t failedReadOffset = std::numeric_limits<std::uint32_t>::max();
    bool partialReadOnFailure = false;

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
        if (offset == failedReadOffset) {
            if (partialReadOnFailure && length > 0) {
                destination[0] = animationBytes[offset];
            }
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

std::string makeSpotifyJson(std::string_view titleJson = "\"title\"", std::string_view durationJson = "100") {
    return std::string(R"({"trackId":"id","title":)") + std::string(titleJson) +
        R"(,"artist":"artist","isPlaying":true,"durationMs":)" + std::string(durationJson) +
        R"(,"progressMs":0,"sampledAtUnixMs":1})";
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

void testHeartbeatsDoNotKeepStalePlaybackActive() {
    FakeClock clock;
    FakeStorage storage;
    SceneManager scenes(clock, storage);
    FakeDisplay display;
    scenes.updateNowPlaying(makeTrack(true, 180'000));
    scenes.heartbeat();

    clock.currentMillis = 45'000;
    scenes.heartbeat();
    TEST_ASSERT_EQUAL(ActiveScene::spotify, scenes.currentState().activeScene);
    clock.currentMillis = 45'001;
    scenes.heartbeat();
    TEST_ASSERT_TRUE(scenes.currentState().agentAvailable);
    scenes.render(display);
    TEST_ASSERT_EQUAL(FakeDisplay::LastRender::gif, display.lastRender);

    TEST_ASSERT_TRUE(scenes.setMode(DisplayMode::spotify));
    scenes.render(display);
    TEST_ASSERT_EQUAL(FakeDisplay::LastRender::waiting, display.lastRender);
    scenes.updateNowPlaying(makeTrack(true, 180'000));
    scenes.render(display);
    TEST_ASSERT_EQUAL(FakeDisplay::LastRender::spotify, display.lastRender);
}

void testOldSpotifySamplesExpireEvenWhenReceivedAgain() {
    FakeClock clock;
    FakeStorage storage;
    SceneManager scenes(clock, storage);
    NowPlaying track = makeTrack(true, 180'000);
    track.sampledAtUnixMs = 1'000;
    clock.currentUnixMillis = 46'000;
    scenes.heartbeat();
    scenes.updateNowPlaying(track);
    TEST_ASSERT_EQUAL(ActiveScene::spotify, scenes.currentState().activeScene);
    clock.currentUnixMillis = 46'001;
    scenes.updateNowPlaying(track);
    TEST_ASSERT_EQUAL(ActiveScene::gif, scenes.currentState().activeScene);
}

void testPlaybackFreshnessIncludesSampleAgeAndUsesMonotonicTime() {
    FakeClock clock;
    FakeStorage storage;
    SceneManager scenes(clock, storage);
    NowPlaying track = makeTrack(true, 180'000);
    track.sampledAtUnixMs = 1'000;
    clock.currentUnixMillis = 45'000;
    clock.currentMillis = 100;
    scenes.updateNowPlaying(track);
    scenes.heartbeat();
    clock.currentUnixMillis = 0;
    clock.currentMillis = 1'100;
    TEST_ASSERT_EQUAL(ActiveScene::spotify, scenes.currentState().activeScene);
    clock.currentMillis = 1'101;
    TEST_ASSERT_EQUAL(ActiveScene::gif, scenes.currentState().activeScene);
    clock.currentMillis = 99;
    TEST_ASSERT_EQUAL(ActiveScene::gif, scenes.currentState().activeScene);
}

void testFutureSampleAndExtremeProgressDoNotOverflow() {
    FakeClock clock;
    FakeStorage storage;
    SceneManager scenes(clock, storage);
    clock.currentUnixMillis = 10;
    NowPlaying track = makeTrack(true, std::numeric_limits<std::uint64_t>::max(),
                                 std::numeric_limits<std::uint64_t>::max() - 1);
    scenes.updateNowPlaying(track);
    scenes.heartbeat();
    TEST_ASSERT_EQUAL(ActiveScene::spotify, scenes.currentState().activeScene);
    clock.currentMillis = 2;
    TEST_ASSERT_EQUAL_UINT64(std::numeric_limits<std::uint64_t>::max(), scenes.currentState().progressMs);
    track.durationMs = 100;
    track.progressMs = 200;
    scenes.updateNowPlaying(track);
    TEST_ASSERT_EQUAL_UINT64(100, scenes.currentState().progressMs);
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

void testProtocolAcceptsJsonWhitespaceAroundEveryValueType() {
    FakeClock clock;
    FakeStorage storage;
    SceneManager scenes(clock, storage);
    FakeAuthenticator authenticator;
    ProtocolHandler protocol(scenes, storage, authenticator);

    TEST_ASSERT_EQUAL_UINT16(204, protocol.handle(jsonRequest(HttpMethod::put, "/api/v1/mode",
        " \n{ \"mode\" \t: \r\n\"spotify\" } \t"), {}).statusCode);
    TEST_ASSERT_EQUAL(DisplayMode::spotify, scenes.mode());
    TEST_ASSERT_EQUAL_UINT16(204, protocol.handle(jsonRequest(HttpMethod::put, "/api/v1/spotify",
        R"({
            "trackId": "example-track-id",
            "title": "Example Track",
            "artist": "Example Artist",
            "isPlaying": true,
            "durationMs": 180000,
            "progressMs": 42000,
            "sampledAtUnixMs": 1790000000000
        })"), {}).statusCode);
    TEST_ASSERT_EQUAL_UINT64(42'000, scenes.currentState().progressMs);
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

void testProtocolRejectsMalformedJsonWithoutChangingPlayback() {
    FakeClock clock;
    FakeStorage storage;
    SceneManager scenes(clock, storage);
    FakeAuthenticator authenticator;
    ProtocolHandler protocol(scenes, storage, authenticator);
    scenes.updateNowPlaying(makeTrack());
    const std::string valid = makeSpotifyJson();
    const std::string duplicate = valid.substr(0, valid.size() - 1) + R"(,"title":"duplicate"})";
    const std::string missing = R"({"trackId":"id","title":"title","artist":"artist","isPlaying":true,"durationMs":100,"progressMs":0})";
    const std::string wrongType = makeSpotifyJson("null");
    const std::string invalidBodies[] = {
        "", "{}", "[]", valid.substr(0, valid.size() - 1), valid + "x", duplicate, missing, wrongType,
        R"({"trackId":"","title":"title","artist":"artist","isPlaying":true,"durationMs":100,"progressMs":0,"sampledAtUnixMs":1})",
        R"({"trackId":"id","title":"title","artist":"artist","isPlaying":1,"durationMs":100,"progressMs":0,"sampledAtUnixMs":1})",
        valid.substr(0, valid.size() - 1) + ",}"
    };
    for (const auto& body : invalidBodies) {
        TEST_ASSERT_EQUAL_UINT16_MESSAGE(400, protocol.handle(
            jsonRequest(HttpMethod::put, "/api/v1/spotify", body), {}).statusCode, body.c_str());
        TEST_ASSERT_TRUE(scenes.nowPlaying()->trackId.view() == "track-1");
        TEST_ASSERT_EQUAL_UINT64(200, scenes.currentState().progressMs);
    }
    clock.currentMillis = 45'001;
    protocol.handle(jsonRequest(HttpMethod::put, "/api/v1/spotify", duplicate), {});
    scenes.heartbeat();
    TEST_ASSERT_EQUAL(ActiveScene::gif, scenes.currentState().activeScene);
}

void testProtocolHandlerDoesNotRetainASecondTrack() {
    TEST_ASSERT_LESS_OR_EQUAL_UINT32(4 * sizeof(void*), sizeof(ProtocolHandler));
}

void testSpotifyMaximumFieldsAndLateFailuresRemainAtomic() {
    FakeClock clock;
    clock.currentMillis = 1'000;
    clock.currentUnixMillis = 1'790'000'000'000;
    FakeStorage storage;
    SceneManager scenes(clock, storage);
    FakeAuthenticator authenticator;
    ProtocolHandler protocol(scenes, storage, authenticator);
    scenes.heartbeat();
    std::string field;
    for (unsigned i = 0; i < 256; ++i) field += R"(\ud83d\ude80)";
    const std::string body = "{\"artist\":\"" + field + "\",\"trackId\":\"" + field +
        "\",\"title\":\"" + field +
        R"(","isPlaying":true,"durationMs":100000,"progressMs":100,"sampledAtUnixMs":1790000000000})";
    TEST_ASSERT_EQUAL_UINT16(204, protocol.handle(jsonRequest(HttpMethod::put, "/api/v1/spotify", body), {}).statusCode);
    TEST_ASSERT_EQUAL_UINT16(1024, scenes.nowPlaying()->trackId.length);
    TEST_ASSERT_EQUAL_UINT16(1024, scenes.nowPlaying()->title.length);
    TEST_ASSERT_EQUAL_UINT16(1024, scenes.nowPlaying()->artist.length);
    const NowPlaying original = *scenes.nowPlaying();
    clock.currentMillis = 3'000;
    const std::string invalid[] = {
        body.substr(0, body.size() - 1),
        body.substr(0, body.size() - 1) + R"(,"isPlaying":false})",
        body + " trailing",
        body.substr(0, body.find(",\"sampledAtUnixMs\"")) + "}",
        makeSpotifyJson(R"("\ud800")"),
        makeSpotifyJson("\"title\"", "18446744073709551616")
    };
    for (const auto& value : invalid) {
        TEST_ASSERT_EQUAL_UINT16(400, protocol.handle(jsonRequest(HttpMethod::put, "/api/v1/spotify", value), {}).statusCode);
        const auto& actual = *scenes.nowPlaying();
        TEST_ASSERT_TRUE(actual.trackId.view() == original.trackId.view());
        TEST_ASSERT_TRUE(actual.title.view() == original.title.view());
        TEST_ASSERT_TRUE(actual.artist.view() == original.artist.view());
        TEST_ASSERT_EQUAL(original.isPlaying, actual.isPlaying);
        TEST_ASSERT_EQUAL_UINT64(original.durationMs, actual.durationMs);
        TEST_ASSERT_EQUAL_UINT64(original.progressMs, actual.progressMs);
        TEST_ASSERT_EQUAL_UINT64(original.sampledAtUnixMs, actual.sampledAtUnixMs);
        TEST_ASSERT_EQUAL_UINT64(2'100, scenes.currentState().progressMs);
    }
    clock.currentMillis = 46'001;
    scenes.heartbeat();
    TEST_ASSERT_EQUAL(ActiveScene::gif, scenes.currentState().activeScene);
}

void testSpotifyRequestCanAliasTheCurrentTrack() {
    FakeClock clock;
    FakeStorage storage;
    SceneManager scenes(clock, storage);
    FakeAuthenticator authenticator;
    ProtocolHandler protocol(scenes, storage, authenticator);
    auto previous = makeTrack();
    const std::string body = makeSpotifyJson("\"updated title\"", "1234");
    setText(previous.title, body);
    scenes.updateNowPlaying(previous);
    const auto aliasedBody = scenes.nowPlaying()->title.view();
    TEST_ASSERT_EQUAL_UINT16(204, protocol.handle(jsonRequest(HttpMethod::put, "/api/v1/spotify", aliasedBody), {}).statusCode);
    TEST_ASSERT_TRUE(scenes.nowPlaying()->trackId.view() == "id");
    TEST_ASSERT_TRUE(scenes.nowPlaying()->title.view() == "updated title");
    TEST_ASSERT_EQUAL_UINT64(1234, scenes.nowPlaying()->durationMs);
}

void testSpotifyNormalRequestsDoNotAllocateAndAliasedFailurePreservesTrack() {
    FakeClock clock;
    FakeStorage storage;
    SceneManager scenes(clock, storage);
    FakeAuthenticator authenticator;
    ProtocolHandler protocol(scenes, storage, authenticator);
    const std::string body = makeSpotifyJson("\"updated title\"", "1234");
    allocationCount = 0; countAllocations = true;
    const auto normal = protocol.handle(jsonRequest(HttpMethod::put, "/api/v1/spotify", body), {});
    countAllocations = false;
    TEST_ASSERT_EQUAL_UINT16(204, normal.statusCode);
    TEST_ASSERT_EQUAL_UINT32(0, allocationCount);

    auto previous = makeTrack();
    setText(previous.title, body);
    scenes.updateNowPlaying(previous);
    const auto aliasedBody = scenes.nowPlaying()->title.view();
    failAllocations = true;
    const auto rejected = protocol.handle(jsonRequest(HttpMethod::put, "/api/v1/spotify", aliasedBody), {});
    failAllocations = false;
    TEST_ASSERT_EQUAL_UINT16(500, rejected.statusCode);
    TEST_ASSERT_TRUE(scenes.nowPlaying()->title.view() == body);
    TEST_ASSERT_TRUE(scenes.nowPlaying()->trackId.view() == "track-1");
    TEST_ASSERT_EQUAL_UINT64(previous.durationMs, scenes.nowPlaying()->durationMs);
}

void testSpotifyMaximumBodyAndLongExponentRemainValid() {
    FakeClock clock;
    FakeStorage storage;
    SceneManager scenes(clock, storage);
    FakeAuthenticator authenticator;
    ProtocolHandler protocol(scenes, storage, authenticator);
    std::string number = "0e" + std::string(12'000, '9');
    std::string body = makeSpotifyJson("\"title\"", number);
    TEST_ASSERT_LESS_OR_EQUAL_UINT32(12'288, body.size());
    body.append(12'288 - body.size(), ' ');
    TEST_ASSERT_EQUAL_UINT32(12'288, body.size());
    TEST_ASSERT_EQUAL_UINT16(204, protocol.handle(jsonRequest(HttpMethod::put, "/api/v1/spotify", body), {}).statusCode);
    TEST_ASSERT_EQUAL_UINT64(0, scenes.nowPlaying()->durationMs);
    body.back() = 'x';
    TEST_ASSERT_EQUAL_UINT16(400, protocol.handle(jsonRequest(HttpMethod::put, "/api/v1/spotify", body), {}).statusCode);
    TEST_ASSERT_EQUAL_UINT64(0, scenes.nowPlaying()->durationMs);
    TEST_ASSERT_TRUE(scenes.nowPlaying()->trackId.view() == "id");
}

void testProtocolValidatesUtf8EscapesAndCodePointLimits() {
    FakeClock clock;
    FakeStorage storage;
    SceneManager scenes(clock, storage);
    FakeAuthenticator authenticator;
    ProtocolHandler protocol(scenes, storage, authenticator);
    std::string title = "\"";
    for (std::size_t index = 0; index < 256; ++index) title += "\xf0\x9f\x9a\x80";
    title += '"';
    std::string body = makeSpotifyJson(title);
    TEST_ASSERT_EQUAL_UINT16(204, protocol.handle(jsonRequest(HttpMethod::put, "/api/v1/spotify", body), {}).statusCode);
    TEST_ASSERT_EQUAL_UINT16(1024, scenes.nowPlaying()->title.length);
    title.insert(title.size() - 1, "a");
    body = makeSpotifyJson(title);
    TEST_ASSERT_EQUAL_UINT16(400, protocol.handle(jsonRequest(HttpMethod::put, "/api/v1/spotify", body), {}).statusCode);

    std::string escapedTitle = "\"";
    for (std::size_t index = 0; index < 256; ++index) escapedTitle += R"(\ud83d\ude80)";
    escapedTitle += '"';
    body = makeSpotifyJson(escapedTitle);
    TEST_ASSERT_EQUAL_UINT16(204, protocol.handle(jsonRequest(HttpMethod::put, "/api/v1/spotify", body), {}).statusCode);
    TEST_ASSERT_EQUAL_UINT16(1024, scenes.nowPlaying()->title.length);
    const std::string invalidTitles[] = {
        R"("\ud800")", R"("\udc00")", R"("\ud800\u0041")", R"("\u12")", R"("\q")",
        "\"\xc0\xaf\"", "\"\xed\xa0\x80\"", "\"\xf4\x90\x80\x80\"", "\"\xe2\x82\"", "\"\x80\"", "\"\n\""
    };
    for (const auto& invalidTitle : invalidTitles) {
        body = makeSpotifyJson(invalidTitle);
        TEST_ASSERT_EQUAL_UINT16(400, protocol.handle(jsonRequest(HttpMethod::put, "/api/v1/spotify", body), {}).statusCode);
    }
    body = makeSpotifyJson(R"("\"\\\/\b\f\n\r\t\u0000")");
    TEST_ASSERT_EQUAL_UINT16(204, protocol.handle(jsonRequest(HttpMethod::put, "/api/v1/spotify", body), {}).statusCode);
    const char expected[] = {'"', '\\', '/', '\b', '\f', '\n', '\r', '\t', '\0'};
    TEST_ASSERT_EQUAL_UINT16(sizeof(expected), scenes.nowPlaying()->title.length);
    TEST_ASSERT_EQUAL_MEMORY(expected, scenes.nowPlaying()->title.bytes.data(), sizeof(expected));
}

void testProtocolAcceptsExactIntegerNotationAndRejectsOverflow() {
    FakeClock clock;
    FakeStorage storage;
    SceneManager scenes(clock, storage);
    FakeAuthenticator authenticator;
    ProtocolHandler protocol(scenes, storage, authenticator);
    const struct { const char* input; std::uint64_t expected; } validNumbers[] = {
        {"-0", 0}, {"0e999999999999999999999", 0}, {"1.2e2", 120}, {"1200e-1", 120},
        {"1.000", 1}, {"18446744073709551615", std::numeric_limits<std::uint64_t>::max()},
        {"184467440737095516150e-1", std::numeric_limits<std::uint64_t>::max()}
    };
    for (const auto& number : validNumbers) {
        const std::string body = makeSpotifyJson("\"title\"", number.input);
        TEST_ASSERT_EQUAL_UINT16_MESSAGE(204, protocol.handle(jsonRequest(HttpMethod::put, "/api/v1/spotify", body), {}).statusCode, number.input);
        TEST_ASSERT_EQUAL_UINT64(number.expected, scenes.nowPlaying()->durationMs);
    }
    const char* invalidNumbers[] = {
        "-1", "01", "+1", "1.", ".1", "1e", "1e+", "1.1", "1e-1", "18446744073709551616",
        "18446744073709551616.0", "18446744073709551616e0", "1e20", "1e99999999999999999999", "null", "true"
    };
    for (const auto* number : invalidNumbers) {
        const std::string body = makeSpotifyJson("\"title\"", number);
        TEST_ASSERT_EQUAL_UINT16_MESSAGE(400, protocol.handle(jsonRequest(HttpMethod::put, "/api/v1/spotify", body), {}).statusCode, number);
    }
}

void testEveryMutatingRouteAuthenticatesBeforeProcessing() {
    FakeClock clock;
    FakeStorage storage;
    SceneManager scenes(clock, storage);
    BearerTokenAuthenticator authenticator("test-token");
    ProtocolHandler protocol(scenes, storage, authenticator);
    const char* paths[] = {"/api/v1/mode", "/api/v1/spotify", "/api/v1/cover", "/api/v1/animation", "/api/v1/heartbeat"};
    const char* credentials[] = {"", "test-token", "Bearer wrong-token", "Bearer test-token-extra", "Bearer test-token "};
    for (const auto* path : paths) {
        for (const auto* credential : credentials) {
            const auto response = protocol.handle(jsonRequest(HttpMethod::put, path, "malformed", credential), {});
            TEST_ASSERT_EQUAL_UINT16(401, response.statusCode);
            TEST_ASSERT_NULL(std::strstr(response.body.data(), "test-token"));
        }
    }
    TEST_ASSERT_FALSE(storage.modeAvailable);
    TEST_ASSERT_NULL(scenes.nowPlaying());
    TEST_ASSERT_FALSE(scenes.currentState().agentAvailable);
    TEST_ASSERT_TRUE(authenticator.isAuthorized("bEaReR test-token"));
    BearerTokenAuthenticator unconfigured("");
    TEST_ASSERT_FALSE(unconfigured.isAuthorized("Bearer "));
}

void testProtocolRejectsWrongMethodsMediaTypesAndBodies() {
    FakeClock clock;
    FakeStorage storage;
    SceneManager scenes(clock, storage);
    FakeAuthenticator authenticator;
    ProtocolHandler protocol(scenes, storage, authenticator);
    const HttpRequest invalidRequests[] = {
        {HttpMethod::post, "/api/v1/status", {}, {}, {}},
        {HttpMethod::get, "/api/v1/status", {}, {}, "{}"},
        {HttpMethod::post, "/api/v1/mode", {}, "application/json", R"({"mode":"gif"})"},
        {HttpMethod::post, "/api/v1/spotify", {}, "application/json", "{}"},
        {HttpMethod::put, "/api/v1/heartbeat", {}, {}, {}},
        {HttpMethod::post, "/api/v1/heartbeat", {}, {}, "{}"},
        {HttpMethod::post, "/api/v1/cover", {}, {}, {}},
        {HttpMethod::post, "/api/v1/animation", {}, {}, {}}
    };
    for (const auto& request : invalidRequests) TEST_ASSERT_EQUAL_UINT16(400, protocol.handle(request, {}).statusCode);
    TEST_ASSERT_EQUAL_UINT16(415, protocol.handle({HttpMethod::put, "/api/v1/mode", {}, "text/plain", R"({"mode":"gif"})"}, {}).statusCode);
    TEST_ASSERT_EQUAL_UINT16(415, protocol.handle({HttpMethod::put, "/api/v1/spotify", {}, {}, "{}"}, {}).statusCode);
    TEST_ASSERT_EQUAL_UINT16(204, protocol.handle({HttpMethod::put, "/api/v1/mode", {}, " APPLICATION/JSON ; charset=utf-8", R"({"mode":"gif"})"}, {}).statusCode);
    storage.modeWriteSucceeds = false;
    TEST_ASSERT_EQUAL_UINT16(500, protocol.handle(jsonRequest(HttpMethod::put, "/api/v1/mode", R"({"mode":"spotify"})"), {}).statusCode);
    TEST_ASSERT_EQUAL(DisplayMode::gif, scenes.mode());
}

void testStatusEscapingFitsResponseAtSchemaLimits() {
    FakeClock clock;
    FakeStorage storage;
    SceneManager scenes(clock, storage);
    FakeAuthenticator authenticator;
    ProtocolHandler protocol(scenes, storage, authenticator);
    storage.availableBytes = std::numeric_limits<std::uint64_t>::max();
    const std::string text(64, '\x01');
    const auto response = protocol.handle({HttpMethod::get, "/api/v1/status", {}, {}, {}}, {text, text});
    TEST_ASSERT_EQUAL_UINT16(200, response.statusCode);
    TEST_ASSERT_TRUE(response.bodySize < response.body.size());
    TEST_ASSERT_TRUE(response.bodyView().back() == '}');
    TEST_ASSERT_NOT_NULL(std::strstr(response.body.data(), "\\u0001"));
    TEST_ASSERT_NOT_NULL(std::strstr(response.body.data(), "18446744073709551615"));
    const std::string tooLong(65, 'a');
    TEST_ASSERT_EQUAL_UINT16(500, protocol.handle({HttpMethod::get, "/api/v1/status", {}, {}, {}}, {tooLong, "192.0.2.1"}).statusCode);
    TEST_ASSERT_EQUAL_UINT16(500, protocol.handle({HttpMethod::get, "/api/v1/status", {}, {}, {}}, {"\xc0\xaf", "192.0.2.1"}).statusCode);
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

void testAnimationReaderRejectsInvalidHeadersAndAcceptsMaximumLayout() {
    FakeStorage storage;
    AnimationReader reader(storage);
    AnimationMetadata metadata{};
    for (std::size_t length = 0; length < 11; ++length) {
        storage.animationBytes.resize(length);
        TEST_ASSERT_FALSE(reader.open(metadata));
    }
    const struct { std::size_t offset; std::uint16_t value; } invalidHeaders[] = {
        {0, 'X'}, {4, 2}, {5, 239}, {7, 241}, {9, 0}, {9, 21}, {9, 65'535}
    };
    for (const auto& invalid : invalidHeaders) {
        storage.animationBytes = makeAnimation();
        writeLittleEndian16(storage.animationBytes, invalid.offset, invalid.value);
        TEST_ASSERT_FALSE(reader.open(metadata));
        TEST_ASSERT_EQUAL_UINT16(0, metadata.frameCount);
    }
    storage.animationBytes = makeAnimation(20, 1'500);
    TEST_ASSERT_TRUE(reader.open(metadata));
    TEST_ASSERT_EQUAL_UINT16(20, metadata.frameCount);
    TEST_ASSERT_EQUAL_UINT32(30'000, metadata.durationMs);
    std::uint16_t delayMs = 0;
    TEST_ASSERT_TRUE(reader.frameDelayMs(19, delayMs));
    TEST_ASSERT_EQUAL_UINT16(1'500, delayMs);
    storage.animationBytes = makeAnimation(1, 20);
    TEST_ASSERT_TRUE(reader.open(metadata));
}

void testAnimationChunksRespectFrameAndDestinationBounds() {
    FakeStorage storage;
    storage.animationBytes = makeAnimation(2, 120);
    storage.animationBytes[115'212] = 0xa5;
    storage.animationBytes[115'215] = 0x5a;
    AnimationReader reader(storage);
    AnimationMetadata metadata{};
    std::uint8_t chunk[] = {0xcc, 0xcc, 0xcc};
    std::size_t bytesRead = 99;
    TEST_ASSERT_FALSE(reader.readFrameChunk(0, 0, chunk, sizeof(chunk), bytesRead));
    TEST_ASSERT_EQUAL_UINT32(0, bytesRead);
    TEST_ASSERT_TRUE(reader.open(metadata));
    TEST_ASSERT_TRUE(reader.readFrameChunk(0, 115'199, chunk, std::numeric_limits<std::size_t>::max(), bytesRead));
    TEST_ASSERT_EQUAL_UINT32(1, bytesRead);
    TEST_ASSERT_EQUAL_HEX8(0xa5, chunk[0]);
    TEST_ASSERT_EQUAL_HEX8(0xcc, chunk[1]);
    TEST_ASSERT_TRUE(reader.readFrameChunk(1, 0, chunk, 1, bytesRead));
    TEST_ASSERT_EQUAL_HEX8(0x5a, chunk[0]);
    const struct { std::uint16_t frame; std::uint32_t offset; std::size_t capacity; } invalidReads[] = {
        {2, 0, 1}, {65'535, 0, 1}, {0, 115'200, 1}, {0, 0xffff'ffff, 1}, {0, 0, 0}
    };
    for (const auto& invalid : invalidReads) {
        bytesRead = 99;
        TEST_ASSERT_FALSE(reader.readFrameChunk(invalid.frame, invalid.offset, chunk, invalid.capacity, bytesRead));
        TEST_ASSERT_EQUAL_UINT32(0, bytesRead);
    }
    TEST_ASSERT_FALSE(reader.readFrameChunk(0, 0, nullptr, 1, bytesRead));
    TEST_ASSERT_EQUAL_UINT32(0, bytesRead);
}

void testAnimationReadFailuresReportNoUsableChunkAndCanRetry() {
    FakeStorage storage;
    storage.animationBytes = makeAnimation(2);
    AnimationReader reader(storage);
    AnimationMetadata metadata{};
    storage.failedReadOffset = 0;
    TEST_ASSERT_FALSE(reader.open(metadata));
    storage.failedReadOffset = 115'213;
    TEST_ASSERT_FALSE(reader.open(metadata));
    TEST_ASSERT_EQUAL_UINT16(0, metadata.frameCount);
    storage.failedReadOffset = std::numeric_limits<std::uint32_t>::max();
    TEST_ASSERT_TRUE(reader.open(metadata));
    storage.failedReadOffset = 11;
    std::uint16_t delayMs = 777;
    TEST_ASSERT_FALSE(reader.frameDelayMs(0, delayMs));
    storage.failedReadOffset = 13;
    storage.partialReadOnFailure = true;
    storage.animationBytes[13] = 0x12;
    storage.animationBytes[14] = 0x34;
    std::uint8_t chunk[2]{};
    std::size_t bytesRead = 99;
    TEST_ASSERT_FALSE(reader.readFrameChunk(0, 0, chunk, sizeof(chunk), bytesRead));
    TEST_ASSERT_EQUAL_UINT32(0, bytesRead);
    storage.failedReadOffset = std::numeric_limits<std::uint32_t>::max();
    TEST_ASSERT_TRUE(reader.readFrameChunk(0, 0, chunk, sizeof(chunk), bytesRead));
    TEST_ASSERT_EQUAL_UINT32(2, bytesRead);
    TEST_ASSERT_EQUAL_HEX8(0x12, chunk[0]);
    TEST_ASSERT_EQUAL_HEX8(0x34, chunk[1]);
    storage.animationBytes.resize(14);
    TEST_ASSERT_FALSE(reader.readFrameChunk(0, 0, chunk, sizeof(chunk), bytesRead));
    TEST_ASSERT_EQUAL_UINT32(0, bytesRead);
}

void testFailedAnimationReopenInvalidatesPreviousMetadata() {
    FakeStorage storage;
    storage.animationBytes = makeAnimation();
    AnimationReader reader(storage);
    AnimationMetadata metadata{};
    TEST_ASSERT_TRUE(reader.open(metadata));
    storage.animationBytes[0] = 'X';
    TEST_ASSERT_FALSE(reader.open(metadata));
    TEST_ASSERT_EQUAL_UINT16(0, metadata.frameCount);
    std::uint16_t delayMs = 0;
    TEST_ASSERT_FALSE(reader.frameDelayMs(0, delayMs));
    std::uint8_t chunk[2]{};
    std::size_t bytesRead = 99;
    TEST_ASSERT_FALSE(reader.readFrameChunk(0, 0, chunk, sizeof(chunk), bytesRead));
    TEST_ASSERT_EQUAL_UINT32(0, bytesRead);
}

} // namespace

int main(int, char**) {
    UNITY_BEGIN();
    RUN_TEST(testAutoSceneRequiresFreshHeartbeatAndPlayingTrack);
    RUN_TEST(testManualModesPersistAndSpotifyShowsWaitingWhenStale);
    RUN_TEST(testHeartbeatsDoNotKeepStalePlaybackActive);
    RUN_TEST(testOldSpotifySamplesExpireEvenWhenReceivedAgain);
    RUN_TEST(testPlaybackFreshnessIncludesSampleAgeAndUsesMonotonicTime);
    RUN_TEST(testFutureSampleAndExtremeProgressDoNotOverflow);
    RUN_TEST(testFailedModePersistenceDoesNotChangeCurrentMode);
    RUN_TEST(testPlaybackProgressAdvancesClampsAndStopsWhenPaused);
    RUN_TEST(testPlayingProgressAccountsForTimeSinceTheAgentSample);
    RUN_TEST(testSceneManagerRendersOnlyOneOfTheTwoScenes);
    RUN_TEST(testProtocolStatusMatchesV1AndDoesNotRequireAuthentication);
    RUN_TEST(testStatusStringLimitsCountUtf8CodePointsLikeTheV1Schema);
    RUN_TEST(testProtocolModeRouteValidatesPersistsAndRequiresAuthentication);
    RUN_TEST(testBearerAuthenticatorChecksSchemeAndExactConfiguredToken);
    RUN_TEST(testProtocolRejectsInvalidClosedSchemaAndMalformedJson);
    RUN_TEST(testProtocolAcceptsJsonWhitespaceAroundEveryValueType);
    RUN_TEST(testProtocolSpotifyRouteValidatesFieldsAndClampsProgress);
    RUN_TEST(testProtocolRejectsMalformedJsonWithoutChangingPlayback);
    RUN_TEST(testProtocolHandlerDoesNotRetainASecondTrack);
    RUN_TEST(testSpotifyMaximumFieldsAndLateFailuresRemainAtomic);
    RUN_TEST(testSpotifyRequestCanAliasTheCurrentTrack);
    RUN_TEST(testSpotifyNormalRequestsDoNotAllocateAndAliasedFailurePreservesTrack);
    RUN_TEST(testSpotifyMaximumBodyAndLongExponentRemainValid);
    RUN_TEST(testProtocolValidatesUtf8EscapesAndCodePointLimits);
    RUN_TEST(testProtocolAcceptsExactIntegerNotationAndRejectsOverflow);
    RUN_TEST(testEveryMutatingRouteAuthenticatesBeforeProcessing);
    RUN_TEST(testProtocolRejectsWrongMethodsMediaTypesAndBodies);
    RUN_TEST(testStatusEscapingFitsResponseAtSchemaLimits);
    RUN_TEST(testHeartbeatRefreshesTimeoutAndBinaryRoutesStayExplicitlyUnavailable);
    RUN_TEST(testNetworkAdapterDispatchesOneRequestWithoutTransportCoupling);
    RUN_TEST(testAnimationReaderValidatesHeaderAndReadsRgb565InBoundedChunks);
    RUN_TEST(testAnimationReaderRejectsMalformedLengthsAndTiming);
    RUN_TEST(testAnimationReaderRejectsInvalidHeadersAndAcceptsMaximumLayout);
    RUN_TEST(testAnimationChunksRespectFrameAndDestinationBounds);
    RUN_TEST(testAnimationReadFailuresReportNoUsableChunkAndCanRetry);
    RUN_TEST(testFailedAnimationReopenInvalidatesPreviousMetadata);
    return UNITY_END();
}
