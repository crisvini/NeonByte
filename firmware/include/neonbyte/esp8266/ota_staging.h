#pragma once
#ifdef ARDUINO_ARCH_ESP8266

#include "neonbyte/ota_staging.h"
#include <Updater.h>
#include <bearssl/bearssl_hash.h>

namespace neonbyte {

class Esp8266OtaBackend final : public OtaFlashBackend {
public:
    Esp8266OtaBackend();
    bool geometry(OtaGeometry& geometry) override;
    bool begin(std::uint32_t length, const OtaStageBounds& bounds) override;
    bool write(const std::uint8_t* bytes, std::size_t length) override;
    bool readAt(std::uint32_t offset, std::uint8_t* destination, std::size_t length) override;
    bool finalize(OtaCandidateVerifier& verifier) override;
    void abort(OtaCandidateVerifier& verifier) override;

private:
    class Hash final : public UpdaterHashClass {
    public:
        void begin() override { br_sha256_init(&context_); }
        void add(const void* data, std::uint32_t length) override {
            br_sha256_update(&context_,data,length);
            optimistic_yield(1000);
        }
        void end() override { br_sha256_out(&context_,bytes_.data()); }
        int len() override { return bytes_.size(); }
        const void* hash() override { return bytes_.data(); }
        const unsigned char* oid() override;
    private:
        br_sha256_context context_{};
        std::array<std::uint8_t,32> bytes_{};
    };

    class Verifier final : public UpdaterVerifyClass {
    public:
        explicit Verifier(Esp8266OtaBackend& backend) : backend_(backend) {}
        std::uint32_t length() override { return 0; }
        bool verify(UpdaterHashClass*, const void*, std::uint32_t signatureLength) override;
    private:
        Esp8266OtaBackend& backend_;
    };

    void clearVerifier();
    Hash hash_{};
    Verifier verifier_;
    OtaCandidateVerifier* candidateVerifier_ = nullptr;
    OtaStageBounds bounds_{};
    std::uint32_t written_ = 0;
    bool active_ = false;
};

} // namespace neonbyte

#endif
