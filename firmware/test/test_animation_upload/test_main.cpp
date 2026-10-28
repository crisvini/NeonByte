#include <unity.h>

#include "neonbyte/animation_upload.h"

#include <algorithm>
#include <array>
#include <cstdint>
#include <vector>

using namespace neonbyte;

namespace {

constexpr std::string_view HASH = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

class UploadBackend final : public AnimationUploadBackend {
public:
    std::uint64_t space = 4 * 1024 * 1024;
    std::vector<std::uint8_t> candidate;
    std::size_t maxWrite = 0;
    bool failWrite = false;
    bool failRead = false;
    bool sealed = false;
    bool ready = false;
    bool discarded = false;

    std::uint64_t animationUploadFreeBytes() const override { return space; }
    std::uint32_t animationCandidateSize() const override { return static_cast<std::uint32_t>(candidate.size()); }
    bool beginAnimationCandidate(std::uint32_t length) override {
        candidate.clear(); candidate.reserve(length); sealed = ready = discarded = false; return true;
    }
    bool begin(std::uint32_t length) override { candidate.reserve(length); return true; }
    bool write(const std::uint8_t* bytes, std::size_t length) override {
        maxWrite = std::max(maxWrite, length);
        if (failWrite) return false;
        candidate.insert(candidate.end(), bytes, bytes + length); return true;
    }
    bool readAnimationCandidateAt(std::uint32_t offset, std::uint8_t* bytes, std::size_t length) const override {
        if (failRead || offset > candidate.size() || length > candidate.size() - offset) return false;
        std::copy_n(candidate.data() + offset, length, bytes); return true;
    }
    bool sealAnimationCandidate() override { sealed = true; return true; }
    bool markAnimationCandidateReady() override { ready = true; return true; }
    void discardAnimationCandidate() override { candidate.clear(); discarded = true; ready = false; }
    bool commit() override { return true; }
    void abort() override { discardAnimationCandidate(); }
};

void writeChunk(AnimationUploadSession& session, std::uint32_t id, std::uint32_t offset,
                const std::vector<std::uint8_t>& bytes, std::uint64_t now) {
    TEST_ASSERT_EQUAL_INT(AnimationChunkResult::Pending,
        session.queueChunk(id, offset, bytes.data(), bytes.size(), now));
    std::array<std::uint8_t, ANIMATION_UPLOAD_WRITE_BUDGET_BYTES> scratch{};
    AnimationChunkResult result = AnimationChunkResult::Pending;
    while (result == AnimationChunkResult::Pending) result = session.step(now, scratch.data(), scratch.size());
    TEST_ASSERT_EQUAL_INT(AnimationChunkResult::Accepted, result);
}

void testUploadChunksWriteAtMost512BytesAndAcceptOnlyIdenticalImmediateReplay() {
    UploadBackend backend; AnimationUploadSession session(backend);
    TEST_ASSERT_EQUAL_INT(AnimationChunkResult::Accepted, session.begin(7, 1036, HASH, 100, 3));
    TEST_ASSERT_EQUAL_INT(AnimationUploadState::Receiving, session.state());
    std::vector<std::uint8_t> first(1000);
    for (std::size_t index = 0; index < first.size(); ++index) first[index] = static_cast<std::uint8_t>(index);
    writeChunk(session, 7, 0, first, 101);
    TEST_ASSERT_EQUAL_UINT32(1000, session.receivedBytes());
    TEST_ASSERT_EQUAL_UINT32(512, backend.maxWrite);
    TEST_ASSERT_EQUAL_INT(AnimationChunkResult::Pending,
        session.queueChunk(7, 0, first.data(), first.size(), 102));
    std::array<std::uint8_t, 512> scratch{};
    AnimationChunkResult matchingReplay = AnimationChunkResult::Pending;
    while (matchingReplay == AnimationChunkResult::Pending) matchingReplay = session.step(102, scratch.data(), scratch.size());
    TEST_ASSERT_EQUAL_INT(AnimationChunkResult::IdenticalReplay, matchingReplay);
    auto altered = first; altered[90] ^= 1;
    TEST_ASSERT_EQUAL_INT(AnimationChunkResult::Pending,
        session.queueChunk(7, 0, altered.data(), altered.size(), 102));
    AnimationChunkResult replay = AnimationChunkResult::Pending;
    while (replay == AnimationChunkResult::Pending) replay = session.step(102, scratch.data(), scratch.size());
    TEST_ASSERT_EQUAL_INT(AnimationChunkResult::Conflict, replay);
    TEST_ASSERT_EQUAL_UINT32(1000, session.receivedBytes());

    std::vector<std::uint8_t> last(36, 0x5a);
    writeChunk(session, 7, 1000, last, 103);
    TEST_ASSERT_EQUAL_UINT32(1036, session.receivedBytes());
    TEST_ASSERT_EQUAL_INT(AnimationChunkResult::Pending,
        session.queueChunk(7, 1000, last.data(), last.size(), 104));
    TEST_ASSERT_EQUAL_INT(AnimationChunkResult::IdenticalReplay, session.step(104, scratch.data(), scratch.size()));
    TEST_ASSERT_EQUAL_UINT32(1036, session.receivedBytes());
    TEST_ASSERT_EQUAL_INT(AnimationChunkResult::Accepted, session.complete(7, 105));
    TEST_ASSERT_TRUE(backend.sealed);
    TEST_ASSERT_EQUAL_INT(AnimationUploadState::Verifying, session.state());
    session.markReady(106);
    TEST_ASSERT_TRUE(backend.ready);
    TEST_ASSERT_TRUE(session.blocksOtherUploads());
    session.markInstalled(107);
    TEST_ASSERT_FALSE(session.blocksOtherUploads());
    TEST_ASSERT_EQUAL_INT(AnimationUploadState::Installed, session.state());
}

void testUploadRejectsBadAdmissionAndPreservesTheOldAssetOnWriteFailure() {
    UploadBackend backend; AnimationUploadSession session(backend);
    backend.space = 10;
    TEST_ASSERT_EQUAL_INT(AnimationChunkResult::InsufficientStorage, session.begin(8, 100, HASH, 0, 0));
    backend.space = 4 * 1024 * 1024;
    TEST_ASSERT_EQUAL_INT(AnimationChunkResult::Invalid, session.begin(8, 100, "bad", 0, 0));
    TEST_ASSERT_EQUAL_INT(AnimationChunkResult::Accepted, session.begin(8, 100, HASH, 0, 0));
    std::vector<std::uint8_t> data(100, 0x11);
    TEST_ASSERT_EQUAL_INT(AnimationChunkResult::Pending, session.queueChunk(8, 0, data.data(), data.size(), 1));
    backend.failWrite = true;
    std::array<std::uint8_t, 512> scratch{};
    TEST_ASSERT_EQUAL_INT(AnimationChunkResult::Failed, session.step(1, scratch.data(), scratch.size()));
    TEST_ASSERT_TRUE(backend.discarded);
    TEST_ASSERT_EQUAL_INT(AnimationUploadError::WriteFailed, session.error());
}

void testUploadIdleExpiryAndCancellationAreBoundedAndIdempotent() {
    UploadBackend backend; AnimationUploadSession session(backend);
    TEST_ASSERT_EQUAL_INT(AnimationChunkResult::Accepted, session.begin(9, 100, HASH, 100, 0));
    TEST_ASSERT_TRUE(session.expire(60'101));
    TEST_ASSERT_EQUAL_INT(AnimationUploadState::Failed, session.state());
    TEST_ASSERT_EQUAL_INT(AnimationUploadError::Expired, session.error());
    TEST_ASSERT_TRUE(backend.discarded);
    TEST_ASSERT_EQUAL_INT(AnimationChunkResult::Accepted, session.cancel(9, 60'102));

    TEST_ASSERT_EQUAL_INT(AnimationChunkResult::Accepted, session.begin(10, 100, HASH, 70'000, 0));
    TEST_ASSERT_EQUAL_INT(AnimationChunkResult::Accepted, session.cancel(10, 70'001));
    TEST_ASSERT_EQUAL_INT(AnimationChunkResult::Accepted, session.cancel(10, 70'002));
    TEST_ASSERT_EQUAL_INT(AnimationUploadState::Cancelled, session.state());
}

} // namespace

int main() {
    UNITY_BEGIN();
    RUN_TEST(testUploadChunksWriteAtMost512BytesAndAcceptOnlyIdenticalImmediateReplay);
    RUN_TEST(testUploadRejectsBadAdmissionAndPreservesTheOldAssetOnWriteFailure);
    RUN_TEST(testUploadIdleExpiryAndCancellationAreBoundedAndIdempotent);
    return UNITY_END();
}
