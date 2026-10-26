#include "neonbyte/protocol.h"

#include <algorithm>
#include <array>
#include <cstdint>
#include <limits>
#include <string_view>

namespace neonbyte {
namespace {

constexpr std::string_view JSON_CONTENT_TYPE = "application/json";
constexpr std::string_view V1_STATUS_PATH = "/api/v1/status";
constexpr std::string_view V1_MODE_PATH = "/api/v1/mode";
constexpr std::string_view V1_SPOTIFY_PATH = "/api/v1/spotify";
constexpr std::string_view V1_HEARTBEAT_PATH = "/api/v1/heartbeat";
constexpr std::string_view V1_COVER_PATH = "/api/v1/cover";
constexpr std::string_view V1_ANIMATION_PATH = "/api/v1/animation";

class JsonParser {
public:
    explicit JsonParser(std::string_view input) : input_(input) {}

    bool parseMode(DisplayMode& mode) {
        std::uint32_t seen = 0;
        if (!beginObject()) {
            return false;
        }
        do {
            FixedText key{};
            if (!readKey(key) || key.view() != "mode" || (seen & 1U) != 0) {
                return false;
            }
            seen |= 1U;
            FixedText value{};
            if (!parseString(value)) {
                return false;
            }
            if (value.view() == "auto") {
                mode = DisplayMode::automatic;
            } else if (value.view() == "spotify") {
                mode = DisplayMode::spotify;
            } else if (value.view() == "gif") {
                mode = DisplayMode::gif;
            } else {
                return false;
            }
        } while (nextProperty());
        return seen == 1U && atEnd();
    }

    bool parseNowPlaying(NowPlaying& track) {
        constexpr std::uint32_t requiredFields = 0x7f;
        std::uint32_t seen = 0;
        if (!beginObject()) {
            return false;
        }
        do {
            FixedText key{};
            if (!readKey(key)) {
                return false;
            }
            std::uint32_t field = 0;
            if (key.view() == "trackId") field = 1U << 0;
            else if (key.view() == "title") field = 1U << 1;
            else if (key.view() == "artist") field = 1U << 2;
            else if (key.view() == "isPlaying") field = 1U << 3;
            else if (key.view() == "durationMs") field = 1U << 4;
            else if (key.view() == "progressMs") field = 1U << 5;
            else if (key.view() == "sampledAtUnixMs") field = 1U << 6;
            else return false;
            if ((seen & field) != 0) {
                return false;
            }
            seen |= field;

            if (field == (1U << 0)) {
                if (!parseString(track.trackId) || track.trackId.length == 0) return false;
            } else if (field == (1U << 1)) {
                if (!parseString(track.title)) return false;
            } else if (field == (1U << 2)) {
                if (!parseString(track.artist)) return false;
            } else if (field == (1U << 3)) {
                if (!parseBoolean(track.isPlaying)) return false;
            } else if (field == (1U << 4)) {
                if (!parseUnsignedInteger(track.durationMs)) return false;
            } else if (field == (1U << 5)) {
                if (!parseUnsignedInteger(track.progressMs)) return false;
            } else if (field == (1U << 6)) {
                if (!parseUnsignedInteger(track.sampledAtUnixMs)) return false;
            }
        } while (nextProperty());

        return seen == requiredFields && atEnd();
    }

private:
    bool beginObject() {
        skipWhitespace();
        if (!consume('{')) {
            return false;
        }
        skipWhitespace();
        if (consume('}')) {
            return false;
        }
        return true;
    }

    bool readKey(FixedText& key) {
        skipWhitespace();
        if (!parseString(key)) {
            return false;
        }
        skipWhitespace();
        if (!consume(':')) {
            return false;
        }
        skipWhitespace();
        return true;
    }

    bool nextProperty() {
        skipWhitespace();
        if (consume('}')) {
            return false;
        }
        if (!consume(',')) {
            failed_ = true;
            return false;
        }
        return true;
    }

    bool atEnd() {
        skipWhitespace();
        return !failed_ && position_ == input_.size();
    }

    void skipWhitespace() {
        while (position_ < input_.size()) {
            const char value = input_[position_];
            if (value != ' ' && value != '\t' && value != '\r' && value != '\n') {
                break;
            }
            ++position_;
        }
    }

