#pragma once
#include <string_view>
namespace neonbyte {
struct WifiCredentials { char ssid[33]{}; char password[65]{}; };
bool isValidWifiConfiguration(const WifiCredentials& credentials);
// Exactly ssid then password, URL-encoded; output changes only on success.
bool parseWifiConfiguration(std::string_view form, WifiCredentials& credentials);
// Fresh event evidence for the current credential attempt, never configured SSID alone.
class StationAssociation {
public:
    void beginAttempt(const WifiCredentials& credentials);
    void allowAttempt(bool disconnectSucceeded, bool configuredAsRequested = true) {
        allowed_ = disconnectSucceeded && configuredAsRequested;
        if (!allowed_) associated_ = verified_ = false;
    }
    void onConnected(std::string_view observedSsid);
    void onGotIp() { verified_ = allowed_ && associated_; }
    void onDisconnected() { associated_ = verified_ = false; }
    bool confirmed(const WifiCredentials& credentials, bool liveConnected) const;
private:
    WifiCredentials target_{};
    bool allowed_ = false, associated_ = false, verified_ = false;
};
} // namespace neonbyte
