#pragma once

#include <array>
#include <cstdint>

constexpr int WL_CONNECTED = 3;

struct IPAddress {
    std::array<std::uint8_t, 4> bytes{};
    std::uint8_t operator[](unsigned index) const { return bytes[index]; }
};

struct FakeWifi {
    int connectionStatus = 0;
    IPAddress address{};
    int status() const { return connectionStatus; }
    IPAddress localIP() const { return address; }
};

inline FakeWifi WiFi;