    bool consume(char expected) {
        if (position_ >= input_.size() || input_[position_] != expected) {
            return false;
        }
        ++position_;
        return true;
    }

    bool appendCodePoint(FixedText& target, std::uint32_t codePoint, std::size_t& codePointCount) {
        if (++codePointCount > MAX_TEXT_CODE_POINTS) {
            return false;
        }
        std::array<char, 4> encoded{};
        std::size_t count = 0;
        if (codePoint <= 0x7f) {
            encoded[count++] = static_cast<char>(codePoint);
        } else if (codePoint <= 0x7ff) {
            encoded[count++] = static_cast<char>(0xc0 | (codePoint >> 6));
            encoded[count++] = static_cast<char>(0x80 | (codePoint & 0x3f));
        } else if (codePoint <= 0xffff) {
            encoded[count++] = static_cast<char>(0xe0 | (codePoint >> 12));
            encoded[count++] = static_cast<char>(0x80 | ((codePoint >> 6) & 0x3f));
            encoded[count++] = static_cast<char>(0x80 | (codePoint & 0x3f));
        } else if (codePoint <= 0x10ffff) {
            encoded[count++] = static_cast<char>(0xf0 | (codePoint >> 18));
            encoded[count++] = static_cast<char>(0x80 | ((codePoint >> 12) & 0x3f));
            encoded[count++] = static_cast<char>(0x80 | ((codePoint >> 6) & 0x3f));
            encoded[count++] = static_cast<char>(0x80 | (codePoint & 0x3f));
        } else {
            return false;
        }
        if (target.length + count > target.bytes.size()) {
            return false;
        }
        for (std::size_t index = 0; index < count; ++index) {
            target.bytes[target.length++] = encoded[index];
        }
        return true;
    }

    bool parseHex4(std::uint32_t& value) {
        if (position_ + 4 > input_.size()) {
            return false;
        }
        value = 0;
        for (std::size_t index = 0; index < 4; ++index) {
            const char digit = input_[position_++];
            value <<= 4;
            if (digit >= '0' && digit <= '9') value |= static_cast<std::uint32_t>(digit - '0');
            else if (digit >= 'a' && digit <= 'f') value |= static_cast<std::uint32_t>(digit - 'a' + 10);
            else if (digit >= 'A' && digit <= 'F') value |= static_cast<std::uint32_t>(digit - 'A' + 10);
            else return false;
        }
        return true;
    }

    bool parseString(FixedText& output) {
        output.length = 0;
        if (!consume('"')) {
            return false;
        }
        std::size_t codePointCount = 0;
        while (position_ < input_.size()) {
            const auto first = static_cast<std::uint8_t>(input_[position_]);
            if (first == '"') {
                ++position_;
                return true;
            }
            if (first == '\\') {
                ++position_;
                if (position_ >= input_.size()) return false;
                const char escape = input_[position_++];
                std::uint32_t codePoint = 0;
                switch (escape) {
                case '"': codePoint = '"'; break;
                case '\\': codePoint = '\\'; break;
                case '/': codePoint = '/'; break;
                case 'b': codePoint = '\b'; break;
                case 'f': codePoint = '\f'; break;
                case 'n': codePoint = '\n'; break;
                case 'r': codePoint = '\r'; break;
                case 't': codePoint = '\t'; break;
                case 'u':
                    if (!parseHex4(codePoint)) return false;
                    if (codePoint >= 0xd800 && codePoint <= 0xdbff) {
                        if (position_ + 2 > input_.size() || input_[position_] != '\\' || input_[position_ + 1] != 'u') {
                            return false;
                        }
                        position_ += 2;
                        std::uint32_t lowSurrogate = 0;
                        if (!parseHex4(lowSurrogate) || lowSurrogate < 0xdc00 || lowSurrogate > 0xdfff) return false;
                        codePoint = 0x10000 + ((codePoint - 0xd800) << 10) + (lowSurrogate - 0xdc00);
                    } else if (codePoint >= 0xdc00 && codePoint <= 0xdfff) {
                        return false;
                    }
                    break;
                default: return false;
                }
                if (!appendCodePoint(output, codePoint, codePointCount)) return false;
                continue;
            }
            if (first < 0x20) {
                return false;
            }
            if (first < 0x80) {
                ++position_;
                if (!appendCodePoint(output, first, codePointCount)) return false;
                continue;
            }

            const std::size_t start = position_;
            std::size_t byteCount = 0;
            std::uint32_t codePoint = 0;
            std::uint32_t minimum = 0;
            if (first >= 0xc2 && first <= 0xdf) {
                byteCount = 2;
                codePoint = first & 0x1f;
                minimum = 0x80;
            } else if (first >= 0xe0 && first <= 0xef) {
                byteCount = 3;
                codePoint = first & 0x0f;
                minimum = 0x800;
            } else if (first >= 0xf0 && first <= 0xf4) {
                byteCount = 4;
                codePoint = first & 0x07;
                minimum = 0x10000;
            } else {
                return false;
            }
            if (position_ + byteCount > input_.size()) return false;
            for (std::size_t index = 1; index < byteCount; ++index) {
                const auto continuation = static_cast<std::uint8_t>(input_[position_ + index]);
                if ((continuation & 0xc0) != 0x80) return false;
                codePoint = (codePoint << 6) | (continuation & 0x3f);
            }
            if (codePoint < minimum || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
                return false;
            }
            position_ += byteCount;
            if (++codePointCount > MAX_TEXT_CODE_POINTS || output.length + byteCount > output.bytes.size()) return false;
            for (std::size_t index = 0; index < byteCount; ++index) {
                output.bytes[output.length++] = input_[start + index];
            }
        }
        return false;
    }

