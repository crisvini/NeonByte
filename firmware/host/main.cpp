#include "storage.h"
#include "neonbyte/safe_startup.h"
#include <iostream>
#include <memory>
#include <sstream>
#include <cstring>

using namespace neonbyte;
using namespace neonbyte::host;
namespace {
// Deliberately public fixtures, exclusively in the host executable.
constexpr RecoveryIdentity IDENTITY{"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "fedcba9876543210fedcba9876543210"};
class HostClock final : public Clock {
public:
    std::uint64_t elapsed = 0;
    std::uint64_t unixBase = 1'790'000'000'000;
    std::uint64_t monotonicMillis() const override { return elapsed; }
    std::uint64_t unixMillis() const override { return unixBase + elapsed; }
};
class Services final : public StartupServices {
public:
    Services(DiskStorage& storage, HostClock& clock) : disk(storage), clock_(clock) {}
    DiskStorage& disk;
    HostClock& clock_;
    bool mountOk = true, configOk = true, appOk = true, apOk = true, guardOk = true, live = false, backgroundAllowed = true;
    std::string calls;
    unsigned attempts = 0, configurationMounts = 0, preparationMounts = 0;
    WifiCredentials target{};
    StationAssociation association;
    std::unique_ptr<SceneManager> scenes;
    std::unique_ptr<ProtocolHandler> protocol;
    BearerTokenAuthenticator auth{IDENTITY.token};
    bool startRecoveryAp(RecoveryIdentity) override { calls += 'N'; return apOk; }
    bool startHttp() override { calls += 'H'; return true; }
    bool mountConfigurationStorage() override { ++configurationMounts; calls += 'Q'; return mountOk && disk.mountForConfiguration(); }
    bool mountStorage() override { ++preparationMounts; calls += 'F'; return mountOk && disk.mount(); }
    bool loadWifi(WifiCredentials& value) override {
        calls += 'C'; FileSource source(disk.directory / "wifi.bin");
        return configOk && disk.mounted && disk.readOk && source.size() == sizeof(value) && source.readAt(0, reinterpret_cast<std::uint8_t*>(&value), sizeof(value));
    }
    bool saveWifi(const WifiCredentials& value) override { return disk.replace("wifi.bin", reinterpret_cast<const std::uint8_t*>(&value), sizeof(value)); }
    void connectStation(const WifiCredentials& value) override {
        calls += 'W'; ++attempts; target = value; live = false; association.beginAttempt(value); association.allowAttempt(true);
    }
    bool stationConnected(const WifiCredentials& value) const override { return association.confirmed(value, live); }
    bool backgroundStartupWorkAllowed() const override { return backgroundAllowed; }
    bool setStartupGuard(bool risky) override { calls += risky ? 'G' : 'g'; return guardOk; }
    bool startApplication() override {
        calls += 'A'; if (!appOk) return false;
        scenes = std::make_unique<SceneManager>(clock_, disk);
        protocol = std::make_unique<ProtocolHandler>(*scenes, disk, auth); return true;
    }
    void stopApplication() override { calls += 'S'; protocol.reset(); scenes.reset(); }
};
class RecordingDisplay final : public DisplayRenderer {
public:
    ActiveScene scene = ActiveScene::gif;
    bool waiting = false;
    const NowPlaying* track = nullptr;
    std::uint64_t progressMs = 0;
    void showGif() override { scene = ActiveScene::gif; }
    void showSpotifyWaiting() override { scene = ActiveScene::spotify; waiting = true; }
    void showSpotify(const NowPlaying& value, std::uint64_t progress) override { scene = ActiveScene::spotify; track = &value; progressMs = progress; }
    void beginAnimationFrame(std::uint16_t, std::uint16_t) override {}
    void writeAnimationPixels(std::uint32_t, const std::uint8_t*, std::size_t) override {}
    void endAnimationFrame(std::uint16_t) override {}
};
HttpResponse error(unsigned status, std::string_view code) {
    HttpResponse response; response.statusCode = status; response.contentType = "application/json";
    const std::string body = "{\"code\":\"" + std::string(code) + "\",\"message\":\"Host request rejected.\"}";
    std::copy(body.begin(), body.end(), response.body.begin()); response.bodySize = body.size(); return response;
}
void emit(const HttpResponse& response) {
    std::cout << "{\"status\":" << response.statusCode << ",\"bodyHex\":\"" << hex(response.bodyView()) << "\"}" << std::endl;
}
HttpResponse request(std::string_view header, const std::vector<std::uint8_t>& body, Services& services, SafeStartup& startup, HostClock& clock, bool cut) {
    HttpHeaders headers;
    if (!headers.parse(header)) return error(400, "invalid_request");
    const bool maintenance = headers.path.substr(0, 16) == "/maintenance/v1/";
    if (maintenance ? !startup.authorized(headers.authorization) : headers.path != "/api/v1/status" && !services.auth.isAuthorized(headers.authorization)) return error(401, "unauthorized");
    if (!maintenance && !services.protocol) return error(409, "conflict");
    if (headers.path == "/api/v1/firmware" || headers.path == "/maintenance/v1/firmware") return error(409, "conflict");
    const bool cover = headers.path == "/api/v1/cover";
    if (cover || headers.path == "/api/v1/animation") {
        if (headers.method != HttpMethod::put) return error(400, "invalid_request");
        if (headers.contentType != "application/octet-stream") return error(415, "unsupported_media_type");
        const auto limit = cover ? COVER_BYTES : ANIMATION_BYTES_LIMIT;
        if (headers.contentLength > limit) return error(413, "payload_too_large");
        if (!headers.contentLength || !isSha256(headers.sha256)) return error(400, "invalid_request");
        if (cover && headers.contentLength != COVER_BYTES) return error(422, "invalid_content");
        auto& disk = services.disk;
        if (!disk.select(cover, headers.trackId)) return error(400, "invalid_request");
        Transfer transfer(disk);
        if (!transfer.begin(headers.contentLength, limit, headers.sha256)) return error(409, "conflict");
        for (std::size_t offset = 0; offset < body.size(); offset += 512) {
            if (!transfer.append(body.data() + offset, std::min<std::size_t>(512, body.size() - offset))) return error(500, "internal_error");
        }
        disk.seal();
        // Leave an uncommitted candidate for the actual process-restart test.
        if (cut) return error(409, "conflict");
        const auto hash = disk.hash(disk.stagedName(), cover ? 2 + MAX_TEXT_UTF8_BYTES : 0);
        if (!transfer.finish(hash, disk.validate())) return error(422, "invalid_content");
        HttpResponse response; response.statusCode = 204; return response;
    }
    if (body.size() != headers.contentLength) return error(400, "invalid_request");
    if (body.size() > (maintenance ? 512U : JSON_BODY_LIMIT)) return error(413, "payload_too_large");
    const HttpRequest input{headers.method, headers.path, headers.authorization, headers.contentType,
        {reinterpret_cast<const char*>(body.data()), body.size()}};
    if (maintenance) { HttpResponse response; handleMaintenance(input, startup, clock.elapsed, response); return response; }
    return services.protocol->handle(input, {"host-offline", "127.0.0.1"});
}
void state(Services& services, SafeStartup& startup) {
    const auto scene = services.scenes ? services.scenes->currentState() : SceneState{};
    RecordingDisplay display;
    if (services.scenes) services.scenes->render(display);
    const auto* track = display.track;
    AnimationReader reader(services.disk); AnimationMetadata metadata; reader.open(metadata);
    WifiCredentials saved{};
    if (services.disk.mounted && services.disk.readOk)
        FileSource(services.disk.directory / "wifi.bin").readAt(0, reinterpret_cast<std::uint8_t*>(&saved), sizeof(saved));
    std::cout << "{\"scene\":\"" << sceneName(display.scene) << "\",\"waiting\":" << display.waiting
        << ",\"agentAvailable\":" << scene.agentAvailable << ",\"progressMs\":" << (display.track ? display.progressMs : scene.progressMs)
        << ",\"titleHex\":\"" << hex(track ? track->title.view() : "") << "\",\"artistHex\":\"" << hex(track ? track->artist.view() : "")
        << "\",\"trackIdHex\":\"" << hex(track ? track->trackId.view() : "") << "\",\"coverTrackIdHex\":\"" << hex(services.disk.coverTrackId())
        << "\",\"coverPixel\":" << (track && !scene.waiting && scene.activeScene == ActiveScene::spotify ? services.disk.coverPixel(track->trackId.view()) : -1)
        << ",\"animationFrames\":" << metadata.frameCount << ",\"animationSha\":\"" << services.disk.hash("animation.nbif")
        << "\",\"savedSsidHex\":\"" << hex(saved.ssid) << "\",\"stationTargetHex\":\"" << hex(services.target.ssid)
        << "\",\"calls\":\"" << services.calls << "\",\"attempts\":" << services.attempts
        << ",\"applicationRunning\":" << startup.applicationRunning() << "}" << std::endl;
}
void frame(DiskStorage& disk, unsigned index) {
    AnimationReader reader(disk); AnimationMetadata metadata; Digest digest;
    std::uint16_t delay = 0; std::uint32_t offset = 0; std::size_t count = 0; std::uint8_t bytes[480];
    bool ok = reader.open(metadata) && reader.frameDelayMs(index, delay);
    while (ok && offset < ANIMATION_FRAME_PIXEL_BYTES) {
        ok = reader.readFrameChunk(index, offset, bytes, sizeof(bytes), count);
        if (ok) { digest.update(bytes, count); offset += count; }
    }
    char value[64]; digest.finish(value);
    std::cout << "{\"ok\":" << ok << ",\"bytes\":" << offset << ",\"delayMs\":" << delay
        << ",\"sha256\":\"" << std::string(value, sizeof(value)) << "\"}" << std::endl;
}
}
int main(int argc, char** argv) {
    if (argc < 2 || argc > 3) return 2;
    std::cout << std::boolalpha;
    try {
        DiskStorage disk(argv[1]); HostClock clock; Services services(disk, clock);
        const std::string_view startupMode = argc == 3 ? argv[2] : "crash";
        if (startupMode != "crash" && startupMode != "normal" && startupMode != "maintenance") return 2;
        SafeStartup startup(services, IDENTITY);
        startup.begin(0,startupMode == "crash",startupMode == "maintenance");
        std::string line;
        while (std::getline(std::cin, line)) {
            std::istringstream command(line); std::string verb, key, value; command >> verb;
            if (verb == "REQUEST" || verb == "CUT") {
                std::size_t headerLength = 0, bodyLength = 0; command >> headerLength >> bodyLength;
                if (headerLength > HTTP_HEADER_LIMIT || bodyLength > ANIMATION_BYTES_LIMIT) return 3;
                std::string header(headerLength, '\0'); std::vector<std::uint8_t> body(bodyLength);
                if (!std::cin.read(header.data(), headerLength) || !std::cin.read(reinterpret_cast<char*>(body.data()), bodyLength)) return 4;
                emit(request(header, body, services, startup, clock, verb == "CUT"));
            } else if (verb == "STATE") state(services, startup);
            else if (verb == "FRAME") { unsigned index = 0; command >> index; frame(disk, index); }
            else {
                command >> key >> value;
                if (verb == "ADVANCE") { clock.elapsed += std::stoull(key); startup.tick(clock.elapsed); }
                else if (verb == "UNIX") clock.unixBase = std::stoull(key);
                else if (verb == "ASSOCIATE") { services.live = true; services.association.onConnected(unhex(key)); services.association.onGotIp(); }
                else if (verb == "FAULT") {
                    const bool enabled = value == "1";
                    if (key == "mount") services.mountOk = enabled;
                    else if (key == "config") services.configOk = enabled;
                    else if (key == "app") services.appOk = enabled;
                    else if (key == "ap") services.apOk = enabled;
                    else if (key == "guard") services.guardOk = enabled;
                    else if (key == "write") disk.writeOk = enabled;
                    else if (key == "promote") disk.promoteOk = enabled;
                    else if (key == "read") disk.readOk = enabled;
                    else if (key == "capacity") disk.capacity = std::stoull(value);
                    else if (key == "disconnect") { services.live = false; services.association.onDisconnected(); }
                    else if (key == "otaBusy") services.backgroundAllowed = !enabled;
                }
                std::cout << "{}" << std::endl;
            }
        }
    } catch (const std::exception&) { std::cerr << "Host harness failed." << std::endl; return 1; }
    return 0;
}
