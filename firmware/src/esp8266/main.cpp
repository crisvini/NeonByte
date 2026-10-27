#ifdef ARDUINO_ARCH_ESP8266
#include "neonbyte/esp8266/display.h"
#include "neonbyte/esp8266/http_server.h"
#include <sys/time.h>
#include <new>
#if __has_include("neonbyte_private_identity.h")
#include "neonbyte_private_identity.h"
#endif
namespace neonbyte {
class DeviceClock final : public Clock {
public:
    std::uint64_t monotonicMillis() const override {
        const auto current = millis();
        if (current < previous_) epoch_ += (std::uint64_t(1)<<32);
        previous_ = current; return epoch_+current;
    }
    std::uint64_t unixMillis() const override {
        timeval value{}; gettimeofday(&value,nullptr);
        return value.tv_sec > 1'600'000'000 ? std::uint64_t(value.tv_sec)*1000+value.tv_usec/1000 : 0;
    }
private:
    mutable std::uint32_t previous_ = 0;
    mutable std::uint64_t epoch_ = 0;
};
RecoveryIdentity privateRecoveryIdentity() {
#if defined(NEONBYTE_PRIVATE_RECOVERY_TOKEN) && defined(NEONBYTE_PRIVATE_RECOVERY_AP_PASSWORD)
    return {NEONBYTE_PRIVATE_RECOVERY_TOKEN, NEONBYTE_PRIVATE_RECOVERY_AP_PASSWORD};
#else
    // Compile checks have no usable identity and must never become installations.
    return {};
#endif
}
constexpr std::uint32_t GUARD_MAGIC = 0x4e425347;
struct StartupGuard { std::uint32_t magic, risky, inverse; };
DeviceClock deviceClock;
PersistentStorage storage;
DeviceDisplay display(storage);
std::unique_ptr<SceneManager> scenes;
std::unique_ptr<ProtocolHandler> protocol;
BearerTokenAuthenticator pairingAuthenticator({storage.configuration.token,64});
class DeviceStartupServices final : public StartupServices {
public:
    bool startRecoveryAp(RecoveryIdentity identity) override {
        const String name = "NeonByte-" + String(ESP.getChipId(),HEX);
        // Input is validated and refers to null-terminated private literals.
        const bool configured = WiFi.softAP(name.c_str(),identity.apPassword.data());
        if (!configured) WiFi.enableAP(false);
        return configured;
    }
    void startHttp() override;
    bool mountStorage() override { return storage.beginStorage(); }
    bool loadWifi(WifiCredentials& out) override {
        if (!storage.loadConfiguration()) return false;
        memcpy(out.ssid,storage.configuration.ssid,sizeof(out.ssid));
        memcpy(out.password,storage.configuration.password,sizeof(out.password));
        return out.ssid[0];
    }
    bool saveWifi(const WifiCredentials& value) override {
        DeviceConfiguration candidate = storage.configuration;
        memcpy(candidate.ssid,value.ssid,sizeof(candidate.ssid));
        memcpy(candidate.password,value.password,sizeof(candidate.password));
        if (!candidate.token[0]) {
            const auto identity = privateRecoveryIdentity();
            if (identity.token.size() != 64) return false;
            memcpy(candidate.token,identity.token.data(),64);
            // Retained legacy record field, unused by the independent recovery AP.
            constexpr char HEX_DIGITS[] = "0123456789abcdef";
            for (unsigned i=0;i<16;++i) candidate.apPassword[i] = HEX_DIGITS[os_random() & 15];
        }
        return storage.saveConfiguration(candidate);
    }
    void connectStation(const WifiCredentials& value) override {
        association_.beginAttempt(value);
        if (!connectedHandler_) connectedHandler_ = WiFi.onStationModeConnected([this](const WiFiEventStationModeConnected& event) {
            association_.onConnected({event.ssid.c_str(),event.ssid.length()});
        });
        if (!gotIpHandler_) gotIpHandler_ = WiFi.onStationModeGotIP([this](const WiFiEventStationModeGotIP&) { association_.onGotIp(); });
        if (!disconnectedHandler_) disconnectedHandler_ = WiFi.onStationModeDisconnected([this](const WiFiEventStationModeDisconnected&) { association_.onDisconnected(); });
        if (!connectedHandler_ || !gotIpHandler_ || !disconnectedHandler_) return;
        // Invalidate old evidence, require disconnect success, and never erase SDK credentials.
        if (!WiFi.disconnect(false,false)) return;
        // Configure without connecting; the pinned begin() ignores SDK setter failures.
        WiFi.begin(value.ssid,value.password,0,nullptr,false);
        const bool configured = WiFi.SSID() == value.ssid && WiFi.psk() == value.password;
        association_.allowAttempt(true,configured);
        if (configured && !wifi_station_connect()) association_.allowAttempt(false);
    }
    bool stationConnected(const WifiCredentials& value) const override {
        return association_.confirmed(value,WiFi.status() == WL_CONNECTED);
    }
    bool setStartupGuard(bool risky) override {
        StartupGuard guard{GUARD_MAGIC,risky ? 1U : 0U,risky ? ~1U : ~0U};
        if (!ESP.rtcUserMemoryWrite(0,reinterpret_cast<std::uint32_t*>(&guard),sizeof(guard))) return false;
        StartupGuard actual{};
        return ESP.rtcUserMemoryRead(0,reinterpret_cast<std::uint32_t*>(&actual),sizeof(actual))
            && memcmp(&guard,&actual,sizeof(guard)) == 0;
    }
    bool startApplication() override;
    void stopApplication() override;
private:
    StationAssociation association_;
    WiFiEventHandler connectedHandler_, gotIpHandler_, disconnectedHandler_;
};
DeviceStartupServices startupServices;
SafeStartup startup(startupServices,privateRecoveryIdentity());
// No application allocation or filesystem is needed to accept maintenance HTTP.
DeviceHttpServer http(storage,startup,pairingAuthenticator);
void DeviceStartupServices::startHttp() { http.begin(); }
bool DeviceStartupServices::startApplication() {
    scenes.reset(new (std::nothrow) SceneManager(deviceClock,storage));
    if (!scenes) return false;
    protocol.reset(new (std::nothrow) ProtocolHandler(*scenes,storage,pairingAuthenticator));
    if (!protocol) { scenes.reset(); return false; }
    http.setProtocol(protocol.get());
    display.begin();
    // Unix time is optional; network recovery never depends on Internet access.
    configTime(0,0,"pool.ntp.org","time.nist.gov");
    return true;
}
void DeviceStartupServices::stopApplication() {
    http.setProtocol(nullptr); protocol.reset(); scenes.reset();
}
bool previousStartupFailure() {
    const auto* reset = ESP.getResetInfoPtr();
    if (!reset || (reset->reason != REASON_DEFAULT_RST && reset->reason != REASON_SOFT_RESTART
        && reset->reason != REASON_EXT_SYS_RST)) return true;
    StartupGuard guard{};
    if (!ESP.rtcUserMemoryRead(0,reinterpret_cast<std::uint32_t*>(&guard),sizeof(guard))) return true;
    if (guard.magic != GUARD_MAGIC || guard.inverse != ~guard.risky || guard.risky > 1) {
        // RTC contents are unspecified on power-on; initialize only on a clean boot.
        return reset->reason != REASON_DEFAULT_RST || !startupServices.setStartupGuard(false);
    }
    return guard.risky != 0;
}
}
void setup() {
    using namespace neonbyte;
    WiFi.persistent(false); WiFi.mode(WIFI_OFF);
    startup.begin(deviceClock.monotonicMillis(),previousStartupFailure());
}
void loop() {
    using namespace neonbyte;
    const auto now = deviceClock.monotonicMillis();
    if (startup.identityValid()) {
        http.tick(now);
        startup.tick(now);
        if (startup.applicationRunning() && scenes) display.tick(*scenes,now);
    }
    delay(0);
}
#endif
