#pragma once

#include "neonbyte/types.h"

#include <cstddef>
#include <cstdint>
#include <string_view>

namespace neonbyte {

class Clock {
public:
    virtual ~Clock() = default;
    virtual std::uint64_t monotonicMillis() const = 0;
    virtual std::uint64_t unixMillis() const = 0;
};

class Storage {
public:
    virtual ~Storage() = default;
    virtual bool loadMode(DisplayMode& mode) const = 0;
    virtual bool saveMode(DisplayMode mode) = 0;
    virtual std::uint64_t freeBytes() const = 0;
    virtual std::uint32_t animationSize() const = 0;
    virtual bool readAnimationAt(std::uint32_t offset, std::uint8_t* destination, std::size_t length) const = 0;
};

class DisplayRenderer {
public:
    virtual ~DisplayRenderer() = default;
    virtual void showGif() = 0;
    virtual void showSpotifyWaiting() = 0;
    virtual void showSpotify(const NowPlaying& track, std::uint64_t progressMs) = 0;
    virtual void beginAnimationFrame(std::uint16_t width, std::uint16_t height) = 0;
    virtual void writeAnimationPixels(std::uint32_t pixelByteOffset, const std::uint8_t* pixels, std::size_t length) = 0;
    virtual void endAnimationFrame(std::uint16_t delayMs) = 0;
};

struct HttpRequest;
struct HttpResponse;

class NetworkOperations {
public:
    virtual ~NetworkOperations() = default;
    virtual bool receive(HttpRequest& request) = 0;
    virtual bool respond(const HttpResponse& response) = 0;
};

class RequestAuthenticator {
public:
    virtual ~RequestAuthenticator() = default;
    virtual bool isAuthorized(std::string_view authorizationHeader) const = 0;
};

} // namespace neonbyte
