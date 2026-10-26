#ifdef ARDUINO_ARCH_ESP8266
#include "neonbyte/esp8266/display.h"
#include "neonbyte/esp8266/http_server.h"
#include <sys/time.h>
#include <new>
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
DeviceClock deviceClock;
PersistentStorage storage;
DeviceDisplay display(storage);
std::unique_ptr<SceneManager> scenes;
std::unique_ptr<BearerTokenAuthenticator> authenticator;
std::unique_ptr<ProtocolHandler> protocol;
std::unique_ptr<DeviceHttpServer> http;
std::uint64_t nextRetry = 0, disconnectedSince = 0;
bool setupAp = false;
void connectStation() {
    WiFi.begin(storage.configuration.ssid,storage.configuration.password);
    nextRetry = deviceClock.monotonicMillis()+30'000;
}
}
void setup() {
    using namespace neonbyte;
    // Never load or overwrite stock SDK credentials; persist only our namespaced file.
    WiFi.persistent(false); WiFi.mode(WIFI_OFF);
    if (!storage.beginStorage() || !storage.loadConfiguration()) return;
    scenes.reset(new (std::nothrow) SceneManager(deviceClock,storage));
    authenticator.reset(new (std::nothrow) BearerTokenAuthenticator(storage.configuration.token));
    if (!scenes || !authenticator) return;
    protocol.reset(new (std::nothrow) ProtocolHandler(*scenes,storage,*authenticator));
    if (!protocol) return;
    http.reset(new (std::nothrow) DeviceHttpServer(storage,*protocol,*authenticator));
    if (!http) return;
    display.begin();
    if (storage.configuration.ssid[0]) {
        WiFi.mode(WIFI_STA); connectStation();
    } else {
        WiFi.mode(WIFI_AP_STA);
        const String name = "NeonByte-" + String(ESP.getChipId(),HEX);
        setupAp = WiFi.softAP(name.c_str(),storage.configuration.apPassword);
        display.setupCredentials(storage.configuration);
    }
    // No Internet dependency for rendering. Unix time remains unknown until SNTP succeeds.
    configTime(0,0,"pool.ntp.org","time.nist.gov"); http->begin();
}
void loop() {
    using namespace neonbyte;
    const auto now = deviceClock.monotonicMillis();
    if (!http) { delay(1); return; }
    http->tick(now);
    if (http->configurationChanged) { http->configurationChanged = false; connectStation(); }
    if (WiFi.status() == WL_CONNECTED) disconnectedSince = now;
    if (WiFi.status() != WL_CONNECTED && !setupAp && now-disconnectedSince >= 60'000) {
        // A known, random WPA2 credential allows paired users to repair Wi-Fi.
        // Keep normal offline rendering while the protected recovery AP exists.
        WiFi.mode(WIFI_AP_STA);
        const String name = "NeonByte-" + String(ESP.getChipId(),HEX);
        setupAp = WiFi.softAP(name.c_str(),storage.configuration.apPassword);
    }
    if (WiFi.status() == WL_CONNECTED && setupAp) { WiFi.softAPdisconnect(true); WiFi.mode(WIFI_STA); setupAp = false; }
    if (storage.configuration.ssid[0] && WiFi.status() != WL_CONNECTED && now >= nextRetry) connectStation();
    // Preserve setup secrets on the display until provisioning succeeds.
    if (!setupAp || storage.configuration.ssid[0]) display.tick(*scenes,now);
    delay(0);
}
#endif
