#ifdef ARDUINO_ARCH_ESP8266
#include "neonbyte/esp8266/display.h"
#include "neonbyte/esp8266/http_server.h"
#include "neonbyte/recovery_ap.h"
#include "neonbyte/startup_guard_layout.h"
#include <bearssl/bearssl_hash.h>
#include <sys/time.h>
#include <cstdio>
#include <string_view>
#include <new>
#ifndef NEONBYTE_MAINTENANCE_ON_BOOT
#define NEONBYTE_MAINTENANCE_ON_BOOT 0
#endif
#if NEONBYTE_MAINTENANCE_ON_BOOT != 0 && NEONBYTE_MAINTENANCE_ON_BOOT != 1
#error NEONBYTE_MAINTENANCE_ON_BOOT must be 0 or 1
#endif
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
static_assert(sizeof(StartupGuardRecord) == STARTUP_GUARD_RECORD_BYTES);
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
        struct Backend {
            const String& name;
            RecoveryIdentity identity;
            const IPAddress address{192,168,4,1}, gateway{192,168,4,1}, mask{255,255,255,0};
            bool startProtectedAp() { return WiFi.softAP(name.c_str(),identity.apPassword.data()); }
            bool configureNetwork() { return WiFi.softAPConfig(address,gateway,mask); }
            bool networkMatches() {
                ip_info info{};
                softap_config configuration{};
                return wifi_get_ip_info(SOFTAP_IF,&info) && info.ip.addr == address.v4() &&
                    info.gw.addr == gateway.v4() && info.netmask.addr == mask.v4() &&
                    (WiFi.getMode() & WIFI_AP) && wifi_softap_get_config(&configuration) &&
                    configuration.ssid_len == name.length() &&
                    memcmp(configuration.ssid,name.c_str(),name.length()) == 0 &&
                    configuration.authmode == AUTH_WPA2_PSK &&
                    memcmp(configuration.password,identity.apPassword.data(),identity.apPassword.size()) == 0 &&
                    configuration.password[identity.apPassword.size()] == 0 &&
                    wifi_softap_dhcps_status() == DHCP_STARTED;
            }
            void disableAp() { WiFi.enableAP(false); }
        } backend{name,identity};
        return startCheckedRecoveryAp(backend);
    }
    bool startHttp() override;
    bool mountConfigurationStorage() override { return storage.mountForConfiguration(); }
    bool mountStorage() override { return storage.beginStorage(); }
    bool loadWifi(WifiCredentials& out) override {
        if (!storage.loadConfiguration()) return false;
        memcpy(out.ssid,storage.configuration.ssid,sizeof(out.ssid));
        memcpy(out.password,storage.configuration.password,sizeof(out.password));
        return isValidWifiConfiguration(out);
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
    bool backgroundStartupWorkAllowed() const override;
    bool setStartupGuard(bool risky) override {
        StartupGuardRecord guard{STARTUP_GUARD_MAGIC,risky ? 1U : 0U,risky ? ~1U : ~0U};
        if (!ESP.rtcUserMemoryWrite(STARTUP_GUARD_RTC_WORD_OFFSET,reinterpret_cast<std::uint32_t*>(&guard),sizeof(guard))) return false;
        StartupGuardRecord actual{};
        return ESP.rtcUserMemoryRead(STARTUP_GUARD_RTC_WORD_OFFSET,reinterpret_cast<std::uint32_t*>(&actual),sizeof(actual))
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
std::array<char,33> bootId{};
std::array<char,65> recoveryFingerprint{};
std::string_view privateBuildId() {
#if defined(NEONBYTE_PRIVATE_BUILD_ID)
    return NEONBYTE_PRIVATE_BUILD_ID;
#else
    return {};
#endif
}
std::string_view privateProfile() {
#if defined(NEONBYTE_PRIVATE_PROFILE)
    return NEONBYTE_PRIVATE_PROFILE;
#else
    return {};
#endif
}
void initializeBuildIdentity() {
    constexpr char HEX_DIGITS[] = "0123456789abcdef";
    for (std::size_t word=0;word<4;++word) {
        const auto random = os_random();
        for (std::size_t nibble=0;nibble<8;++nibble) bootId[word*8+nibble] = HEX_DIGITS[(random >> (28-nibble*4)) & 15];
    }
    const auto identity = privateRecoveryIdentity();
    if (identity.token.empty() || identity.apPassword.empty()) return;
    br_sha256_context context{}; std::uint8_t hash[32]{};
    constexpr char PREFIX[] = "NeonByte recovery identity v1";
    constexpr std::uint8_t separator = 0;
    br_sha256_init(&context);
    br_sha256_update(&context,PREFIX,sizeof(PREFIX));
    br_sha256_update(&context,identity.token.data(),identity.token.size());
    br_sha256_update(&context,&separator,1);
    br_sha256_update(&context,identity.apPassword.data(),identity.apPassword.size());
    br_sha256_out(&context,hash);
    for (std::size_t index=0;index<32;++index) {
        recoveryFingerprint[index*2] = HEX_DIGITS[hash[index] >> 4];
        recoveryFingerprint[index*2+1] = HEX_DIGITS[hash[index] & 15];
    }
}
bool DeviceStartupServices::startHttp() { return http.begin(); }
bool DeviceStartupServices::backgroundStartupWorkAllowed() const { return http.backgroundStartupWorkAllowed(); }
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
StartupResetReason startupResetReason() {
    const auto* reset = ESP.getResetInfoPtr();
    auto reason = StartupResetReason::unexpected;
    if (reset) {
        if (reset->reason == REASON_DEFAULT_RST) reason = StartupResetReason::powerOn;
        else if (reset->reason == REASON_SOFT_RESTART) reason = StartupResetReason::softRestart;
        else if (reset->reason == REASON_EXT_SYS_RST) reason = StartupResetReason::externalReset;
    }
    return reason;
}
bool previousStartupFailure(StartupResetReason reason) {
    return startupResetRequiresMaintenance(reason,
        [](std::uint32_t wordOffset, StartupGuardRecord& guard) {
            return ESP.rtcUserMemoryRead(wordOffset,reinterpret_cast<std::uint32_t*>(&guard),sizeof(guard));
        },
        [] { return startupServices.setStartupGuard(false); });
}
}
void setup() {
    using namespace neonbyte;
    WiFi.persistent(false); WiFi.mode(WIFI_OFF);
    initializeBuildIdentity();
    http.setBuildIdentity(bootId.data(),privateBuildId(),privateProfile(),recoveryFingerprint.data());
    const auto resetReason = startupResetReason();
    startup.begin(deviceClock.monotonicMillis(),previousStartupFailure(resetReason),
        startupMaintenanceOnBoot(NEONBYTE_MAINTENANCE_ON_BOOT == 1,resetReason));
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
