#include <unity.h>
#include "neonbyte/transfer.h"
#include "neonbyte/atomic_file.h"
#include "neonbyte/hash_job.h"
#include "neonbyte/wifi_configuration.h"
#include "neonbyte/http_headers.h"
#include "neonbyte/firmware_image.h"
#include "neonbyte/ota_staging.h"
#include "neonbyte/safe_startup.h"
#include <algorithm>
#include <array>
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
    for (const auto& extra : std::vector<std::string>{"Content-Length: 1\r\nContent-Length: 1", "Content-Length: -1", "Content-Length: 4294967296", "Transfer-Encoding: chunked", "Content-Length: 1\r\nTransfer-Encoding: chunked", "Expect: 100-continue", "Content-Length: 1\r\n Authorization: hidden", "Content-Length: 1x", "Content-Length: 1\r\nAuthorization: a\r\nAuthorization: b", "Content-Length: 1\r\nX-Content-SHA256: "+HASH+"\r\nX-Content-SHA256: "+HASH}) {
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
class FixtureDigest : public ContentDigest {
public:
    explicit FixtureDigest(const std::vector<std::uint8_t>& expected) : expected_(expected) {}
    void reset() override { offset_ = 0; matches_ = true; }
    void update(const std::uint8_t* bytes, std::size_t length) override {
        if (offset_ > expected_.size() || length > expected_.size()-offset_ ||
            !std::equal(bytes,bytes+length,expected_.begin()+offset_)) matches_ = false;
        offset_ += length;
    }
    void finish(char* hex64) override { std::fill_n(hex64,64,matches_ && offset_ == expected_.size() ? 'a' : 'b'); }
private:
    const std::vector<std::uint8_t>& expected_;
    std::size_t offset_ = 0;
    bool matches_ = true;
};
using FakeRtcMemory = std::array<std::uint8_t,128>;
class FakeOtaBackend : public OtaFlashBackend {
public:
    static constexpr std::uint32_t CONFIGURATION_SENTINEL_OFFSET = 0x100100;
    static constexpr std::uint32_t EEPROM_SENTINEL_OFFSET = 0x3fb000;
    static constexpr std::uint32_t RF_SENTINEL_OFFSET = OTA_FLASH_BYTES-2*OTA_SECTOR_BYTES;
    static constexpr std::uint32_t FLASH_TAIL_SENTINEL_OFFSET = OTA_FLASH_BYTES-1;
    static constexpr std::uint8_t EBOOT_COMMAND_MARKER[4] = {'E','B','O','T'};
    OtaGeometry flashGeometry{true,4*1024*1024,0x40000,0xc0000,0x100000,0x3fa000,0x3fb000,2};
    OtaStageBounds bounds{};
    std::vector<std::uint8_t> flash;
    int failWriteOffset = -1, failReadOffset = -1;
    bool failBegin = false, failFinalize = false;
    std::uint32_t geometryReads = 0, begins = 0, writes = 0, reads = 0, finalizers = 0, cleanups = 0;
    std::uint32_t bootCopyCommands = 0;
    bool active = false, verifiedBeforeBootCopy = false;
    FakeRtcMemory ownedRtcMemory{};
    FakeRtcMemory* rtcMemory = &ownedRtcMemory;
    FakeRtcMemory initialRtcMemory{};
    std::vector<std::pair<std::uint32_t,std::uint32_t>> erasedRanges, programmedRanges;

    FakeOtaBackend() : flash(OTA_FLASH_BYTES,0x5a) { initializeSentinels(); }
    explicit FakeOtaBackend(FakeRtcMemory& sharedRtc) : FakeOtaBackend() {
        rtcMemory = &sharedRtc;
        initialRtcMemory = sharedRtc;
    }

    void initializeSentinels() {
        flash[0x3ffff] = 0x11;
        flash[CONFIGURATION_SENTINEL_OFFSET] = 0x22;
        flash[EEPROM_SENTINEL_OFFSET] = 0x33;
        flash[RF_SENTINEL_OFFSET] = 0x44;
        flash[FLASH_TAIL_SENTINEL_OFFSET] = 0x55;
        ownedRtcMemory.fill(0xa5);
        initialRtcMemory = ownedRtcMemory;
    }

    bool geometry(OtaGeometry& value) override { ++geometryReads; value = flashGeometry; return true; }
    bool begin(std::uint32_t length, const OtaStageBounds& stageBounds) override {
        ++begins;
        if (failBegin || active || stageBounds.length != length ||
            stageBounds.start % OTA_SECTOR_BYTES || stageBounds.roundedLength % OTA_SECTOR_BYTES ||
            stageBounds.start > flash.size() || stageBounds.roundedLength > flash.size()-stageBounds.start ||
            stageBounds.roundedLength < length || stageBounds.start+stageBounds.roundedLength > stageBounds.end) return false;
        bounds = stageBounds;
        const auto end = stageBounds.start+stageBounds.roundedLength;
        std::fill(flash.begin()+stageBounds.start,flash.begin()+end,0xff);
        erasedRanges.emplace_back(stageBounds.start,end);
        remaining_ = length; active = true; return true;
    }
    bool write(const std::uint8_t* bytes, std::size_t length) override {
        ++writes;
        const auto offset = bounds.length - remaining_;
        if (!active || length > remaining_ || (failWriteOffset >= 0 && std::size_t(failWriteOffset) >= offset && std::size_t(failWriteOffset) < offset+length)) return false;
        const auto address = bounds.start+offset;
        std::copy_n(bytes,length,flash.data()+address);
        programmedRanges.emplace_back(address,address+length);
        remaining_ -= length; return true;
    }
    bool readAt(std::uint32_t offset, std::uint8_t* destination, std::size_t length) override {
        ++reads;
        if (!active || offset > bounds.length || length > bounds.length-offset ||
            (failReadOffset >= 0 && std::size_t(failReadOffset) >= offset && std::size_t(failReadOffset) < offset+length)) return false;
        std::copy_n(flash.data()+bounds.start+offset,length,destination); return true;
    }
    bool finalize(OtaCandidateVerifier& verifier) override {
        ++finalizers;
        const bool verified = active && remaining_ == 0 && verifier.verifyForActivation();
        const bool accepted = verified && !failFinalize;
        if (accepted) {
            verifiedBeforeBootCopy = reads > 0;
            writeEbootCommand();
        }
        active = false; remaining_ = 0; return accepted;
    }
    void abort(OtaCandidateVerifier& verifier) override {
        ++cleanups;
        // A complete updater end(false) invokes its verifier; model that hazard.
        if (active && remaining_ == 0 && verifier.verifyForActivation()) writeEbootCommand();
        active = false; remaining_ = 0;
    }
    bool ebootCommandPresent() const {
        return std::equal(std::begin(EBOOT_COMMAND_MARKER),std::end(EBOOT_COMMAND_MARKER),rtcMemory->begin());
    }
    bool rtcMemoryUnchanged() const { return *rtcMemory == initialRtcMemory; }
    bool reservedFlashUnchanged() const {
        return flash[0x3ffff] == 0x11 && flash[CONFIGURATION_SENTINEL_OFFSET] == 0x22 &&
            flash[EEPROM_SENTINEL_OFFSET] == 0x33 && flash[RF_SENTINEL_OFFSET] == 0x44 &&
            flash[FLASH_TAIL_SENTINEL_OFFSET] == 0x55;
    }
    void writeEbootCommand() {
        rtcMemory->fill(0xc3);
        std::copy(std::begin(EBOOT_COMMAND_MARKER),std::end(EBOOT_COMMAND_MARKER),rtcMemory->begin());
        ++bootCopyCommands;
    }
private:
    std::size_t remaining_ = 0;
};
class FakeUploadStorage {
public:
    enum class LittleFsCondition { unavailable, corrupt, full, available };
    LittleFsCondition condition = LittleFsCondition::unavailable;
    std::uint32_t selectionCalls = 0, assetRevision = 7;
    bool selectAsset() {
        ++selectionCalls;
        if (condition != LittleFsCondition::available) return false;
        ++assetRevision;
        return true;
    }
};
class FakeStartupServices final : public StartupServices {
public:
    explicit FakeStartupServices(FakeRtcMemory& rtc) : rtc_(rtc) {}
    std::uint32_t guardWrites = 0, storageMounts = 0, applicationStarts = 0, applicationStops = 0;
    bool startRecoveryAp(RecoveryIdentity) override { return true; }
    bool startHttp() override { return true; }
    bool mountStorage() override { ++storageMounts; return true; }
    bool loadWifi(WifiCredentials& credentials) override {
        strcpy(credentials.ssid,"Test network"); strcpy(credentials.password,"test-password"); return true;
    }
    bool saveWifi(const WifiCredentials&) override { return true; }
    void connectStation(const WifiCredentials&) override {}
    bool stationConnected(const WifiCredentials&) const override { return false; }
    bool setStartupGuard(bool risky) override {
        const std::uint32_t guard[3] = {0x4e425347,risky ? 1U : 0U,risky ? ~1U : ~0U};
        std::memcpy(rtc_.data(),guard,sizeof(guard)); ++guardWrites; return true;
    }
    bool startApplication() override { ++applicationStarts; return true; }
    void stopApplication() override { ++applicationStops; }
private:
    FakeRtcMemory& rtc_;
};
void assertNoOtaFailureMutation(const FakeOtaBackend& backend, const MaintenanceOtaTransaction& transaction) {
    TEST_ASSERT_EQUAL_UINT32(0,backend.bootCopyCommands);
    TEST_ASSERT_FALSE(maintenanceOtaRestartAllowed(transaction.state()));
    TEST_ASSERT_TRUE(backend.reservedFlashUnchanged());
    TEST_ASSERT_TRUE(backend.rtcMemoryUnchanged());
    TEST_ASSERT_FALSE(backend.ebootCommandPresent());
}
std::vector<std::uint8_t> validMaintenanceImage() {
    std::vector<std::uint8_t> image(0x1030,0);
    auto put32 = [&](unsigned offset, std::uint32_t value) {
        for (unsigned i=0;i<4;++i) image[offset+i] = value >> (i*8);
    };
    for (unsigned offset : {0U,0x1000U}) {
        image[offset] = 0xe9; image[offset+1] = 1; image[offset+2] = 2; image[offset+3] = 0x40;
        put32(offset+4,0x40100000);
    }
    put32(8,0x40100000); put32(12,4);
    image[16] = 1; image[17] = 2; image[18] = 3; image[19] = 4; image[31] = 0xeb;
    put32(0x1008,0x40201010); put32(0x100c,16); image[0x102f] = 0xef;
    put32(0x1010,0x1030); put32(0x1014,0x34fe8c4c);
    return image;
}
bool streamMaintenanceImage(MaintenanceOtaTransaction& transaction, ContentDigest& digest, const std::vector<std::uint8_t>& image,
                            std::string_view requestHash = HASH, std::size_t chunkSize = 512) {
    FakeUploadStorage storage;
    Sink storageSink;
    Transfer storageTransfer(storageSink), maintenanceTransfer(transaction);
    if (!prepareUploadStorage("/maintenance/v1/firmware",[&] { return storage.selectAsset(); }) || storage.selectionCalls ||
        &selectUploadTransfer("/maintenance/v1/firmware",storageTransfer,maintenanceTransfer) != &maintenanceTransfer) return false;
    if (!transaction.setExpectedHash(requestHash)) return false;
    if (!maintenanceTransfer.begin(image.size(),FIRMWARE_BYTES_LIMIT,requestHash)) return false;
    for (std::size_t offset=0;offset<image.size();) {
        const auto count = std::min(chunkSize,image.size()-offset);
        if (!maintenanceTransfer.append(image.data()+offset,count)) return false;
        offset += count;
    }
    HashJob job(transaction,digest,0,image.size());
    std::array<std::uint8_t,256> buffer{};
    auto result = HashStep::pending;
    while (result == HashStep::pending) result = job.step(buffer.data(),buffer.size());
    if (result != HashStep::complete) { maintenanceTransfer.abort(); return false; }
    std::array<char,64> actualHash{};
    digest.finish(actualHash.data());
    return maintenanceTransfer.finish({actualHash.data(),actualHash.size()},true);
}
void testMaintenanceUploadAndDelayedStartupCannotOverwriteEbootCommand() {
    const auto image = validMaintenanceImage();
    FakeRtcMemory rtc{}; rtc.fill(0xa5);
    FakeStartupServices services(rtc);
    TEST_ASSERT_TRUE(services.setStartupGuard(false));
    SafeStartup startup(services,{"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
                                  "fedcba9876543210fedcba9876543210"});
    const std::string authorization = "Bearer 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    startup.begin(0,false);
    TEST_ASSERT_FALSE(startup.applicationRunning());
    TEST_ASSERT_FALSE(startup.applicationPaused());
    TEST_ASSERT_EQUAL(OtaAdmissionError::applicationRunning,
        maintenanceOtaAdmission(startup.authorized(authorization),startup.applicationPaused(),true,
            HttpMethod::put,"application/octet-stream",image.size(),HASH));

    TEST_ASSERT_EQUAL(StartupResult::ok,startup.pauseApplication(authorization));
    TEST_ASSERT_TRUE(startup.applicationPaused());
    TEST_ASSERT_EQUAL(OtaAdmissionError::none,
        maintenanceOtaAdmission(startup.authorized(authorization),startup.applicationPaused(),true,
            HttpMethod::put,"application/octet-stream",image.size(),HASH));

    FakeOtaBackend backend(rtc); FixtureDigest digest(image); MaintenanceOtaTransaction transaction(backend,digest);
    TEST_ASSERT_TRUE(streamMaintenanceImage(transaction,digest,image));
    TEST_ASSERT_TRUE(backend.ebootCommandPresent());
    const auto guardWritesAtActivation = services.guardWrites;
    startup.tick(10000);
    TEST_ASSERT_EQUAL_UINT32(guardWritesAtActivation,services.guardWrites);
    TEST_ASSERT_EQUAL_UINT32(0,services.storageMounts);
    TEST_ASSERT_EQUAL_UINT32(0,services.applicationStarts);
    TEST_ASSERT_TRUE(backend.ebootCommandPresent());
    TEST_ASSERT_TRUE(backend.reservedFlashUnchanged());

    auto invalidImage = image;
    invalidImage[0x1014] ^= 1;
    FakeRtcMemory failedRtc{}; failedRtc.fill(0xa5);
    FakeStartupServices failedServices(failedRtc);
    TEST_ASSERT_TRUE(failedServices.setStartupGuard(false));
    const auto safeGuard = failedRtc;
    SafeStartup failedStartup(failedServices,{"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
                                               "fedcba9876543210fedcba9876543210"});
    failedStartup.begin(0,true);
    FakeOtaBackend failedBackend(failedRtc); FixtureDigest invalidDigest(invalidImage);
    MaintenanceOtaTransaction failedTransaction(failedBackend,invalidDigest);
    TEST_ASSERT_FALSE(streamMaintenanceImage(failedTransaction,invalidDigest,invalidImage));
    TEST_ASSERT_FALSE(failedBackend.ebootCommandPresent());
    TEST_ASSERT_TRUE(failedBackend.rtcMemoryUnchanged());
    TEST_ASSERT_TRUE(failedRtc == safeGuard);
    failedStartup.tick(10000);
    TEST_ASSERT_EQUAL_UINT32(1,failedServices.guardWrites);
    TEST_ASSERT_EQUAL_UINT32(0,failedServices.storageMounts);
}
void testMaintenanceOtaGeometryAndRequestGatesFailClosed() {
    OtaStageBounds bounds{};
    OtaGeometry geometry{true,4*1024*1024,0x40000,0xc0000,0x100000,0x3fa000,0x3fb000,2};
    TEST_ASSERT_TRUE(calculateOtaStageBounds(0x1030,geometry,bounds));
    TEST_ASSERT_EQUAL_UINT32(0xfe000,bounds.start);
    TEST_ASSERT_EQUAL_UINT32(0x100000,bounds.end);
    geometry.filesystemStartOffset = 0x100000-4096;
    TEST_ASSERT_FALSE(calculateOtaStageBounds(0x1030,geometry,bounds));
    geometry = {true,4*1024*1024,0x40000,0x2000,0x100000,0x3fa000,0x3fb000,2};
    TEST_ASSERT_FALSE(calculateOtaStageBounds(0x1030,geometry,bounds));
    geometry = {false,4*1024*1024,0x40000,0xc0000,0x100000,0x3fa000,0x3fb000,2};
    TEST_ASSERT_FALSE(calculateOtaStageBounds(0x1030,geometry,bounds));
    geometry = {true,4*1024*1024,0x40000,0xc0000,0x100000,0x3fa000,0x3fc000,2};
    TEST_ASSERT_FALSE(calculateOtaStageBounds(0x1030,geometry,bounds));
    geometry = {true,8*1024*1024,0x40000,0xc0000,0x100000,0x3fa000,0x3fb000,2};
    TEST_ASSERT_FALSE(calculateOtaStageBounds(0x1030,geometry,bounds));

    TEST_ASSERT_TRUE(maintenanceOtaAdmission(false,true,true,HttpMethod::put,"application/octet-stream",0x1030,HASH) == OtaAdmissionError::unauthorized);
    TEST_ASSERT_TRUE(maintenanceOtaAdmission(true,false,true,HttpMethod::put,"application/octet-stream",0x1030,HASH) == OtaAdmissionError::applicationRunning);
    TEST_ASSERT_TRUE(maintenanceOtaAdmission(true,true,false,HttpMethod::put,"application/octet-stream",0x1030,HASH) == OtaAdmissionError::disabled);
    TEST_ASSERT_TRUE(maintenanceOtaAdmission(true,true,true,HttpMethod::post,"application/octet-stream",0x1030,HASH) == OtaAdmissionError::method);
    TEST_ASSERT_TRUE(maintenanceOtaAdmission(true,true,true,HttpMethod::put,"application/json",0x1030,HASH) == OtaAdmissionError::mediaType);
    TEST_ASSERT_TRUE(maintenanceOtaAdmission(true,true,true,HttpMethod::put,"application/octet-stream",FIRMWARE_BYTES_LIMIT+1,HASH) == OtaAdmissionError::tooLarge);
    TEST_ASSERT_TRUE(maintenanceOtaAdmission(true,true,true,HttpMethod::put,"application/octet-stream",0,HASH) == OtaAdmissionError::invalidBody);
    TEST_ASSERT_TRUE(maintenanceOtaAdmission(true,true,true,HttpMethod::put,"application/octet-stream",0x1030,std::string(64,'A')) == OtaAdmissionError::invalidBody);
    TEST_ASSERT_TRUE(maintenanceOtaAdmission(true,true,true,HttpMethod::put,"application/octet-stream",0x1030,HASH) == OtaAdmissionError::none);
    TEST_ASSERT_TRUE(isMaintenanceFirmwarePath("/maintenance/v1/firmware"));
    TEST_ASSERT_FALSE(isMaintenanceFirmwarePath("/api/v1/firmware"));
    {
        FakeUploadStorage storage; storage.condition = FakeUploadStorage::LittleFsCondition::available;
        Sink storageSink, rawSink; Transfer storageTransfer(storageSink), rawTransfer(rawSink);
        TEST_ASSERT_TRUE(prepareUploadStorage("/api/v1/firmware",[&] { return storage.selectAsset(); }));
        TEST_ASSERT_EQUAL_UINT32(1,storage.selectionCalls);
        TEST_ASSERT_EQUAL_UINT32(8,storage.assetRevision);
        TEST_ASSERT_TRUE(&selectUploadTransfer("/api/v1/firmware",storageTransfer,rawTransfer) == &storageTransfer);
    }
    TEST_ASSERT_FALSE(maintenanceOtaBodyHasNoExtraBytes(0x1030,0x1030,1));
    TEST_ASSERT_FALSE(maintenanceOtaBodyHasNoExtraBytes(0x102f,0x1030,0));
    TEST_ASSERT_TRUE(maintenanceOtaBodyHasNoExtraBytes(0x1030,0x1030,0));
    TEST_ASSERT_FALSE(maintenanceOtaRestartAllowed(OtaTransactionState::receiving));
    TEST_ASSERT_FALSE(maintenanceOtaRestartAllowed(OtaTransactionState::failedInactive));
    TEST_ASSERT_TRUE(maintenanceOtaRestartAllowed(OtaTransactionState::activated));
}
void testMaintenanceOtaStagesOnlyAfterHeaderAndActivatesAfterCheckedReadback() {
    auto image = validMaintenanceImage();
    Bytes source; source.bytes = image;
    TEST_ASSERT_TRUE(validateEsp8266Image(source)); TEST_ASSERT_TRUE(validateArduinoImageCrc(source));
    FakeOtaBackend backend; FixtureDigest digest(image);
    MaintenanceOtaTransaction transaction(backend,digest);
    TEST_ASSERT_TRUE(transaction.setExpectedHash(HASH));
    TEST_ASSERT_TRUE(transaction.begin(image.size()));
    TEST_ASSERT_EQUAL_UINT32(0,backend.begins);
    TEST_ASSERT_TRUE(transaction.write(image.data(),3));
    TEST_ASSERT_EQUAL_UINT32(0,backend.begins);
    TEST_ASSERT_TRUE(transaction.write(image.data()+3,1));
    TEST_ASSERT_EQUAL_UINT32(1,backend.begins);
    TEST_ASSERT_TRUE(transaction.write(image.data()+4,image.size()-4));
    TEST_ASSERT_EQUAL_UINT32(image.size(),transaction.received());
    TEST_ASSERT_TRUE(transaction.commit());
    TEST_ASSERT_TRUE(transaction.state() == OtaTransactionState::activated);
    TEST_ASSERT_EQUAL_UINT32(1,backend.bootCopyCommands);
    TEST_ASSERT_EQUAL_UINT32(1,backend.finalizers);
    TEST_ASSERT_EQUAL_UINT32(0xfe000,backend.bounds.start);
    TEST_ASSERT_EQUAL_UINT32(0x100000,backend.bounds.end);
    TEST_ASSERT_TRUE(backend.verifiedBeforeBootCopy);
    TEST_ASSERT_EQUAL_UINT32(1,backend.erasedRanges.size());
    TEST_ASSERT_EQUAL_UINT32(0xfe000,backend.erasedRanges[0].first);
    TEST_ASSERT_EQUAL_UINT32(0x100000,backend.erasedRanges[0].second);
    TEST_ASSERT_TRUE(backend.reservedFlashUnchanged());
    TEST_ASSERT_TRUE(backend.ebootCommandPresent());
    TEST_ASSERT_TRUE(maintenanceOtaRestartAllowed(transaction.state()));
    TEST_ASSERT_TRUE(backend.reads > 0);
}
void testMaintenanceOtaDoesNotDependOnLittleFsAndPreservesOtherRegions() {
    const auto image = validMaintenanceImage();
    for (const auto condition : {FakeUploadStorage::LittleFsCondition::unavailable,
                                 FakeUploadStorage::LittleFsCondition::corrupt,
                                 FakeUploadStorage::LittleFsCondition::full}) {
        FakeUploadStorage storage; storage.condition = condition;
        bool storageSelectionInvoked = false;
        TEST_ASSERT_TRUE(prepareUploadStorage("/maintenance/v1/firmware",[&] { storageSelectionInvoked = true; return storage.selectAsset(); }));
        TEST_ASSERT_FALSE(storageSelectionInvoked);
        TEST_ASSERT_EQUAL_UINT32(0,storage.selectionCalls);
        TEST_ASSERT_EQUAL_UINT32(7,storage.assetRevision);
        FakeOtaBackend backend;
        FixtureDigest digest(image); MaintenanceOtaTransaction transaction(backend,digest);
        TEST_ASSERT_TRUE(streamMaintenanceImage(transaction,digest,image));
        TEST_ASSERT_TRUE(backend.reservedFlashUnchanged());
        TEST_ASSERT_TRUE(backend.ebootCommandPresent());
        TEST_ASSERT_EQUAL_UINT32(1,backend.bootCopyCommands);
    }
}
void testMaintenanceOtaRejectsIncompleteExtraAndCompleteInvalidCandidates() {
    const auto image = validMaintenanceImage();
    {
        FakeOtaBackend backend; FixtureDigest digest(image); MaintenanceOtaTransaction transaction(backend,digest);
        TEST_ASSERT_TRUE(transaction.setExpectedHash(HASH));
        TEST_ASSERT_TRUE(transaction.begin(image.size())); TEST_ASSERT_TRUE(transaction.write(image.data(),4));
        TEST_ASSERT_TRUE(transaction.write(image.data()+4,128)); transaction.abort();
        TEST_ASSERT_EQUAL_UINT32(0,backend.bootCopyCommands); TEST_ASSERT_EQUAL_UINT32(1,backend.cleanups);
        assertNoOtaFailureMutation(backend,transaction);
    }
    {
        FakeOtaBackend backend; FixtureDigest digest(image); MaintenanceOtaTransaction transaction(backend,digest);
        TEST_ASSERT_TRUE(transaction.setExpectedHash(HASH));
        Transfer transfer(transaction); const std::uint8_t extra = 0;
        TEST_ASSERT_TRUE(transfer.begin(image.size(),FIRMWARE_BYTES_LIMIT,HASH));
        TEST_ASSERT_TRUE(transfer.append(image.data(),image.size()));
        TEST_ASSERT_FALSE(transfer.append(&extra,1));
        TEST_ASSERT_EQUAL_UINT32(0,backend.bootCopyCommands); TEST_ASSERT_EQUAL_UINT32(1,backend.cleanups);
        assertNoOtaFailureMutation(backend,transaction);
    }
    {
        FakeOtaBackend backend; FixtureDigest digest(image); MaintenanceOtaTransaction transaction(backend,digest);
        TEST_ASSERT_FALSE(streamMaintenanceImage(transaction,digest,image,std::string(64,'b')));
        TEST_ASSERT_EQUAL_UINT32(0,backend.finalizers); TEST_ASSERT_EQUAL_UINT32(0,backend.bootCopyCommands);
        assertNoOtaFailureMutation(backend,transaction);
    }
    for (const auto mutation : {0U,1U,2U,3U,4U,8U,12U,16U,31U,0x1000U,0x1001U,0x1002U,0x1003U,0x1004U,0x1008U,0x100cU,0x1010U,0x1014U,0x1020U,0x102fU}) {
        auto invalid = image; invalid[mutation] ^= 1;
        if (mutation == 4 || mutation == 8 || mutation == 0x1004 || mutation == 0x1008) {
            const auto valueOffset = mutation == 4 ? 4U : mutation == 8 ? 8U : mutation;
            for (unsigned i=0;i<4;++i) invalid[valueOffset+i] = (0x50000000U >> (i*8));
        }
        if (mutation == 12 || mutation == 0x100c) {
            for (unsigned i=0;i<4;++i) invalid[mutation+i] = 0xff;
        }
        FakeOtaBackend backend; FixtureDigest digest(invalid); MaintenanceOtaTransaction transaction(backend,digest);
        TEST_ASSERT_FALSE(streamMaintenanceImage(transaction,digest,invalid));
        TEST_ASSERT_EQUAL_UINT32(0,backend.bootCopyCommands);
        assertNoOtaFailureMutation(backend,transaction);
        if (mutation == 0 || mutation == 2 || mutation == 3) TEST_ASSERT_EQUAL_UINT32(0,backend.begins);
        else TEST_ASSERT_EQUAL_UINT32(1,backend.finalizers);
    }
    auto tooManySegments = image; tooManySegments[1] = 17;
    FakeOtaBackend segmentsBackend; FixtureDigest segmentsDigest(tooManySegments); MaintenanceOtaTransaction segmentsTransaction(segmentsBackend,segmentsDigest);
    TEST_ASSERT_FALSE(streamMaintenanceImage(segmentsTransaction,segmentsDigest,tooManySegments));
    TEST_ASSERT_EQUAL_UINT32(0,segmentsBackend.bootCopyCommands);
    TEST_ASSERT_EQUAL_UINT32(1,segmentsBackend.finalizers);
    assertNoOtaFailureMutation(segmentsBackend,segmentsTransaction);
    auto trailing = image; trailing.push_back(0);
    FakeOtaBackend trailingBackend; FixtureDigest trailingDigest(trailing); MaintenanceOtaTransaction trailingTransaction(trailingBackend,trailingDigest);
    TEST_ASSERT_FALSE(streamMaintenanceImage(trailingTransaction,trailingDigest,trailing));
    TEST_ASSERT_EQUAL_UINT32(0,trailingBackend.bootCopyCommands);
    TEST_ASSERT_EQUAL_UINT32(1,trailingBackend.finalizers);
    assertNoOtaFailureMutation(trailingBackend,trailingTransaction);
}
void testMaintenanceOtaRejectsGeometryWriteAndReadFaultsWithoutMutation() {
    const auto image = validMaintenanceImage();
    {
        FakeOtaBackend backend; backend.flashGeometry.freeSketchBytes = 0x2000;
        FixtureDigest digest(image); MaintenanceOtaTransaction transaction(backend,digest);
        TEST_ASSERT_TRUE(transaction.setExpectedHash(HASH));
        TEST_ASSERT_FALSE(transaction.begin(image.size())); TEST_ASSERT_EQUAL_UINT32(0,backend.begins);
        assertNoOtaFailureMutation(backend,transaction);
    }
    {
        FakeOtaBackend backend; backend.failBegin = true;
        FixtureDigest digest(image); MaintenanceOtaTransaction transaction(backend,digest);
        TEST_ASSERT_TRUE(transaction.setExpectedHash(HASH));
        TEST_ASSERT_TRUE(transaction.begin(image.size())); TEST_ASSERT_FALSE(transaction.write(image.data(),4));
        TEST_ASSERT_EQUAL_UINT32(1,backend.begins);
        TEST_ASSERT_EQUAL_UINT32(0,backend.bootCopyCommands);
        assertNoOtaFailureMutation(backend,transaction);
    }
    for (const auto offset : {0,0x800,int(image.size()-1)}) {
        FakeOtaBackend backend; backend.failWriteOffset = offset;
        FixtureDigest digest(image); MaintenanceOtaTransaction transaction(backend,digest);
        TEST_ASSERT_FALSE(streamMaintenanceImage(transaction,digest,image,HASH,512));
        TEST_ASSERT_EQUAL_UINT32(0,backend.bootCopyCommands);
        if (offset == 0) TEST_ASSERT_EQUAL_UINT32(1,backend.writes);
        if (offset == 0x800) TEST_ASSERT_EQUAL_UINT32(6,backend.writes);
        if (offset == int(image.size()-1)) TEST_ASSERT_EQUAL_UINT32(10,backend.writes);
        assertNoOtaFailureMutation(backend,transaction);
    }
    for (const auto offset : {0,0x800,int(image.size()-1)}) {
        FakeOtaBackend backend; backend.failReadOffset = offset;
        FixtureDigest digest(image); MaintenanceOtaTransaction transaction(backend,digest);
        TEST_ASSERT_TRUE(transaction.setExpectedHash(HASH));
        TEST_ASSERT_TRUE(transaction.begin(image.size())); TEST_ASSERT_TRUE(transaction.write(image.data(),image.size()));
        TEST_ASSERT_FALSE(transaction.commit());
        TEST_ASSERT_EQUAL_UINT32(0,backend.bootCopyCommands);
        TEST_ASSERT_EQUAL_UINT32(1,backend.finalizers);
        assertNoOtaFailureMutation(backend,transaction);
    }
    {
        FakeOtaBackend backend; FixtureDigest digest(image); MaintenanceOtaTransaction transaction(backend,digest);
        TEST_ASSERT_TRUE(transaction.setExpectedHash(HASH));
        TEST_ASSERT_TRUE(transaction.begin(image.size())); TEST_ASSERT_TRUE(transaction.write(image.data(),image.size()));
        backend.flash[backend.bounds.start+0x800] ^= 1;
        TEST_ASSERT_FALSE(transaction.commit());
        TEST_ASSERT_EQUAL_UINT32(0,backend.bootCopyCommands);
        TEST_ASSERT_EQUAL_UINT32(1,backend.finalizers);
        assertNoOtaFailureMutation(backend,transaction);
    }
    {
        FakeOtaBackend backend; backend.failFinalize = true;
        FixtureDigest digest(image); MaintenanceOtaTransaction transaction(backend,digest);
        TEST_ASSERT_FALSE(streamMaintenanceImage(transaction,digest,image));
        TEST_ASSERT_TRUE(transaction.state() == OtaTransactionState::failedInactive);
        TEST_ASSERT_EQUAL_UINT32(0,backend.bootCopyCommands);
        assertNoOtaFailureMutation(backend,transaction);
    }
}
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
    RUN_TEST(testMaintenanceOtaGeometryAndRequestGatesFailClosed);
    RUN_TEST(testMaintenanceUploadAndDelayedStartupCannotOverwriteEbootCommand);
    RUN_TEST(testMaintenanceOtaStagesOnlyAfterHeaderAndActivatesAfterCheckedReadback);
    RUN_TEST(testMaintenanceOtaDoesNotDependOnLittleFsAndPreservesOtherRegions);
    RUN_TEST(testMaintenanceOtaRejectsIncompleteExtraAndCompleteInvalidCandidates);
    RUN_TEST(testMaintenanceOtaRejectsGeometryWriteAndReadFaultsWithoutMutation);
    return UNITY_END();
}
