#include "neonbyte/wifi_configuration.h"
#include <cstring>
namespace neonbyte {
namespace {
int hex(char c) {
    if (c >= '0' && c <= '9') return c-'0';
    if (c >= 'a' && c <= 'f') return c-'a'+10;
    if (c >= 'A' && c <= 'F') return c-'A'+10;
    return -1;
}
bool decode(std::string_view input, char* destination, std::size_t capacity) {
    std::size_t count = 0;
    for (std::size_t i=0;i<input.size();++i) {
        unsigned char c = input[i];
        if (c == '+') c = ' ';
        else if (c == '%') {
            if (i+2 >= input.size() || hex(input[i+1]) < 0 || hex(input[i+2]) < 0) return false;
            c = (hex(input[i+1])<<4) | hex(input[i+2]); i += 2;
        }
        if (c < 32 || c == 127 || count+1 >= capacity) return false;
        destination[count++] = c;
    }
    destination[count] = 0; return true;
}
std::size_t boundedLength(const char* value, std::size_t capacity) {
    std::size_t length = 0;
    while (length < capacity && value[length]) ++length;
    return length;
}
bool printable(std::string_view value) {
    for (unsigned char byte : value) if (byte < 32 || byte == 127) return false;
    return true;
}
}
bool isValidWifiConfiguration(const WifiCredentials& credentials) {
    const auto ssidLength = boundedLength(credentials.ssid,sizeof(credentials.ssid));
    const auto passwordLength = boundedLength(credentials.password,sizeof(credentials.password));
    if (!ssidLength || ssidLength == sizeof(credentials.ssid) || passwordLength == sizeof(credentials.password)) return false;
    if (!printable({credentials.ssid,ssidLength}) || !printable({credentials.password,passwordLength})) return false;
    if (!passwordLength) return true;
    if (passwordLength < 8 || passwordLength > 64) return false;
    if (passwordLength == 64) {
        for (char value : std::string_view(credentials.password,passwordLength)) if (hex(value) < 0) return false;
    }
    return true;
}
bool parseWifiConfiguration(std::string_view form, WifiCredentials& credentials) {
    const auto separator = form.find('&');
    if (form.substr(0,5) != "ssid=" || separator == form.npos || separator < 5 || form.substr(separator+1,9) != "password=" || form.find('&',separator+1) != form.npos) return false;
    WifiCredentials candidate;
    if (!decode(form.substr(5,separator-5),candidate.ssid,sizeof(candidate.ssid)) || !candidate.ssid[0] || !decode(form.substr(separator+10),candidate.password,sizeof(candidate.password))) return false;
    if (!isValidWifiConfiguration(candidate)) return false;
    credentials = candidate; return true;
}
void StationAssociation::beginAttempt(const WifiCredentials& credentials) {
    target_ = credentials; allowed_ = associated_ = verified_ = false;
}
void StationAssociation::onConnected(std::string_view observedSsid) {
    associated_ = allowed_ && target_.ssid[0] && observedSsid == target_.ssid;
    verified_ = false;
}
bool StationAssociation::confirmed(const WifiCredentials& credentials, bool liveConnected) const {
    return liveConnected && allowed_ && verified_ && std::strcmp(credentials.ssid,target_.ssid) == 0
        && std::strcmp(credentials.password,target_.password) == 0;
}
} // namespace neonbyte
