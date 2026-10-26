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
}
bool parseWifiConfiguration(std::string_view form, WifiCredentials& credentials) {
    const auto separator = form.find('&');
    if (form.substr(0,5) != "ssid=" || separator == form.npos || separator < 5 || form.substr(separator+1,9) != "password=" || form.find('&',separator+1) != form.npos) return false;
    WifiCredentials candidate;
    if (!decode(form.substr(5,separator-5),candidate.ssid,sizeof(candidate.ssid)) || !candidate.ssid[0] || !decode(form.substr(separator+10),candidate.password,sizeof(candidate.password))) return false;
    const auto length = strlen(candidate.password);
    if (length && length < 8) return false;
    if (length == 64) for (char c : std::string_view(candidate.password,length)) if (hex(c) < 0) return false;
    credentials = candidate; return true;
}
} // namespace neonbyte
