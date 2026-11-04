#pragma once

#include "neonbyte/interfaces.h"

namespace neonbyte {

constexpr std::uint64_t DEFAULT_HEARTBEAT_TIMEOUT_MS = 45'000;
constexpr std::uint32_t USD_PRICE_CENTS_MAX = 99'999'999;
constexpr std::int32_t USD_CHANGE_BASIS_POINTS_MAX = 999'999'999;
constexpr std::uint32_t USD_VALID_FOR_MS_MAX = 900'000;

struct UsdDeviceState {
    bool enabled = false;
    std::uint32_t priceCents = 0;
    std::int32_t changeBasisPoints = 0;
    std::uint32_t validForMs = 0;
};

struct SceneState {
    ActiveScene activeScene = ActiveScene::gif;
    bool waiting = false;
    bool agentAvailable = false;
    std::uint64_t progressMs = 0;
    const NowPlaying* nowPlaying = nullptr;
    UsdDeviceState usd{};
};

class SceneManager {
public:
    SceneManager(Clock& clock, Storage& storage,
                 std::uint64_t heartbeatTimeoutMs = DEFAULT_HEARTBEAT_TIMEOUT_MS);

    DisplayMode mode() const;
    bool setMode(DisplayMode mode);
    bool setUsdState(const UsdDeviceState& state);
    UsdDeviceState usdState() const;
    void updateNowPlaying(const NowPlaying& nowPlaying);
    void heartbeat();
    SceneState currentState() const;
    const NowPlaying* nowPlaying() const;
    void render(DisplayRenderer& display) const;

private:
    friend class ProtocolHandler;
    std::uint64_t currentProgressMs(std::uint64_t nowMs) const;

    Clock& clock_;
    Storage& storage_;
    DisplayMode mode_ = DisplayMode::automatic;
    std::uint64_t heartbeatTimeoutMs_;
    std::uint64_t lastHeartbeatMs_ = 0;
    std::uint64_t receivedPlaybackMs_ = 0;
    std::uint64_t sampleAgeAtReceiptMs_ = 0;
    bool hasHeartbeat_ = false;
    bool hasNowPlaying_ = false;
    UsdDeviceState usdState_{};
    std::uint64_t usdExpiresAtMs_ = 0;
    NowPlaying nowPlaying_{};
};

} // namespace neonbyte
