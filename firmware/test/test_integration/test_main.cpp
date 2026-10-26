#include <unity.h>
#include "neonbyte/transfer.h"
#include "neonbyte/atomic_file.h"
#include "neonbyte/hash_job.h"
#include "neonbyte/wifi_configuration.h"
#include "neonbyte/http_headers.h"
#include "neonbyte/firmware_image.h"
#include <algorithm>
#include <cstring>
#include <string>
#include <vector>
using namespace neonbyte;
namespace {
const std::string HASH(64, 'a');
class Sink : public TransferSink {
public:
    std::vector<std::uint8_t> bytes;
    bool writeOk = true, commitOk = true, committed = false, aborted = false;
    bool begin(std::uint32_t) override { bytes.clear(); return true; }
    bool write(const std::uint8_t* data, std::size_t size) override {
        if (!writeOk) return false;
        bytes.insert(bytes.end(), data, data + size); return true;
    }
    bool commit() override { committed = commitOk; return commitOk; }
    void abort() override { aborted = true; }
};
class Bytes : public ImageSource {
public:
    std::vector<std::uint8_t> bytes;
    mutable std::size_t largestRead = 0;
    bool failRead = false;
    std::uint32_t size() const override { return bytes.size(); }
    bool readAt(std::uint32_t offset, std::uint8_t* out, std::size_t count) const override {
        largestRead = std::max(largestRead,count);
        if (failRead || offset > bytes.size() || count > bytes.size() - offset) return false;
        std::copy_n(bytes.data() + offset, count, out); return true;
    }
};
void testTransferRequiresExactLengthHashAndValidatedContent() {
    Sink sink; Transfer transfer(sink);
    TEST_ASSERT_TRUE(transfer.begin(4, 4, HASH));
    const std::uint8_t bytes[] = {1,2,3,4};
    TEST_ASSERT_TRUE(transfer.append(bytes, 2));
    TEST_ASSERT_FALSE(transfer.finish(HASH, true));
    TEST_ASSERT_FALSE(sink.committed); TEST_ASSERT_TRUE(sink.aborted);
    TEST_ASSERT_TRUE(transfer.begin(4, 4, HASH));
    TEST_ASSERT_TRUE(transfer.append(bytes, 4));
    TEST_ASSERT_FALSE(transfer.finish(std::string(64, 'b'), true));
    TEST_ASSERT_TRUE(transfer.begin(4, 4, HASH));
    TEST_ASSERT_TRUE(transfer.append(bytes, 4));
    TEST_ASSERT_FALSE(transfer.finish(HASH, false));
    TEST_ASSERT_TRUE(transfer.begin(4, 4, HASH));
    TEST_ASSERT_TRUE(transfer.append(bytes, 4));
    TEST_ASSERT_TRUE(transfer.finish(HASH, true)); TEST_ASSERT_TRUE(sink.committed);
    TEST_ASSERT_FALSE(transfer.finish(HASH, true));
}
void testTransferRejectsOverflowBadHeadersAndStorageFailures() {
    Sink sink; Transfer transfer(sink); const std::uint8_t bytes[] = {1,2,3,4};
    TEST_ASSERT_FALSE(transfer.begin(0, 4, HASH));
    TEST_ASSERT_FALSE(transfer.begin(5, 4, HASH));
    TEST_ASSERT_FALSE(transfer.begin(4, 4, std::string(64, 'A')));
    TEST_ASSERT_TRUE(transfer.begin(4, 4, HASH));
    TEST_ASSERT_FALSE(transfer.begin(4, 4, HASH)); // Single active transfer.
    TEST_ASSERT_FALSE(transfer.append(bytes, 5)); TEST_ASSERT_TRUE(sink.aborted);
    TEST_ASSERT_TRUE(transfer.begin(4, 4, HASH)); sink.writeOk = false;
    TEST_ASSERT_FALSE(transfer.append(bytes, 4)); TEST_ASSERT_TRUE(sink.aborted);
    sink.writeOk = true; sink.commitOk = false;
    TEST_ASSERT_TRUE(transfer.begin(4, 4, HASH));
    TEST_ASSERT_TRUE(transfer.append(bytes, 4));
    TEST_ASSERT_FALSE(transfer.finish(HASH, true));
}
void testStrictHttpFraming() {
    HttpHeaders headers;
    const std::string input = "PUT /api/v1/animation HTTP/1.1\r\nHost: neonbyte\r\nContent-Length: 123\r\nAuthorization: Bearer example\r\nX-Content-SHA256: " + HASH + "\r\n\r\n";
    TEST_ASSERT_TRUE(headers.parse(input));
    TEST_ASSERT_EQUAL_UINT32(123, headers.contentLength);
    TEST_ASSERT_TRUE(headers.path == "/api/v1/animation");
    for (const auto& extra : {"Content-Length: 1\r\nContent-Length: 1", "Content-Length: -1", "Content-Length: 4294967296", "Transfer-Encoding: chunked", "Content-Length: 1\r\nTransfer-Encoding: chunked", "Content-Length: 1\r\n Authorization: hidden", "Content-Length: 1x", "Content-Length: 1\r\nAuthorization: a\r\nAuthorization: b"}) {
        TEST_ASSERT_FALSE(headers.parse(std::string("PUT /api/v1/mode HTTP/1.1\r\nHost: neonbyte\r\n") + extra + "\r\n\r\n"));
    }
    TEST_ASSERT_FALSE(headers.parse("PUT /api/v1/mode HTTP/1.1\r\nHost: neonbyte\r\n\r\n"));
    TEST_ASSERT_FALSE(headers.parse("GET /api/v1/status HTTP/1.1\r\nHost: a\r\n\r\nextra"));
    TEST_ASSERT_TRUE(headers.parse("GET /api/v1/status HTTP/1.1\r\nHost: a\r\n\r\n"));
    TEST_ASSERT_EQUAL_UINT32(0, headers.contentLength);
}
void testWifiConfigurationRejectsMalformedCredentials() {
    WifiCredentials credentials;
    TEST_ASSERT_TRUE(parseWifiConfiguration("ssid=Example+Network&password=example%2Bpass",credentials));
    TEST_ASSERT_EQUAL_STRING("Example Network",credentials.ssid);
    TEST_ASSERT_EQUAL_STRING("example+pass",credentials.password);
    TEST_ASSERT_TRUE(parseWifiConfiguration("ssid=Open&password=",credentials));
    for (auto form : {"ssid=&password=", "ssid=Example&password=short", "ssid=Example&password=examplepass&token=override", "ssid=Example%00&password=examplepass", "ssid=Example&password=%zz", "password=examplepass&ssid=Example"}) {
        TEST_ASSERT_FALSE(parseWifiConfiguration(form,credentials));
    }
    TEST_ASSERT_FALSE(parseWifiConfiguration("ssid="+std::string(33,'s')+"&password=examplepass",credentials));
    TEST_ASSERT_TRUE(parseWifiConfiguration("ssid=Example&password="+std::string(64,'a'),credentials));
    TEST_ASSERT_FALSE(parseWifiConfiguration("ssid=Example&password="+std::string(64,'z'),credentials));
}
void testModernImageCrcRequiresLengthAndFullFileIntegrity() {
    Bytes source; source.bytes.resize(0x1020,0);
    TEST_ASSERT_FALSE(validateArduinoImageCrc(source));
    // Independently generated MPEG-2 CRC vector for this zero-filled fixture.
    source.bytes[0x1010] = 0x20; source.bytes[0x1011] = 0x10;
    const std::uint32_t expected = 0x6fa45b5b;
    for (unsigned i=0;i<4;++i) source.bytes[0x1014+i] = expected >> (8*i);
    TEST_ASSERT_TRUE(validateArduinoImageCrc(source));
    source.bytes[100] ^= 1; TEST_ASSERT_FALSE(validateArduinoImageCrc(source));
    source.bytes[100] ^= 1; source.bytes.push_back(0); TEST_ASSERT_FALSE(validateArduinoImageCrc(source));
}
class AtomicBackend : public AtomicFileBackend {
public:
    std::vector<std::uint8_t> installed{9,8,7}, candidate;
    bool shortClose = false, corruptClose = false, readOk = true, renameOk = true;
    bool writeCandidate(const std::uint8_t* data, std::size_t length) override {
        candidate.assign(data,data+length);
        if (shortClose) candidate.pop_back();
        if (corruptClose) candidate.back() ^= 1;
        return true; // Simulates full cached write followed by silent sync failure.
    }
    std::uint32_t size() const override { return candidate.size(); }
    bool readAt(std::uint32_t offset, std::uint8_t* data, std::size_t length) const override {
        if (!readOk || offset > candidate.size() || length > candidate.size()-offset) return false;
        std::copy_n(candidate.data()+offset,length,data); return true;
    }
    bool promoteCandidate() override { if (!renameOk) return false; installed = candidate; return true; }
    void discardCandidate() override { candidate.clear(); }
};
void testSettingsPreservePreviousFileOnSilentCloseAndRenameFailures() {
    const std::uint8_t replacement[] = {1,2,3,4};
    for (unsigned failure=0;failure<4;++failure) {
        AtomicBackend backend;
        backend.shortClose = failure == 0; backend.corruptClose = failure == 1;
        backend.readOk = failure != 2; backend.renameOk = failure != 3;
        TEST_ASSERT_FALSE(replaceAtomicFile(backend,replacement,sizeof(replacement)));
        TEST_ASSERT_EQUAL_UINT32(3,backend.installed.size());
        TEST_ASSERT_EQUAL_UINT8(9,backend.installed[0]);
    }
    AtomicBackend backend;
    TEST_ASSERT_TRUE(replaceAtomicFile(backend,replacement,sizeof(replacement)));
    TEST_ASSERT_EQUAL_UINT8_ARRAY(replacement,backend.installed.data(),sizeof(replacement));
}
class CountingDigest : public ContentDigest {
public:
    std::size_t bytes = 0;
    void reset() override { bytes = 0; }
    void update(const std::uint8_t*, std::size_t size) override { bytes += size; }
    void finish(char* hex64) override { std::fill_n(hex64,64,'a'); }
};
void testHashFinalizationLeavesTimeForEveryRenderAndHandlesReadFailure() {
    Bytes source; source.bytes.resize(10'000,1); CountingDigest digest;
    HashJob job(source,digest,0,source.size()); std::uint8_t chunk[512];
    unsigned renderTicks = 0;
    HashStep state;
    do { state = job.step(chunk,sizeof(chunk)); ++renderTicks; } while (state == HashStep::pending);
    TEST_ASSERT_TRUE(state == HashStep::complete);
    TEST_ASSERT_EQUAL_UINT32(20,renderTicks); TEST_ASSERT_EQUAL_UINT32(10'000,digest.bytes);
    TEST_ASSERT_LESS_OR_EQUAL_UINT32(512,source.largestRead);
    source.failRead = true; HashJob failed(source,digest,0,source.size());
    TEST_ASSERT_TRUE(failed.step(chunk,sizeof(chunk)) == HashStep::failed);
    source.failRead = false;
    TEST_ASSERT_TRUE(failed.step(chunk,sizeof(chunk)) == HashStep::failed);
    HashJob prefix(source,digest,1,source.size());
    TEST_ASSERT_TRUE(prefix.step(chunk,sizeof(chunk)) == HashStep::failed);
}
void testModernPatchedMetadataIsExcludedFromSegmentXor() {
    Bytes source; source.bytes.resize(0x1030,0);
    auto put32 = [&](unsigned offset, std::uint32_t value) {
        for (unsigned i=0;i<4;++i) source.bytes[offset+i] = value >> (i*8);
    };
    for (unsigned offset : {0U,0x1000U}) {
        source.bytes[offset] = 0xe9; source.bytes[offset+1] = 1;
        source.bytes[offset+2] = 2; source.bytes[offset+3] = 0x40;
        put32(offset+4,0x40100000);
        put32(offset+8,offset ? 0x40201010 : 0x40100000);
        put32(offset+12,offset ? 16 : 4);
        source.bytes[offset ? 0x102f : 31] = 0xef;
    }
    put32(0x1010,source.size()); put32(0x1014,0x12345678);
    TEST_ASSERT_TRUE(validateEsp8266Image(source));
    source.bytes[0x1018] = 1; TEST_ASSERT_FALSE(validateEsp8266Image(source));
}
void testCoverTrackHeaderPreservesUtf8AndLiteralPlus() {
    FixedText text;
    TEST_ASSERT_TRUE(decodeTrackId("track%2F%F0%9F%8E%B5+%25",text));
    TEST_ASSERT_TRUE(text.view() == "track/\xf0\x9f\x8e\xb5+%");
    TEST_ASSERT_FALSE(decodeTrackId("%ff",text));
    TEST_ASSERT_FALSE(decodeTrackId("%",text));
    TEST_ASSERT_FALSE(decodeTrackId(std::string(257,'a'),text));
}
void testImageRejectsWrongHeadersBoundsAndChecksums() {
    Bytes source; source.bytes.resize(0x1040, 0xaa);
    auto image = [&](std::size_t offset, std::uint32_t address) {
        auto& b = source.bytes;
        b[offset] = 0xe9; b[offset+1] = 1; b[offset+2] = 2; b[offset+3] = 0x40;
        for (unsigned i=0;i<4;++i) b[offset+4+i] = (address >> (8*i)) & 255;
        for (unsigned i=0;i<4;++i) b[offset+8+i] = (address >> (8*i)) & 255;
        b[offset+12] = 4; b[offset+13]=b[offset+14]=b[offset+15]=0;
        b[offset+16]=1; b[offset+17]=2; b[offset+18]=3; b[offset+19]=4;
        std::fill(b.begin()+offset+20,b.begin()+offset+31,0);
        b[offset+31] = 0xef ^ 1 ^ 2 ^ 3 ^ 4;
    };
    image(0, 0x40100000); image(0x1000, 0x40100000);
    source.bytes.resize(0x1020);
    TEST_ASSERT_TRUE(validateEsp8266Image(source));
    source.bytes.back() ^= 1; TEST_ASSERT_FALSE(validateEsp8266Image(source));
    source.bytes.back() ^= 1; source.bytes[0x1003] = 0x20;
    TEST_ASSERT_FALSE(validateEsp8266Image(source));
    source.bytes[0x1003] = 0x40; source.bytes[0x100c] = 0xff;
    TEST_ASSERT_FALSE(validateEsp8266Image(source));
    source.bytes.resize(0x1000); TEST_ASSERT_FALSE(validateEsp8266Image(source));
}
}
void setUp() {}
void tearDown() {}
int main(int, char**) {
    UNITY_BEGIN();
    RUN_TEST(testTransferRequiresExactLengthHashAndValidatedContent);
    RUN_TEST(testTransferRejectsOverflowBadHeadersAndStorageFailures);
    RUN_TEST(testStrictHttpFraming);
    RUN_TEST(testWifiConfigurationRejectsMalformedCredentials);
    RUN_TEST(testModernImageCrcRequiresLengthAndFullFileIntegrity);
    RUN_TEST(testSettingsPreservePreviousFileOnSilentCloseAndRenameFailures);
    RUN_TEST(testHashFinalizationLeavesTimeForEveryRenderAndHandlesReadFailure);
    RUN_TEST(testModernPatchedMetadataIsExcludedFromSegmentXor);
    RUN_TEST(testCoverTrackHeaderPreservesUtf8AndLiteralPlus);
    RUN_TEST(testImageRejectsWrongHeadersBoundsAndChecksums);
    return UNITY_END();
}
