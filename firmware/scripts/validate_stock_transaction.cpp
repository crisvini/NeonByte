// Host-only real-SHA transaction probe. It never executes firmware or opens a device.
#include "neonbyte/stock_restore.h"
#include <openssl/evp.h>
#include <algorithm>
#include <array>
#include <cassert>
#include <fstream>
#include <iostream>
#include <iterator>
#include <vector>

using namespace neonbyte;
class HostDigest final : public ContentDigest {
public:
    HostDigest() : context_(EVP_MD_CTX_new()) { assert(context_); }
    ~HostDigest() override { EVP_MD_CTX_free(context_); }
    void reset() override { assert(EVP_DigestInit_ex(context_,EVP_sha256(),nullptr) == 1); }
    void update(const std::uint8_t* bytes, std::size_t length) override { assert(EVP_DigestUpdate(context_,bytes,length) == 1); }
    void finish(char* hex64) override {
        unsigned length = 0; std::uint8_t bytes[32];
        assert(EVP_DigestFinal_ex(context_,bytes,&length) == 1 && length == 32);
        constexpr char HEX[] = "0123456789abcdef";
        for (unsigned i=0;i<32;++i) { hex64[2*i] = HEX[bytes[i]>>4]; hex64[2*i+1] = HEX[bytes[i]&15]; }
    }
private:
    EVP_MD_CTX* context_;
};
class HostFlash final : public OtaFlashBackend {
public:
    std::vector<std::uint8_t> flash = std::vector<std::uint8_t>(OTA_FLASH_BYTES,0x5a);
    OtaGeometry layout{true,OTA_FLASH_BYTES,362960,0xa7000,0x100000,0x3fa000,0x3fb000,2};
    OtaStageBounds bounds{};
    std::uint32_t written = 0, commands = 0;
    bool active = false;
    bool geometry(OtaGeometry& value) override { value = layout; return true; }
    bool begin(std::uint32_t length, const OtaStageBounds& value) override {
        if (active || value.length != length || value.end > flash.size() || value.start+value.roundedLength != value.end) return false;
        bounds = value; written = 0; active = true;
        std::fill(flash.begin()+bounds.start,flash.begin()+bounds.end,0xff); return true;
    }
    bool write(const std::uint8_t* bytes, std::size_t length) override {
        if (!active || length > bounds.length-written) return false;
        std::copy_n(bytes,length,flash.data()+bounds.start+written); written += length; return true;
    }
    bool readAt(std::uint32_t offset, std::uint8_t* out, std::size_t length) override {
        if (!active || offset > bounds.length || length > bounds.length-offset) return false;
        std::copy_n(flash.data()+bounds.start+offset,length,out); return true;
    }
    bool finalize(OtaCandidateVerifier& verifier) override {
        const bool accepted = active && written == bounds.length && verifier.verifyForActivation();
        if (accepted) ++commands;
        active = false; return accepted;
    }
    void abort(OtaCandidateVerifier& verifier) override {
        if (active && written == bounds.length && verifier.verifyForActivation()) ++commands;
        active = false;
    }
    bool reservedBytesPreserved() const {
        return std::all_of(flash.begin(),flash.begin()+bounds.start,[](auto byte) { return byte == 0x5a; }) &&
            std::all_of(flash.begin()+bounds.end,flash.end(),[](auto byte) { return byte == 0x5a; });
    }
};
int main(int argc, char** argv) {
    if (argc != 2) return 2;
    std::ifstream file(argv[1],std::ios::binary);
    const std::vector<std::uint8_t> bytes{std::istreambuf_iterator<char>(file),{}};
    if (bytes.size() != STOCK_V106_BYTES) return 2;
    HostDigest fingerprint;
    fingerprint.reset(); fingerprint.update(bytes.data(),bytes.size());
    std::array<char,64> hash{}; fingerprint.finish(hash.data());
    assert(std::string_view(hash.data(),hash.size()) == STOCK_V106_SHA256);
    for (unsigned fault=0;fault<4;++fault) {
        HostFlash backend; HostDigest digest;
        MaintenanceOtaTransaction transaction(backend,digest,MaintenanceImageKind::stockV106);
        assert(transaction.setExpectedHash(STOCK_V106_SHA256));
        Transfer transfer(transaction);
        assert(transfer.begin(bytes.size(),FIRMWARE_BYTES_LIMIT,STOCK_V106_SHA256));
        for (std::size_t offset=0;offset<bytes.size();offset+=512) {
            assert(transfer.append(bytes.data()+offset,std::min<std::size_t>(512,bytes.size()-offset)));
        }
        if (fault == 1) backend.flash[backend.bounds.start+200000] ^= 1;
        if (fault == 2) { transfer.abort(); assert(backend.commands == 0); continue; }
        if (fault == 3) backend.layout.filesystemEndOffset -= 0x1000;
        HashJob job(transaction,digest,0,bytes.size());
        std::array<std::uint8_t,256> buffer{}; auto step = HashStep::pending;
        while (step == HashStep::pending) step = job.step(buffer.data(),buffer.size());
        assert(step == HashStep::complete); digest.finish(hash.data());
        const bool accepted = transfer.finish({hash.data(),hash.size()},true);
        assert(accepted == (fault == 0)); assert(backend.commands == (fault == 0 ? 1U : 0U));
        assert(backend.reservedBytesPreserved());
    }
    std::cout << "Real SHA-256 stock transaction: accepted intact vendor bytes; rejected readback corruption, complete abort and changed geometry; no device operation.\n";
}
