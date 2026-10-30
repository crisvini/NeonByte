#pragma once

#include "neonbyte/interfaces.h"
#include "neonbyte/scene_manager.h"

#include <array>
#include <cstddef>
#include <cstdint>
#include <string_view>

namespace neonbyte {

constexpr std::size_t HTTP_RESPONSE_CAPACITY = 1024;

enum class HttpMethod : std::uint8_t {
    get,
    put,
    post,
    deleteMethod,
    other,
};

struct HttpRequest {
    HttpMethod method = HttpMethod::other;
    std::string_view path;
    std::string_view authorization;
    std::string_view contentType;
    std::string_view body;
};

struct HttpResponse {
    std::uint16_t statusCode = 500;
    std::string_view contentType;
    std::array<char, HTTP_RESPONSE_CAPACITY> body{};
    std::size_t bodySize = 0;

    std::string_view bodyView() const {
        return {body.data(), bodySize};
    }
};

struct DeviceInfo {
    std::string_view firmwareVersion;
    std::string_view ipAddress;
};

class BearerTokenAuthenticator final : public RequestAuthenticator {
public:
    explicit BearerTokenAuthenticator(std::string_view expectedToken);
    bool isAuthorized(std::string_view authorizationHeader) const override;

private:
    std::string_view expectedToken_;
};

class ProtocolHandler {
public:
    ProtocolHandler(SceneManager& scenes, Storage& storage, RequestAuthenticator& authenticator);
    HttpResponse handle(const HttpRequest& request, DeviceInfo deviceInfo);

private:
    HttpResponse statusResponse(DeviceInfo deviceInfo) const;

    SceneManager& scenes_;
    Storage& storage_;
    RequestAuthenticator& authenticator_;
};

bool isValidTrackId(std::string_view text);
bool decodeTrackId(std::string_view encoded, FixedText& text);

bool dispatchOneRequest(NetworkOperations& network, ProtocolHandler& protocol, DeviceInfo deviceInfo);

} // namespace neonbyte
