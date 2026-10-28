#include "neonbyte/http_headers.h"
#include <limits>
namespace neonbyte {
namespace {
bool equalInsensitive(std::string_view a, std::string_view b) {
    if (a.size() != b.size()) return false;
    for (std::size_t i=0;i<a.size();++i) {
        char c = a[i]; if (c >= 'A' && c <= 'Z') c += 'a'-'A';
        if (c != b[i]) return false;
    }
    return true;
}
}
bool HttpHeaders::parse(std::string_view input) {
    *this = {};
    if (input.size() > HTTP_HEADER_LIMIT || input.size() < 4 || input.substr(input.size()-4) != "\r\n\r\n") return false;
    const auto firstEnd = input.find("\r\n");
    if (firstEnd == input.npos) return false;
    const auto first = input.substr(0,firstEnd);
    const auto space = first.find(' '), lastSpace = first.rfind(' ');
    if (space == first.npos || space == lastSpace || first.substr(lastSpace+1) != "HTTP/1.1") return false;
    const auto verb = first.substr(0,space);
    method = verb == "GET" ? HttpMethod::get : verb == "PUT" ? HttpMethod::put :
        verb == "POST" ? HttpMethod::post : verb == "DELETE" ? HttpMethod::deleteMethod : HttpMethod::other;
    if (method == HttpMethod::other) return false;
    const auto target = first.substr(space+1,lastSpace-space-1);
    const auto queryStart = target.find('?');
    path = target.substr(0,queryStart);
    query = queryStart == target.npos ? std::string_view{} : target.substr(queryStart+1);
    if (path.empty() || path.front() != '/' || path.size() > 96 ||
        (queryStart != target.npos && (query.empty() || target.find('?',queryStart+1) != target.npos))) return false;
    for (unsigned char c : path) if (c <= 32 || c >= 127 || c == '?' || c == '#') return false;
    for (unsigned char c : query) if (c <= 32 || c >= 127 || c == '?' || c == '#') return false;
    unsigned seen = 0;
    std::size_t position = firstEnd+2;
    while (position < input.size()-2) {
        const auto end = input.find("\r\n",position);
        if (end == input.npos || end == position) return false;
        auto line = input.substr(position,end-position); position = end+2;
        const auto colon = line.find(':');
        if (colon == line.npos || colon == 0) return false;
        auto key = line.substr(0,colon), value = line.substr(colon+1);
        for (unsigned char c : key) if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-')) return false;
        for (unsigned char c : value) if (c < 32 || c == 127) return false;
        while (!value.empty() && value.front() == ' ') value.remove_prefix(1);
        while (!value.empty() && value.back() == ' ') value.remove_suffix(1);
        unsigned bit = 0;
        if (equalInsensitive(key,"host")) { bit = 1; if (value.empty()) return false; }
        else if (equalInsensitive(key,"content-length")) {
            bit = 2; if (value.empty()) return false;
            for (char c : value) {
                if (c < '0' || c > '9' || contentLength > (std::numeric_limits<std::uint32_t>::max() - (c-'0'))/10) return false;
                contentLength = contentLength*10 + (c-'0');
            }
        } else if (equalInsensitive(key,"authorization")) { bit = 4; authorization = value; }
        else if (equalInsensitive(key,"content-type")) { bit = 8; contentType = value; }
        else if (equalInsensitive(key,"x-content-sha256")) { bit = 16; sha256 = value; }
        else if (equalInsensitive(key,"x-track-id")) { bit = 32; trackId = value; }
        else if (equalInsensitive(key,"transfer-encoding") || equalInsensitive(key,"expect")) return false;
        if (bit && (seen & bit)) return false;
        seen |= bit;
    }
    return position == input.size()-2 && (seen & 1) && (method == HttpMethod::get || (seen & 2));
}
} // namespace neonbyte
