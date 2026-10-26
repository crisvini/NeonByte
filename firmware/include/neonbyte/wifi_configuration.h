#pragma once
#include <string_view>
namespace neonbyte {
struct WifiCredentials { char ssid[33]{}; char password[65]{}; };
// Exactly ssid then password, URL-encoded; output changes only on success.
bool parseWifiConfiguration(std::string_view form, WifiCredentials& credentials);
} // namespace neonbyte
