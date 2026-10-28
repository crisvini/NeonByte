#pragma once

#include "neonbyte/transfer.h"

#include <array>
#include <cstddef>
#include <cstdint>
#include <string_view>

namespace neonbyte {

constexpr std::uint32_t ANIMATION_UPLOAD_MAX_BYTES = 2'359'296;
constexpr std::uint32_t ANIMATION_UPLOAD_RESERVE_BYTES = 32 * 1024;
constexpr std::size_t ANIMATION_UPLOAD_MAX_CHUNK_BYTES = 1'024;
constexpr std::size_t ANIMATION_UPLOAD_WRITE_BUDGET_BYTES = 512;
constexpr std::uint64_t ANIMATION_UPLOAD_IDLE_TIMEOUT_MS = 60'000;
constexpr std::uint64_t ANIMATION_UPLOAD_TOTAL_TIMEOUT_MS = 600'000;
constexpr std::uint64_t ANIMATION_UPLOAD_TERMINAL_RETENTION_MS = 60'000;

class AnimationUploadBackend : public TransferSink {
public:
    virtual std::uint64_t animationUploadFreeBytes() const = 0;
    virtual std::uint32_t animationCandidateSize() const = 0;
    virtual bool beginAnimationCandidate(std::uint32_t length) = 0;
    virtual bool readAnimationCandidateAt(std::uint32_t offset, std::uint8_t* bytes, std::size_t length) const = 0;
    virtual bool sealAnimationCandidate() = 0;
    virtual bool markAnimationCandidateReady() = 0;
    virtual void discardAnimationCandidate() = 0;
};

enum class AnimationUploadState : std::uint8_t {
    Idle,
    Receiving,
    Verifying,
    Ready,
    Installed,
    Failed,
    Cancelled,
};

enum class AnimationUploadError : std::uint8_t {
    None,
    InvalidRequest,
    InsufficientStorage,
    WriteFailed,
    ReadFailed,
    ChecksumMismatch,
    InvalidAnimation,
    PromotionFailed,
    Expired,
};

enum class AnimationChunkResult : std::uint8_t {
    Accepted,
    Pending,
    IdenticalReplay,
    InsufficientStorage,
    Conflict,
    Invalid,
    NotFound,
    Failed,
};

class AnimationUploadSession {
public:
    explicit AnimationUploadSession(AnimationUploadBackend& backend) : backend_(backend) {}

    AnimationChunkResult begin(std::uint32_t uploadId, std::uint32_t sizeBytes,
                               std::string_view sha256, std::uint64_t nowMs,
                               std::uint32_t installedGeneration);
    AnimationChunkResult queueChunk(std::uint32_t uploadId, std::uint32_t offset,
                                    const std::uint8_t* bytes, std::size_t length,
                                    std::uint64_t nowMs);
    AnimationChunkResult step(std::uint64_t nowMs, std::uint8_t* comparisonBuffer,
                              std::size_t bufferCapacity);
    AnimationChunkResult complete(std::uint32_t uploadId, std::uint64_t nowMs);
    AnimationChunkResult cancel(std::uint32_t uploadId, std::uint64_t nowMs);
    void markReady(std::uint64_t nowMs);
    void markInstalled(std::uint64_t nowMs);
    void fail(AnimationUploadError error, std::uint64_t nowMs);
    void noteValidationProgress(std::uint64_t nowMs);
    bool expire(std::uint64_t nowMs);
    bool owns(std::uint32_t uploadId) const;
    bool blocksOtherUploads() const;
    AnimationUploadState state() const { return state_; }
    AnimationUploadError error() const { return error_; }
    std::uint32_t uploadId() const { return uploadId_; }
    std::uint32_t expectedBytes() const { return expectedBytes_; }
    std::uint32_t receivedBytes() const { return receivedBytes_; }
    std::uint32_t installedGeneration() const { return installedGeneration_; }
    std::string_view sha256() const { return {sha256_.data(), sha256_.size()}; }
    bool hasPendingChunk() const { return chunkMode_ != ChunkMode::None; }

private:
    enum class ChunkMode : std::uint8_t { None, Write, Compare };
    AnimationChunkResult validateId(std::uint32_t uploadId, std::uint64_t nowMs);
    void clearChunk();
    void setTerminal(AnimationUploadState state, AnimationUploadError error, std::uint64_t nowMs);

    AnimationUploadBackend& backend_;
    std::array<char, 64> sha256_{};
    const std::uint8_t* chunkBytes_ = nullptr;
    std::uint32_t uploadId_ = 0;
    std::uint32_t expectedBytes_ = 0;
    std::uint32_t receivedBytes_ = 0;
    std::uint32_t chunkOffset_ = 0;
    std::uint32_t chunkLength_ = 0;
    std::uint32_t chunkProgress_ = 0;
    std::uint32_t previousChunkOffset_ = 0;
    std::uint32_t previousChunkLength_ = 0;
    std::uint32_t installedGeneration_ = 0;
    std::uint64_t startedAtMs_ = 0;
    std::uint64_t lastProgressAtMs_ = 0;
    std::uint64_t terminalAtMs_ = 0;
    AnimationUploadState state_ = AnimationUploadState::Idle;
    AnimationUploadError error_ = AnimationUploadError::None;
    ChunkMode chunkMode_ = ChunkMode::None;
};

} // namespace neonbyte
