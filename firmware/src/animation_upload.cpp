#include "neonbyte/animation_upload.h"

#include "neonbyte/transfer.h"

#include <algorithm>
#include <cstring>

namespace neonbyte {

AnimationChunkResult AnimationUploadSession::begin(std::uint32_t uploadId, std::uint32_t sizeBytes,
                                                    std::string_view sha256, std::uint64_t nowMs,
                                                    std::uint32_t installedGeneration) {
    expire(nowMs);
    if (blocksOtherUploads() || uploadId == 0 || sizeBytes == 0 || sizeBytes > ANIMATION_UPLOAD_MAX_BYTES ||
        !isSha256(sha256)) return AnimationChunkResult::Invalid;
    if (backend_.animationUploadFreeBytes() < static_cast<std::uint64_t>(sizeBytes) + ANIMATION_UPLOAD_RESERVE_BYTES) {
        return AnimationChunkResult::InsufficientStorage;
    }
    if (!backend_.beginAnimationCandidate(sizeBytes)) return AnimationChunkResult::Failed;
    clearChunk();
    std::copy(sha256.begin(), sha256.end(), sha256_.begin());
    uploadId_ = uploadId;
    expectedBytes_ = sizeBytes;
    receivedBytes_ = 0;
    previousChunkOffset_ = previousChunkLength_ = 0;
    installedGeneration_ = installedGeneration;
    startedAtMs_ = lastProgressAtMs_ = nowMs;
    terminalAtMs_ = 0;
    error_ = AnimationUploadError::None;
    state_ = AnimationUploadState::Receiving;
    return AnimationChunkResult::Accepted;
}

AnimationChunkResult AnimationUploadSession::validateId(std::uint32_t uploadId, std::uint64_t nowMs) {
    expire(nowMs);
    if (uploadId_ == 0 || uploadId != uploadId_ || state_ == AnimationUploadState::Idle) return AnimationChunkResult::NotFound;
    if (state_ == AnimationUploadState::Failed || state_ == AnimationUploadState::Cancelled ||
        state_ == AnimationUploadState::Installed) return AnimationChunkResult::Conflict;
    return AnimationChunkResult::Accepted;
}

AnimationChunkResult AnimationUploadSession::queueChunk(std::uint32_t uploadId, std::uint32_t offset,
                                                         const std::uint8_t* bytes, std::size_t length,
                                                         std::uint64_t nowMs) {
    const auto idResult = validateId(uploadId, nowMs);
    if (idResult != AnimationChunkResult::Accepted) return idResult;
    if (state_ != AnimationUploadState::Receiving || chunkMode_ != ChunkMode::None || bytes == nullptr ||
        length == 0 || length > ANIMATION_UPLOAD_MAX_CHUNK_BYTES) return AnimationChunkResult::Invalid;
    const auto count = static_cast<std::uint32_t>(length);
    if (offset == receivedBytes_) {
        if (count > expectedBytes_ - receivedBytes_) return AnimationChunkResult::Conflict;
        chunkMode_ = ChunkMode::Write;
    } else if (previousChunkLength_ != 0 && offset == previousChunkOffset_ && count == previousChunkLength_) {
        chunkMode_ = ChunkMode::Compare;
    } else return AnimationChunkResult::Conflict;
    chunkBytes_ = bytes;
    chunkOffset_ = offset;
    chunkLength_ = count;
    chunkProgress_ = 0;
    return AnimationChunkResult::Pending;
}

AnimationChunkResult AnimationUploadSession::step(std::uint64_t nowMs, std::uint8_t* comparisonBuffer,
                                                   std::size_t bufferCapacity) {
    expire(nowMs);
    if (state_ != AnimationUploadState::Receiving || chunkMode_ == ChunkMode::None) return AnimationChunkResult::Invalid;
    if (chunkMode_ == ChunkMode::Write) {
        const auto count = std::min<std::size_t>(ANIMATION_UPLOAD_WRITE_BUDGET_BYTES, chunkLength_ - chunkProgress_);
        if (!backend_.write(chunkBytes_ + chunkProgress_, count)) {
            backend_.discardAnimationCandidate();
            setTerminal(AnimationUploadState::Failed, AnimationUploadError::WriteFailed, nowMs);
            clearChunk();
            return AnimationChunkResult::Failed;
        }
        chunkProgress_ += static_cast<std::uint32_t>(count);
        receivedBytes_ += static_cast<std::uint32_t>(count);
        lastProgressAtMs_ = nowMs;
        if (chunkProgress_ != chunkLength_) return AnimationChunkResult::Pending;
        previousChunkOffset_ = chunkOffset_;
        previousChunkLength_ = chunkLength_;
        clearChunk();
        return AnimationChunkResult::Accepted;
    }
    if (comparisonBuffer == nullptr || bufferCapacity == 0) return AnimationChunkResult::Invalid;
    const auto count = std::min<std::size_t>({ANIMATION_UPLOAD_WRITE_BUDGET_BYTES, bufferCapacity,
        static_cast<std::size_t>(chunkLength_ - chunkProgress_)});
    if (!backend_.readAnimationCandidateAt(chunkOffset_ + chunkProgress_, comparisonBuffer, count)) {
        backend_.discardAnimationCandidate();
        setTerminal(AnimationUploadState::Failed, AnimationUploadError::ReadFailed, nowMs);
        clearChunk();
        return AnimationChunkResult::Failed;
    }
    if (std::memcmp(comparisonBuffer, chunkBytes_ + chunkProgress_, count) != 0) {
        clearChunk();
        return AnimationChunkResult::Conflict;
    }
    chunkProgress_ += static_cast<std::uint32_t>(count);
    if (chunkProgress_ != chunkLength_) return AnimationChunkResult::Pending;
    clearChunk();
    return AnimationChunkResult::IdenticalReplay;
}

AnimationChunkResult AnimationUploadSession::complete(std::uint32_t uploadId, std::uint64_t nowMs) {
    const auto idResult = validateId(uploadId, nowMs);
    if (idResult != AnimationChunkResult::Accepted) return idResult;
    if (state_ != AnimationUploadState::Receiving || hasPendingChunk() || receivedBytes_ != expectedBytes_) {
        return AnimationChunkResult::Conflict;
    }
    if (!backend_.sealAnimationCandidate()) {
        backend_.discardAnimationCandidate();
        setTerminal(AnimationUploadState::Failed, AnimationUploadError::WriteFailed, nowMs);
        return AnimationChunkResult::Failed;
    }
    state_ = AnimationUploadState::Verifying;
    lastProgressAtMs_ = nowMs;
    return AnimationChunkResult::Accepted;
}

AnimationChunkResult AnimationUploadSession::cancel(std::uint32_t uploadId, std::uint64_t nowMs) {
    if (owns(uploadId) && (state_ == AnimationUploadState::Cancelled || state_ == AnimationUploadState::Failed)) {
        return AnimationChunkResult::Accepted;
    }
    const auto idResult = validateId(uploadId, nowMs);
    if (idResult == AnimationChunkResult::NotFound) return idResult;
    if (state_ == AnimationUploadState::Installed) return AnimationChunkResult::Conflict;
    backend_.discardAnimationCandidate();
    clearChunk();
    setTerminal(AnimationUploadState::Cancelled, AnimationUploadError::None, nowMs);
    return AnimationChunkResult::Accepted;
}

void AnimationUploadSession::markReady(std::uint64_t nowMs) {
    if (state_ != AnimationUploadState::Verifying) return;
    if (!backend_.markAnimationCandidateReady()) {
        fail(AnimationUploadError::PromotionFailed, nowMs);
        return;
    }
    state_ = AnimationUploadState::Ready;
    lastProgressAtMs_ = nowMs;
}

void AnimationUploadSession::markInstalled(std::uint64_t nowMs) {
    if (state_ != AnimationUploadState::Ready) return;
    state_ = AnimationUploadState::Installed;
    terminalAtMs_ = nowMs;
    error_ = AnimationUploadError::None;
}

void AnimationUploadSession::fail(AnimationUploadError error, std::uint64_t nowMs) {
    if (state_ == AnimationUploadState::Installed || state_ == AnimationUploadState::Cancelled) return;
    backend_.discardAnimationCandidate();
    clearChunk();
    setTerminal(AnimationUploadState::Failed, error, nowMs);
}

void AnimationUploadSession::noteValidationProgress(std::uint64_t nowMs) {
    if (state_ == AnimationUploadState::Verifying) lastProgressAtMs_ = nowMs;
}

bool AnimationUploadSession::expire(std::uint64_t nowMs) {
    if (state_ == AnimationUploadState::Idle) return false;
    if (state_ == AnimationUploadState::Installed || state_ == AnimationUploadState::Failed ||
        state_ == AnimationUploadState::Cancelled) {
        if (nowMs >= terminalAtMs_ && nowMs - terminalAtMs_ >= ANIMATION_UPLOAD_TERMINAL_RETENTION_MS) {
            state_ = AnimationUploadState::Idle;
            error_ = AnimationUploadError::None;
            uploadId_ = expectedBytes_ = receivedBytes_ = installedGeneration_ = 0;
            startedAtMs_ = lastProgressAtMs_ = terminalAtMs_ = 0;
            previousChunkOffset_ = previousChunkLength_ = 0;
            sha256_.fill(0);
            clearChunk();
            return true;
        }
        return false;
    }
    if ((nowMs >= startedAtMs_ && nowMs - startedAtMs_ > ANIMATION_UPLOAD_TOTAL_TIMEOUT_MS) ||
        (nowMs >= lastProgressAtMs_ && nowMs - lastProgressAtMs_ > ANIMATION_UPLOAD_IDLE_TIMEOUT_MS)) {
        backend_.discardAnimationCandidate();
        clearChunk();
        setTerminal(AnimationUploadState::Failed, AnimationUploadError::Expired, nowMs);
        return true;
    }
    return false;
}

bool AnimationUploadSession::owns(std::uint32_t uploadId) const {
    return uploadId != 0 && uploadId_ == uploadId && state_ != AnimationUploadState::Idle;
}

bool AnimationUploadSession::blocksOtherUploads() const {
    return state_ == AnimationUploadState::Receiving || state_ == AnimationUploadState::Verifying ||
        state_ == AnimationUploadState::Ready;
}

void AnimationUploadSession::clearChunk() {
    chunkBytes_ = nullptr;
    chunkOffset_ = chunkLength_ = chunkProgress_ = 0;
    chunkMode_ = ChunkMode::None;
}

void AnimationUploadSession::setTerminal(AnimationUploadState state, AnimationUploadError error,
                                         std::uint64_t nowMs) {
    state_ = state;
    error_ = error;
    terminalAtMs_ = nowMs;
}

} // namespace neonbyte