    bool parseBoolean(bool& output) {
        if (input_.substr(position_, 4) == "true") {
            position_ += 4;
            output = true;
            return true;
        }
        if (input_.substr(position_, 5) == "false") {
            position_ += 5;
            output = false;
            return true;
        }
        return false;
    }

    bool parseUnsignedInteger(std::uint64_t& output) {
        bool negative = false;
        if (position_ < input_.size() && input_[position_] == '-') {
            negative = true;
            ++position_;
        }

        const std::size_t integerStart = position_;
        if (position_ >= input_.size() || input_[position_] < '0' || input_[position_] > '9') return false;
        if (input_[position_] == '0') {
            ++position_;
            if (position_ < input_.size() && input_[position_] >= '0' && input_[position_] <= '9') return false;
        } else {
            while (position_ < input_.size() && input_[position_] >= '0' && input_[position_] <= '9') ++position_;
        }
        const std::size_t integerEnd = position_;

        std::size_t fractionStart = position_;
        std::size_t fractionEnd = position_;
        if (consume('.')) {
            fractionStart = position_;
            while (position_ < input_.size() && input_[position_] >= '0' && input_[position_] <= '9') ++position_;
            fractionEnd = position_;
            if (fractionStart == fractionEnd) return false;
        }

        bool exponentNegative = false;
        std::uint64_t exponentMagnitude = 0;
        if (position_ < input_.size() && (input_[position_] == 'e' || input_[position_] == 'E')) {
            ++position_;
            if (position_ < input_.size() && (input_[position_] == '+' || input_[position_] == '-')) {
                exponentNegative = input_[position_] == '-';
                ++position_;
            }
            const std::size_t exponentStart = position_;
            while (position_ < input_.size() && input_[position_] >= '0' && input_[position_] <= '9') {
                exponentMagnitude = std::min<std::uint64_t>(1'000'000'000ULL,
                    exponentMagnitude * 10 + static_cast<std::uint64_t>(input_[position_] - '0'));
                ++position_;
            }
            if (exponentStart == position_) return false;
        }

        const std::size_t numberEnd = position_;
        skipWhitespace();
        if (position_ < input_.size() && input_[position_] != ',' && input_[position_] != '}') return false;
        position_ = numberEnd;

        const std::size_t integerDigits = integerEnd - integerStart;
        const std::size_t fractionDigits = fractionEnd - fractionStart;
        const std::size_t totalDigits = integerDigits + fractionDigits;
        const auto digitAt = [&](std::size_t index) -> char {
            return index < integerDigits ? input_[integerStart + index] : input_[fractionStart + index - integerDigits];
        };

        std::size_t firstNonZero = 0;
        while (firstNonZero < totalDigits && digitAt(firstNonZero) == '0') ++firstNonZero;
        if (firstNonZero == totalDigits) {
            output = 0;
            return true;
        }

        constexpr std::int64_t EXPONENT_LIMIT = 1'000'000'000;
        const std::int64_t exponent = static_cast<std::int64_t>(exponentMagnitude) * (exponentNegative ? -1 : 1);
        const std::int64_t fractionLength = static_cast<std::int64_t>(fractionDigits);
        const std::int64_t scale = std::clamp(exponent - fractionLength, -EXPONENT_LIMIT, EXPONENT_LIMIT);
        std::size_t keptDigits = totalDigits;
        std::size_t appendedZeros = 0;
        if (scale < 0) {
            const std::uint64_t removed = static_cast<std::uint64_t>(-scale);
            if (removed >= totalDigits) return false;
            keptDigits -= static_cast<std::size_t>(removed);
            for (std::size_t index = keptDigits; index < totalDigits; ++index) {
                if (digitAt(index) != '0') return false;
            }
        } else {
            appendedZeros = static_cast<std::size_t>(scale);
        }

        const std::size_t significantDigits = keptDigits - firstNonZero + appendedZeros;
        if (significantDigits > 20) return false;
        std::uint64_t value = 0;
        for (std::size_t index = firstNonZero; index < keptDigits; ++index) {
            const std::uint64_t digit = static_cast<std::uint64_t>(digitAt(index) - '0');
            if (value > (std::numeric_limits<std::uint64_t>::max() - digit) / 10) return false;
            value = value * 10 + digit;
        }
        for (std::size_t index = 0; index < appendedZeros; ++index) {
            if (value > std::numeric_limits<std::uint64_t>::max() / 10) return false;
            value *= 10;
        }
        if (negative && value != 0) return false;
        output = value;
        return true;
    }

