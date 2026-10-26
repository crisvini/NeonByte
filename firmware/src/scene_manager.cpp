#include "neonbyte/scene_manager.h"

#include <algorithm>

namespace neonbyte {

SceneManager::SceneManager(Clock& clock, Storage& storage, std::uint64_t heartbeatTimeoutMs)
    : clock_(clock), storage_(storage), heartbeatTimeoutMs_(heartbeatTimeoutMs) {
    DisplayMode storedMode = DisplayMode::automatic;
    if (storage_.loadMode(storedMode) && isValidMode(storedMode)) {
        mode_ = storedMode;
    }
}

DisplayMode SceneManager::mode() const {
    return mode_;
}

bool SceneManager::setMode(DisplayMode mode) {
    if (!isValidMode(mode) || !storage_.saveMode(mode)) {
        return false;
    }
    mode_ = mode;
    return true;
}

void SceneManager::updateNowPlaying(const NowPlaying& nowPlaying) {
    nowPlaying_ = nowPlaying;
    nowPlaying_.progressMs = std::min(nowPlaying_.progressMs, nowPlaying_.durationMs);
    const std::uint64_t nowUnixMs = clock_.unixMillis();
    sampleAgeAtReceiptMs_ = nowUnixMs >= nowPlaying_.sampledAtUnixMs
        ? nowUnixMs - nowPlaying_.sampledAtUnixMs : 0;
    if (nowPlaying_.isPlaying) {
        const std::uint64_t remaining = nowPlaying_.durationMs - nowPlaying_.progressMs;
        nowPlaying_.progressMs = sampleAgeAtReceiptMs_ >= remaining
            ? nowPlaying_.durationMs
            : nowPlaying_.progressMs + sampleAgeAtReceiptMs_;
    }
    receivedPlaybackMs_ = clock_.monotonicMillis();
    hasNowPlaying_ = true;
}

void SceneManager::heartbeat() {
    lastHeartbeatMs_ = clock_.monotonicMillis();
    hasHeartbeat_ = true;
}

std::uint64_t SceneManager::currentProgressMs(std::uint64_t nowMs) const {
    if (!hasNowPlaying_) {
        return 0;
    }
    const std::uint64_t baseProgress = std::min(nowPlaying_.progressMs, nowPlaying_.durationMs);
    if (!nowPlaying_.isPlaying || nowMs <= receivedPlaybackMs_) {
        return baseProgress;
    }
    const std::uint64_t remaining = nowPlaying_.durationMs - baseProgress;
    const std::uint64_t elapsed = nowMs - receivedPlaybackMs_;
    return elapsed >= remaining ? nowPlaying_.durationMs : baseProgress + elapsed;
}

SceneState SceneManager::currentState() const {
    const std::uint64_t nowMs = clock_.monotonicMillis();
    const bool agentAvailable = hasHeartbeat_ && nowMs >= lastHeartbeatMs_ &&
        nowMs - lastHeartbeatMs_ <= heartbeatTimeoutMs_;
    const bool playbackFresh = hasNowPlaying_ && nowMs >= receivedPlaybackMs_ &&
        sampleAgeAtReceiptMs_ <= heartbeatTimeoutMs_ &&
        nowMs - receivedPlaybackMs_ <= heartbeatTimeoutMs_ - sampleAgeAtReceiptMs_;
    const bool playing = agentAvailable && playbackFresh && nowPlaying_.isPlaying;

    if (mode_ == DisplayMode::gif) {
        return {ActiveScene::gif, false, agentAvailable, currentProgressMs(nowMs), hasNowPlaying_ ? &nowPlaying_ : nullptr};
    }
    if (mode_ == DisplayMode::spotify) {
        return {ActiveScene::spotify, !playing, agentAvailable, currentProgressMs(nowMs), hasNowPlaying_ ? &nowPlaying_ : nullptr};
    }
    if (playing) {
        return {ActiveScene::spotify, false, true, currentProgressMs(nowMs), &nowPlaying_};
    }
    return {ActiveScene::gif, false, agentAvailable, currentProgressMs(nowMs), hasNowPlaying_ ? &nowPlaying_ : nullptr};
}

const NowPlaying* SceneManager::nowPlaying() const {
    return hasNowPlaying_ ? &nowPlaying_ : nullptr;
}

void SceneManager::render(DisplayRenderer& display) const {
    const SceneState state = currentState();
    if (state.activeScene == ActiveScene::gif) {
        display.showGif();
    } else if (state.waiting || state.nowPlaying == nullptr) {
        display.showSpotifyWaiting();
    } else {
        display.showSpotify(*state.nowPlaying, state.progressMs);
    }
}

} // namespace neonbyte
