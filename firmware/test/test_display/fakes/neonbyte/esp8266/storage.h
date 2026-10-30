#pragma once

#include "neonbyte/animation_reader.h"
#include "neonbyte/animation_upload.h"
#include "neonbyte/esp8266/fake_clock.h"

#include <algorithm>
#include <cstdint>
#include <string_view>
#include <vector>

namespace neonbyte {

struct DeviceConfiguration {
    char token[65]{};
    char apPassword[17]{};
};

class PersistentStorage final : public Storage, public AnimationUploadBackend {
public:
    static constexpr std::uint64_t capacityBytes = 4 * 1024 * 1024;
    std::uint32_t assetRevision = 0;
    std::uint32_t animationRevision = 0;
    bool promotionPending = false;
    bool failAnimationReads = false;
    std::uint64_t* simulatedReadClock = nullptr;
    std::uint32_t simulatedReadDelayMs = 0;
    std::uint32_t simulatedReadTimeMicros = 0;
    mutable std::uint32_t animationReadCalls = 0;
    mutable std::uint32_t animationReadBytes = 0;
    mutable std::size_t largestAnimationRead = 0;
    std::uint32_t failAnimationReadCall = 0;
    bool candidateReady = false;
    std::vector<std::uint8_t> animationBytes;
    std::vector<std::uint8_t> candidate;
    std::vector<std::uint8_t> coverBytes;
    std::string_view coverTrack = "track";
    mutable std::vector<std::uint32_t> coverReads;

    bool loadMode(DisplayMode& mode) const override {
        static_cast<void>(mode);
        return false;
    }
    bool saveMode(DisplayMode mode) override {
        static_cast<void>(mode);
        return true;
    }
    std::uint64_t freeBytes() const override {
        const auto used = animationBytes.size() + candidate.size();
        return used < capacityBytes ? capacityBytes - used : 0;
    }
    std::uint64_t animationUploadFreeBytes() const override { return freeBytes(); }
    std::uint32_t animationCandidateSize() const override { return static_cast<std::uint32_t>(candidate.size()); }
    bool beginAnimationCandidate(std::uint32_t length) override {
        candidate.clear();
        candidate.reserve(length);
        candidateReady = false;
        return true;
    }
    bool begin(std::uint32_t length) override { return beginAnimationCandidate(length); }
    bool write(const std::uint8_t* bytes, std::size_t length) override {
        candidate.insert(candidate.end(), bytes, bytes + length);
        return true;
    }
    bool commit() override { return candidateReady; }
    void abort() override { discardAnimationCandidate(); }
    bool readAnimationCandidateAt(std::uint32_t offset, std::uint8_t* destination,
                                  std::size_t length) const override {
        if (offset > candidate.size() || length > candidate.size() - offset) return false;
        std::copy_n(candidate.data() + offset, length, destination);
        return true;
    }
    bool sealAnimationCandidate() override { return true; }
    bool markAnimationCandidateReady() override {
        candidateReady = true;
        promotionPending = true;
        return true;
    }
    void discardAnimationCandidate() override {
        candidate.clear();
        candidateReady = false;
        promotionPending = false;
    }
    std::uint32_t animationSize() const override {
        return static_cast<std::uint32_t>(animationBytes.size());
    }
    bool readAnimationAt(std::uint32_t offset, std::uint8_t* destination, std::size_t length) const override {
        ++animationReadCalls;
        animationReadBytes += static_cast<std::uint32_t>(length);
        ++displayTestAnimationReadCount;
        if (displayTestSpiTransactionActive) ++displayTestReadsDuringSpiTransaction;
        if (displayTestCompletedAnimationRows && !displayTestSpiTransactionActive)
            ++displayTestAnimationReadsBetweenRows;
        largestAnimationRead = std::max(largestAnimationRead, length);
        if (simulatedReadClock) *simulatedReadClock += simulatedReadDelayMs;
        advanceDisplayTestClockMicroseconds(simulatedReadTimeMicros);
        if (failAnimationReads || animationReadCalls == failAnimationReadCall) return false;
        if (offset > animationBytes.size() || length > animationBytes.size() - offset) return false;
        std::copy_n(animationBytes.data() + offset, length, destination);
        return true;
    }
    bool promoteAnimationCandidateAtBoundary() {
        if (!promotionPending) return false;
        if (candidateReady) {
            animationBytes = candidate;
            candidate.clear();
            candidateReady = false;
        }
        promotionPending = false;
        ++animationRevision;
        return true;
    }
    bool readCover(std::string_view trackId, std::uint32_t offset, std::uint8_t* bytes, std::size_t length) const {
        coverReads.push_back(offset);
        if (trackId != coverTrack || offset > coverBytes.size() || length > coverBytes.size() - offset) return false;
        std::copy_n(coverBytes.data() + offset, length, bytes);
        return true;
    }
};

} // namespace neonbyte