    std::string_view input_;
    std::size_t position_ = 0;
    bool failed_ = false;
};

class ResponseWriter {
public:
    explicit ResponseWriter(HttpResponse& response) : response_(response) {}

    bool append(std::string_view text) {
        if (response_.bodySize >= response_.body.size() ||
            text.size() > response_.body.size() - 1 - response_.bodySize) return false;
        std::copy(text.begin(), text.end(), response_.body.begin() + response_.bodySize);
        response_.bodySize += text.size();
        response_.body[response_.bodySize] = '\0';
        return true;
    }

    bool appendUnsigned(std::uint64_t value) {
        std::array<char, 20> digits{};
        std::size_t count = 0;
        do {
            digits[count++] = static_cast<char>('0' + value % 10);
            value /= 10;
        } while (value != 0);
        while (count > 0) {
            if (!append({&digits[--count], 1})) return false;
        }
        return true;
    }

    bool appendQuoted(std::string_view text) {
        if (!append("\"")) return false;
        constexpr char HEX[] = "0123456789abcdef";
        for (unsigned char value : text) {
            if (value == '"' || value == '\\') {
                const char escaped[] = {'\\', static_cast<char>(value)};
                if (!append({escaped, sizeof(escaped)})) return false;
            } else if (value < 0x20) {
                const char escaped[] = {'\\', 'u', '0', '0', HEX[value >> 4], HEX[value & 0x0f]};
                if (!append({escaped, sizeof(escaped)})) return false;
            } else if (!append({reinterpret_cast<const char*>(&value), 1})) {
                return false;
            }
        }
        return append("\"");
    }

private:
    HttpResponse& response_;
};

HttpResponse noContent(std::uint16_t statusCode) {
    HttpResponse response{};
    response.statusCode = statusCode;
    return response;
}

HttpResponse errorResponse(std::uint16_t statusCode, std::string_view code, std::string_view message) {
    HttpResponse response{};
    response.statusCode = statusCode;
    response.contentType = JSON_CONTENT_TYPE;
    ResponseWriter writer(response);
    writer.append("{\"code\":");
    writer.appendQuoted(code);
    writer.append(",\"message\":");
    writer.appendQuoted(message);
    writer.append("}");
    return response;
}

bool validUtf8WithLimit(std::string_view text, std::size_t maxCodePoints) {
    std::size_t position = 0;
    std::size_t codePointCount = 0;
    while (position < text.size()) {
        const auto first = static_cast<std::uint8_t>(text[position]);
        std::size_t byteCount = 1;
        std::uint32_t codePoint = first;
        std::uint32_t minimum = 0;
        if (first >= 0xc2 && first <= 0xdf) {
            byteCount = 2;
            codePoint = first & 0x1f;
            minimum = 0x80;
        } else if (first >= 0xe0 && first <= 0xef) {
            byteCount = 3;
            codePoint = first & 0x0f;
            minimum = 0x800;
        } else if (first >= 0xf0 && first <= 0xf4) {
            byteCount = 4;
            codePoint = first & 0x07;
            minimum = 0x10000;
        } else if (first >= 0x80) {
            return false;
        }
        if (position + byteCount > text.size()) return false;
        for (std::size_t index = 1; index < byteCount; ++index) {
            const auto continuation = static_cast<std::uint8_t>(text[position + index]);
            if ((continuation & 0xc0) != 0x80) return false;
            codePoint = (codePoint << 6) | (continuation & 0x3f);
        }
        if (codePoint < minimum || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
            return false;
        }
        position += byteCount;
        if (++codePointCount > maxCodePoints) return false;
    }
    return true;
}

bool isJsonContentType(std::string_view contentType) {
    const std::size_t separator = contentType.find(';');
    std::string_view mediaType = contentType.substr(0, separator);
    while (!mediaType.empty() && (mediaType.front() == ' ' || mediaType.front() == '\t')) mediaType.remove_prefix(1);
    while (!mediaType.empty() && (mediaType.back() == ' ' || mediaType.back() == '\t')) mediaType.remove_suffix(1);
    constexpr std::string_view EXPECTED = "application/json";
    if (mediaType.size() != EXPECTED.size()) return false;
    for (std::size_t index = 0; index < mediaType.size(); ++index) {
        char value = mediaType[index];
        if (value >= 'A' && value <= 'Z') value = static_cast<char>(value - 'A' + 'a');
        if (value != EXPECTED[index]) return false;
    }
    return true;
}

HttpResponse statusResponse(const SceneManager& scenes, const Storage& storage,
                            std::string_view firmwareVersion, std::string_view ipAddress) {
    if (firmwareVersion.empty() || ipAddress.empty() ||
        !validUtf8WithLimit(firmwareVersion, 64) || !validUtf8WithLimit(ipAddress, 64)) {
        return errorResponse(500, "internal_error", "Device status is unavailable.");
    }
    HttpResponse response{};
    response.statusCode = 200;
    response.contentType = JSON_CONTENT_TYPE;
    ResponseWriter writer(response);
    writer.append("{\"protocolVersion\":\"v1\",\"firmwareVersion\":");
    writer.appendQuoted(firmwareVersion);
    writer.append(",\"ip\":");
    writer.appendQuoted(ipAddress);
    writer.append(",\"freeStorageBytes\":");
    writer.appendUnsigned(storage.freeBytes());
    writer.append(",\"mode\":");
    writer.appendQuoted(modeName(scenes.mode()));
    writer.append(",\"activeScene\":");
    writer.appendQuoted(sceneName(scenes.currentState().activeScene));
    writer.append("}");
    return response;
}

} // namespace

ProtocolHandler::ProtocolHandler(SceneManager& scenes, Storage& storage, RequestAuthenticator& authenticator)
    : scenes_(scenes), storage_(storage), authenticator_(authenticator) {}

BearerTokenAuthenticator::BearerTokenAuthenticator(std::string_view expectedToken)
    : expectedToken_(expectedToken) {}

bool BearerTokenAuthenticator::isAuthorized(std::string_view authorizationHeader) const {
    constexpr std::string_view PREFIX = "Bearer ";
    if (expectedToken_.empty() || authorizationHeader.size() != PREFIX.size() + expectedToken_.size()) {
        return false;
    }
    for (std::size_t index = 0; index < PREFIX.size(); ++index) {
        char value = authorizationHeader[index];
        if (value >= 'A' && value <= 'Z') value = static_cast<char>(value - 'A' + 'a');
        if (value != static_cast<char>(PREFIX[index] >= 'A' && PREFIX[index] <= 'Z'
            ? PREFIX[index] - 'A' + 'a' : PREFIX[index])) return false;
    }

    const std::string_view suppliedToken = authorizationHeader.substr(PREFIX.size());
    std::uint8_t difference = 0;
    for (std::size_t index = 0; index < expectedToken_.size(); ++index) {
        difference |= static_cast<std::uint8_t>(suppliedToken[index] ^ expectedToken_[index]);
    }
    return difference == 0;
}

HttpResponse ProtocolHandler::statusResponse(DeviceInfo deviceInfo) const {
    return neonbyte::statusResponse(scenes_, storage_, deviceInfo.firmwareVersion, deviceInfo.ipAddress);
}

HttpResponse ProtocolHandler::handle(const HttpRequest& request, DeviceInfo deviceInfo) {
    if (request.path == V1_STATUS_PATH) {
        if (request.method != HttpMethod::get || !request.body.empty()) {
            return errorResponse(400, "invalid_request", "The status route requires GET without a body.");
        }
        return statusResponse(deviceInfo);
    }

    const bool binaryRoute = request.path == V1_COVER_PATH || request.path == V1_ANIMATION_PATH;
    const bool knownRoute = request.path == V1_MODE_PATH || request.path == V1_SPOTIFY_PATH ||
        request.path == V1_HEARTBEAT_PATH || binaryRoute;
    if (!knownRoute) {
        return errorResponse(404, "not_found", "The requested route was not found.");
    }
    if (!authenticator_.isAuthorized(request.authorization)) {
        return errorResponse(401, "unauthorized", "A valid bearer token is required.");
    }

    if (request.path == V1_MODE_PATH) {
        if (request.method != HttpMethod::put) {
            return errorResponse(400, "invalid_request", "The mode route requires PUT.");
        }
        if (!isJsonContentType(request.contentType)) {
            return errorResponse(415, "unsupported_media_type", "The mode route requires application/json.");
        }
        DisplayMode mode = DisplayMode::automatic;
        JsonParser parser(request.body);
        if (!parser.parseMode(mode)) {
            return errorResponse(400, "invalid_request", "The mode request does not match its v1 schema.");
        }
        if (!scenes_.setMode(mode)) {
            return errorResponse(500, "internal_error", "The display mode could not be saved.");
        }
        return noContent(204);
    }

    if (request.path == V1_SPOTIFY_PATH) {
        if (request.method != HttpMethod::put) {
            return errorResponse(400, "invalid_request", "The Spotify route requires PUT.");
        }
        if (!isJsonContentType(request.contentType)) {
            return errorResponse(415, "unsupported_media_type", "The Spotify route requires application/json.");
        }
        NowPlaying track{};
        JsonParser parser(request.body);
        if (!parser.parseNowPlaying(track)) {
            return errorResponse(400, "invalid_request", "The Spotify request does not match its v1 schema.");
        }
        scenes_.updateNowPlaying(track);
        return noContent(204);
    }

    if (request.path == V1_HEARTBEAT_PATH) {
        if (request.method != HttpMethod::post || !request.body.empty()) {
            return errorResponse(400, "invalid_request", "The heartbeat route requires POST without a body.");
        }
        scenes_.heartbeat();
        return noContent(204);
    }

    if (binaryRoute) {
        if (request.method != HttpMethod::put) {
            return errorResponse(400, "invalid_request", "The media route requires PUT.");
        }
        return errorResponse(415, "unsupported_media_type",
            "Binary media updates require storage and payload limits that are still pending.");
    }

    return errorResponse(404, "not_found", "The requested route was not found.");
}

bool dispatchOneRequest(NetworkOperations& network, ProtocolHandler& protocol, DeviceInfo deviceInfo) {
    HttpRequest request{};
    if (!network.receive(request)) {
        return false;
    }
    const HttpResponse response = protocol.handle(request, deviceInfo);
    return network.respond(response);
}

} // namespace neonbyte
