#pragma once

#include "neonbyte/interfaces.h"

namespace neonbyte {

constexpr std::uint64_t DEFAULT_HEARTBEAT_TIMEOUT_MS = 45'000;

struct SceneState {
    ActiveScene activeScene = ActiveScene::gif;
    bool waiting = false;
    bool agentAvailable = false;
    std::uint64_t progressMs = 0;
    const NowPlaying* nowPlaying = nullptr;
};

class SceneManager {
public:
    SceneManager(Clock& clock, Storage& storage,
                 std::uint64_t heartbeatTimeoutMs = DEFAULT_HEARTBEAT_TIMEOUT_MS);

    DisplayMode mode() const;
    bool setMode(DisplayMode mode);
    void updateNowPlaying(const NowPlaying& nowPlaying);
    void heartbeat();
    SceneState currentState() const;
    const NowPlaying* nowPlaying() const;
    void render(DisplayRenderer& display) const;

private:
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
    NowPlaying nowPlaying_{};
};

} // namespace neonbyte
