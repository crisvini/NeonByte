#!/usr/bin/env python3
"""Exercise production NBIF v2 HTTP route logic with host-only storage doubles."""

import os
import subprocess
import tempfile
from pathlib import Path


def extractCppFunction(source, signature):
    if source.count(signature) != 1:
        raise ValueError(f"Expected one definition of {signature}")
    start = source.index(signature)
    opening = source.index("{", start)
    depth = 0
    index = opening
    state = "code"
    while index < len(source):
        char = source[index]
        next_char = source[index + 1] if index + 1 < len(source) else ""
        if state == "code":
            if char == '"':
                state = "string"
            elif char == "'":
                state = "character"
            elif char == "/" and next_char == "/":
                state = "line_comment"
                index += 1
            elif char == "/" and next_char == "*":
                state = "block_comment"
                index += 1
            elif char == "{":
                depth += 1
            elif char == "}":
                depth -= 1
                if depth == 0:
                    return source[start:index + 1]
        elif state in ("string", "character"):
            if char == "\\":
                index += 1
            elif (state == "string" and char == '"') or (state == "character" and char == "'"):
                state = "code"
        elif state == "line_comment" and char == "\n":
            state = "code"
        elif state == "block_comment" and char == "*" and next_char == "/":
            state = "code"
            index += 1
        index += 1
    raise ValueError(f"Unterminated definition of {signature}")


def routeHeadersComplete(adapter):
    function = extractCppFunction(adapter, "void DeviceHttpServer::headersComplete()")
    start = function.index("    if (maintenanceFirmware_) {")
    end = function.index("    if (!maintenance_ && !protocol_)", start)
    auth = '''    if (!maintenance_ && headers_.path != "/api/v1/status" &&
        !authenticator_.isAuthorized(headers_.authorization)) {
        error(401,"unauthorized","A valid bearer token is required."); return;
    }
'''
    function = function[:start] + auth + function[end:]
    start = function.index("    if (!headers_.query.empty())")
    function = function[:start] + "    return;\n}"
    return function


def routeBodyComplete(adapter):
    function = extractCppFunction(adapter, "void DeviceHttpServer::bodyComplete()")
    end = function.index("    if (!binary_) { dispatchJson(); return; }")
    return function[:end] + "    return;\n}"


def main():
    repository = Path(__file__).resolve().parents[2]
    adapter = (repository / "firmware/src/esp8266/http_server.cpp").read_text(encoding="utf-8")
    helper_start = adapter.index("namespace {", adapter.index("namespace neonbyte {"))
    helper_end = adapter.index("\n} // namespace", helper_start) + len("\n} // namespace")
    helpers = adapter[helper_start:helper_end]
    route_functions = "\n".join((
        routeHeadersComplete(adapter),
        routeBodyComplete(adapter),
        extractCppFunction(adapter, "void DeviceHttpServer::finishAnimationChunkRequest(std::uint64_t now)"),
        extractCppFunction(adapter, "void DeviceHttpServer::dispatchAnimationV2()"),
        extractCppFunction(adapter, "void DeviceHttpServer::advanceAnimationValidation(std::uint64_t now)"),
    ))
    source = r'''
#include "neonbyte/animation_decoder.h"
#include "neonbyte/animation_upload.h"
#include "neonbyte/hash_job.h"
#include "neonbyte/http_headers.h"
#include "neonbyte/interfaces.h"
#include "neonbyte/protocol.h"
#include <openssl/evp.h>
#include <algorithm>
#include <array>
#include <cassert>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <initializer_list>
#include <memory>
#include <string>
#include <string_view>
#include <vector>
#define PSTR(value) (value)
#define snprintf_P std::snprintf
using namespace neonbyte;
namespace neonbyte {
struct Runtime { std::uint32_t getChipId() const { return 0x123abc; } } ESP;
''' + helpers + r'''
bool isStockRestorePath(std::string_view) { return false; }
bool isRawMaintenanceUploadPath(std::string_view) { return false; }
class UploadStorage final : public Storage, public AnimationUploadBackend {
public:
    static constexpr std::uint64_t capacity = 4 * 1024 * 1024;
    std::vector<std::uint8_t> installed, candidate;
    std::uint32_t animationRevision = 0;
    bool candidateReady = false;
    std::size_t maxWrite = 0;
    bool animationPromotionFailed() const { return false; }
    bool loadMode(DisplayMode&) const override { return false; }
    bool saveMode(DisplayMode) override { return true; }
    std::uint64_t freeBytes() const override {
        const auto used = installed.size() + candidate.size();
        return used < capacity ? capacity - used : 0;
    }
    std::uint32_t animationSize() const override { return static_cast<std::uint32_t>(installed.size()); }
    bool readAnimationAt(std::uint32_t offset, std::uint8_t* out, std::size_t length) const override {
        if (offset > installed.size() || length > installed.size() - offset) return false;
        std::copy_n(installed.data() + offset, length, out);
        return true;
    }
    std::uint64_t animationUploadFreeBytes() const override { return freeBytes(); }
    std::uint32_t animationCandidateSize() const override { return static_cast<std::uint32_t>(candidate.size()); }
    bool beginAnimationCandidate(std::uint32_t length) override {
        candidate.clear(); candidate.reserve(length); candidateReady = false; return true;
    }
    bool begin(std::uint32_t length) override { return beginAnimationCandidate(length); }
    bool write(const std::uint8_t* bytes, std::size_t length) override {
        maxWrite = std::max(maxWrite, length); candidate.insert(candidate.end(), bytes, bytes + length); return true;
    }
    bool commit() override { return false; }
    void abort() override { discardAnimationCandidate(); }
    bool readAnimationCandidateAt(std::uint32_t offset, std::uint8_t* out, std::size_t length) const override {
        if (offset > candidate.size() || length > candidate.size() - offset) return false;
        std::copy_n(candidate.data() + offset, length, out); return true;
    }
    bool sealAnimationCandidate() override { return true; }
    bool markAnimationCandidateReady() override { candidateReady = true; return true; }
    void discardAnimationCandidate() override { candidate.clear(); candidateReady = false; }
    bool promoteAnimationCandidateAtBoundary() {
        if (!candidateReady) return false;
        installed = candidate; candidate.clear(); candidateReady = false; ++animationRevision; return true;
    }
};
class CandidateSource final : public AnimationSource {
public:
    explicit CandidateSource(const UploadStorage& storage) : storage_(storage) {}
    std::uint32_t size() const override { return storage_.animationCandidateSize(); }
    bool readAt(std::uint32_t offset, std::uint8_t* out, std::size_t length) const override {
        return storage_.readAnimationCandidateAt(offset, out, length);
    }
private:
    const UploadStorage& storage_;
};
class Digest final : public ContentDigest {
public:
    Digest() : context_(EVP_MD_CTX_new()) { assert(context_); reset(); }
    ~Digest() override { EVP_MD_CTX_free(context_); }
    void reset() override { assert(EVP_DigestInit_ex(context_, EVP_sha256(), nullptr) == 1); }
    void update(const std::uint8_t* bytes, std::size_t length) override {
        assert(EVP_DigestUpdate(context_, bytes, length) == 1);
    }
    void finish(char* out) override {
        unsigned char bytes[32]; unsigned length = 0;
        assert(EVP_DigestFinal_ex(context_, bytes, &length) == 1 && length == 32);
        constexpr char digits[] = "0123456789abcdef";
        for (unsigned i = 0; i < 32; ++i) { out[2*i] = digits[bytes[i] >> 4]; out[2*i+1] = digits[bytes[i] & 15]; }
    }
private:
    EVP_MD_CTX* context_;
};
class Auth final : public RequestAuthenticator {
public:
    bool isAuthorized(std::string_view value) const override { return value == "Bearer test"; }
};
class DeviceHttpServer {
public:
    enum class AnimationV2Request : std::uint8_t { none, capabilities, begin, chunk, complete, status, cancel, invalid };
    struct Diagnostics { std::uint32_t uploadBytes = 0; } diagnostics_;
    UploadStorage storage_;
    CandidateSource candidateSource_{storage_};
    Auth authenticator_;
    int protocolObject_ = 1;
    void* protocol_ = &protocolObject_;
    AnimationUploadSession animationUpload_{storage_};
    Digest digest_;
    std::unique_ptr<HashJob> hashJob_;
    std::array<std::uint8_t, 512> chunk_{};
    AnimationDecoder validationDecoder_{candidateSource_, nullptr, 0, chunk_.data(), chunk_.size()};
    std::array<char, 4096> headerBytes_{};
    std::array<char, 513> controlBody_{};
    std::unique_ptr<std::uint8_t[]> animationChunkBody_;
    HttpHeaders headers_;
    HttpResponse response_;
    std::size_t headerSize_ = 0, received_ = 0;
    std::uint32_t animationUploadId_ = 0, animationChunkOffset_ = 0, animationUploadIdCounter_ = 0;
    std::uint64_t lastActivity_ = 0;
    AnimationV2Request animationV2Request_ = AnimationV2Request::none;
    bool animationV2Route_ = false, animationChunkWriting_ = false, animationChunkDetached_ = false;
    bool animationValidationHashDone_ = false, animationValidationOpened_ = false;
    bool readingBody_ = false, finalizing_ = false, clientActive_ = true, firmware_ = false;
    bool maintenance_ = false, maintenanceFirmware_ = false, stockRestore_ = false;
    bool binary_ = false;
    unsigned status = 0;
    char* bodyData() { return controlBody_.data(); }
    void error(unsigned code, const char*, const char*) {
        response_ = {}; response_.statusCode = static_cast<std::uint16_t>(code); status = code;
        finalizing_ = false; sending_ = true;
    }
    void prepareResponse() { status = response_.statusCode; sending_ = true; }
    bool sending_ = false;
    void headersComplete(); void bodyComplete(); void finishAnimationChunkRequest(std::uint64_t now);
    void dispatchAnimationV2(); void advanceAnimationValidation(std::uint64_t now);
    void request(std::string method, std::string path, std::string contentType = {}, std::uint32_t contentLength = 0,
                 std::string query = {}, std::string body = {}, std::string authorization = "Bearer test") {
        response_ = {}; status = 0; sending_ = readingBody_ = finalizing_ = false;
        animationV2Route_ = false; animationV2Request_ = AnimationV2Request::none;
        received_ = 0; headerSize_ = 0; lastActivity_ += 1;
        std::string wire = method + " " + path + (query.empty() ? "" : "?" + query) + " HTTP/1.1\r\nHost: test\r\nAuthorization: " + authorization + "\r\n";
        if (!contentType.empty()) wire += "Content-Type: " + contentType + "\r\n";
        if (method != "GET" || contentLength != 0) wire += "Content-Length: " + std::to_string(contentLength) + "\r\n";
        wire += "\r\n";
        assert(wire.size() <= headerBytes_.size());
        std::memcpy(headerBytes_.data(), wire.data(), wire.size()); headerSize_ = wire.size();
        headersComplete();
        if (!readingBody_ || body.empty()) return;
        assert(body.size() == contentLength);
        if (animationV2Request_ == AnimationV2Request::chunk) {
            std::memcpy(animationChunkBody_.get(), body.data(), body.size());
        } else {
            assert(body.size() < controlBody_.size()); std::memcpy(controlBody_.data(), body.data(), body.size());
        }
        received_ = body.size(); bodyComplete();
    }
};
''' + route_functions + r'''
void append16(std::vector<std::uint8_t>& bytes, std::uint16_t value) {
    bytes.push_back(static_cast<std::uint8_t>(value)); bytes.push_back(static_cast<std::uint8_t>(value >> 8));
}
void write32(std::vector<std::uint8_t>& bytes, std::size_t at, std::uint32_t value) {
    for (unsigned i=0;i<4;++i) bytes[at+i]=static_cast<std::uint8_t>(value>>(i*8));
}
void appendRow(std::vector<std::uint8_t>& bytes, std::uint8_t y, std::uint8_t x, std::uint8_t width,
               std::initializer_list<std::uint8_t> payload) {
    bytes.insert(bytes.end(), {y,x,width,3}); append16(bytes, payload.size()); bytes.insert(bytes.end(),payload);
}
std::vector<std::uint8_t> makeV2() {
    std::vector<std::uint8_t> key; append16(key,0xf800);
    for (unsigned y=0;y<240;++y) appendRow(key,static_cast<std::uint8_t>(y),0,240,{0xff,0,0xef,0});
    std::vector<std::uint8_t> delta; append16(delta,0x07e0); appendRow(delta,10,20,2,{0x81,0});
    const auto data=NBIF_V2_HEADER_BYTES+2*NBIF_V2_DIRECTORY_ENTRY_BYTES;
    const auto deltaOffset=data+key.size(); const auto total=deltaOffset+delta.size();
    std::vector<std::uint8_t> bytes(total,0);
    bytes[0]='N';bytes[1]='B';bytes[2]='I';bytes[3]='F';bytes[4]=2;bytes[6]=240;bytes[8]=240;bytes[10]=2;
    write32(bytes,12,100);write32(bytes,16,total);
    auto entry=[&](std::size_t at,std::uint32_t offset,std::uint32_t length,std::uint16_t delay,std::uint8_t kind,std::uint16_t rows){
        write32(bytes,at,offset);write32(bytes,at+4,length);bytes[at+8]=delay;bytes[at+9]=delay>>8;bytes[at+10]=kind;
        bytes[at+11]=1;bytes[at+12]=1;bytes[at+14]=static_cast<std::uint8_t>(rows);bytes[at+15]=static_cast<std::uint8_t>(rows>>8);
    };
    entry(24,data,key.size(),40,0,240);entry(44,deltaOffset,delta.size(),60,1,1);
    std::copy(key.begin(),key.end(),bytes.begin()+data);std::copy(delta.begin(),delta.end(),bytes.begin()+deltaOffset);
    return bytes;
}
std::string sha256(const std::vector<std::uint8_t>& bytes) {
    EVP_MD_CTX* context=EVP_MD_CTX_new();assert(context);assert(EVP_DigestInit_ex(context,EVP_sha256(),nullptr)==1);
    assert(EVP_DigestUpdate(context,bytes.data(),bytes.size())==1);unsigned char digest[32];unsigned size=0;
    assert(EVP_DigestFinal_ex(context,digest,&size)==1&&size==32);EVP_MD_CTX_free(context);
    constexpr char digits[]="0123456789abcdef";std::string value(64,'0');
    for(unsigned i=0;i<32;++i){value[2*i]=digits[digest[i]>>4];value[2*i+1]=digits[digest[i]&15];}return value;
}
std::uint32_t readUploadId(const HttpResponse& response) {
    unsigned value=0;assert(std::sscanf(response.body.data(),"{\"uploadId\":\"%8x\"",&value)==1);return value;
}
struct TestClock final : Clock { std::uint64_t now=0; std::uint64_t monotonicMillis() const override{return now;} std::uint64_t unixMillis() const override{return 1'800'000'000'000;} };
void assertBackgroundServices(TestClock& clock, SceneManager& scenes, unsigned& services) {
    ++clock.now;scenes.heartbeat();++services;const auto state=scenes.currentState();assert(state.agentAvailable&&state.activeScene==ActiveScene::spotify);
}
void uploadBytes(DeviceHttpServer& server,const std::vector<std::uint8_t>& bytes,TestClock& clock,
                 SceneManager& scenes,unsigned& cooperativeTicks) {
    const std::string beginBody="{\"sizeBytes\":"+std::to_string(bytes.size())+",\"sha256\":\""+sha256(bytes)+"\"}";
    server.request("POST","/api/v2/animation/uploads","application/json",beginBody.size(),{},beginBody);
    assert(server.status==201);const auto id=readUploadId(server.response_);char path[64];
    for(std::size_t offset=0;offset<bytes.size();){
        const auto length=std::min<std::size_t>(ANIMATION_UPLOAD_MAX_CHUNK_BYTES,bytes.size()-offset);
        std::snprintf(path,sizeof(path),"/api/v2/animation/uploads/%08x/chunks",id);
        server.request("PUT",path,"application/octet-stream",length,"offset="+std::to_string(offset),
            std::string(reinterpret_cast<const char*>(bytes.data()+offset),length));
        assert(server.animationChunkWriting_ && server.finalizing_);
        while(server.animationChunkWriting_){
            server.finishAnimationChunkRequest(++server.lastActivity_);
            assertBackgroundServices(clock,scenes,cooperativeTicks);
        }
        assert(server.status==204);offset+=length;
    }
    std::snprintf(path,sizeof(path),"/api/v2/animation/uploads/%08x/complete",id);
    server.request("POST",path);assert(server.status==202);
}
void validRouteUploadValidatesAndPromotesOnlyAtBoundary() {
    DeviceHttpServer server; server.storage_.installed={'N','B','I','F',1};
    TestClock clock;SceneManager scenes(clock,server.storage_);assert(scenes.setMode(DisplayMode::spotify));
    NowPlaying track;track.trackId.bytes[0]='x';track.trackId.length=1;track.isPlaying=true;track.durationMs=60'000;scenes.updateNowPlaying(track);scenes.heartbeat();
    server.request("GET","/api/v2/media-capabilities",{},0,{}, {},"Bearer wrong");assert(server.status==401);
    server.request("GET","/api/v2/media-capabilities");assert(server.status==200);
    auto capabilities=server.response_.bodyView();assert(capabilities.find("nbif-v1")!=capabilities.npos&&capabilities.find("nbif-v2")!=capabilities.npos);
    const auto expected=makeV2();unsigned cooperativeTicks=0;uploadBytes(server,expected,clock,scenes,cooperativeTicks);
    assert(server.animationUpload_.state()==AnimationUploadState::Verifying&&server.storage_.installed==std::vector<std::uint8_t>({'N','B','I','F',1}));
    const auto uploadId=server.animationUpload_.uploadId();char path[64];std::snprintf(path,sizeof(path),"/api/v2/animation/uploads/%08x",uploadId);
    while(server.animationUpload_.state()==AnimationUploadState::Verifying){
        server.advanceAnimationValidation(++server.lastActivity_);
        std::fill(server.chunk_.begin(),server.chunk_.end(),0xa5);
        assertBackgroundServices(clock,scenes,cooperativeTicks);
        if (cooperativeTicks % 32 == 0 && server.animationUpload_.state()==AnimationUploadState::Verifying) {
            server.request("GET",path);
            assert(server.status==200 && server.response_.bodyView().find("\"state\":\"verifying\"")!=std::string_view::npos);
        }
    }
    assert(server.animationUpload_.state()==AnimationUploadState::Ready);
    assert(server.storage_.installed==std::vector<std::uint8_t>({'N','B','I','F',1}));
    assert(server.storage_.candidateReady&&server.storage_.maxWrite<=512&&cooperativeTicks>240);
    server.request("GET",path);assert(server.status==200&&server.response_.bodyView().find("\"state\":\"ready\"")!=server.response_.bodyView().npos);
    assert(server.storage_.promoteAnimationCandidateAtBoundary());
    server.request("GET",path);assert(server.status==200&&server.response_.bodyView().find("\"state\":\"installed\"")!=server.response_.bodyView().npos);
    assert(server.storage_.installed==expected);
}
void checksumMismatchAndMalformedV2PreserveCurrentAnimation() {
    DeviceHttpServer badHash;badHash.storage_.installed={'N','B','I','F',1};const auto old=badHash.storage_.installed;
    auto data=makeV2();const std::string wrongHashBody="{\"sizeBytes\":"+std::to_string(data.size())+",\"sha256\":\""+std::string(64,'0')+"\"}";
    badHash.request("POST","/api/v2/animation/uploads","application/json",wrongHashBody.size(),{},wrongHashBody);assert(badHash.status==201);
    const auto id=readUploadId(badHash.response_);char path[64];std::size_t offset=0;
    while(offset<data.size()){const auto size=std::min<std::size_t>(1024,data.size()-offset);std::snprintf(path,sizeof(path),"/api/v2/animation/uploads/%08x/chunks",id);
        badHash.request("PUT",path,"application/octet-stream",size,"offset="+std::to_string(offset),std::string(reinterpret_cast<const char*>(data.data()+offset),size));
        while(badHash.animationChunkWriting_) badHash.finishAnimationChunkRequest(++badHash.lastActivity_);
        offset+=size;
    }
    std::snprintf(path,sizeof(path),"/api/v2/animation/uploads/%08x/complete",id);badHash.request("POST",path);assert(badHash.status==202);
    while(badHash.animationUpload_.state()==AnimationUploadState::Verifying)badHash.advanceAnimationValidation(++badHash.lastActivity_);
    assert(badHash.animationUpload_.state()==AnimationUploadState::Failed&&badHash.animationUpload_.error()==AnimationUploadError::ChecksumMismatch);
    assert(badHash.storage_.installed==old&&badHash.storage_.candidate.empty());
    std::snprintf(path,sizeof(path),"/api/v2/animation/uploads/%08x",id);badHash.request("GET",path);
    assert(badHash.status==200&&badHash.response_.bodyView().find("checksum_mismatch")!=badHash.response_.bodyView().npos);

    DeviceHttpServer invalid;invalid.storage_.installed=old;data=std::vector<std::uint8_t>(NBIF_V2_HEADER_BYTES,0);
    data[0]='N';data[1]='B';data[2]='I';data[3]='F';data[4]=2;data[6]=240;data[8]=240;data[10]=1;
    const std::string invalidBody="{\"sizeBytes\":"+std::to_string(data.size())+",\"sha256\":\""+sha256(data)+"\"}";
    invalid.request("POST","/api/v2/animation/uploads","application/json",invalidBody.size(),{},invalidBody);assert(invalid.status==201);
    const auto invalidId=readUploadId(invalid.response_);std::snprintf(path,sizeof(path),"/api/v2/animation/uploads/%08x/chunks",invalidId);
    invalid.request("PUT",path,"application/octet-stream",data.size(),"offset=0",std::string(reinterpret_cast<const char*>(data.data()),data.size()));
    while(invalid.animationChunkWriting_)invalid.finishAnimationChunkRequest(++invalid.lastActivity_);
    std::snprintf(path,sizeof(path),"/api/v2/animation/uploads/%08x/complete",invalidId);invalid.request("POST",path);assert(invalid.status==202);
    while(invalid.animationUpload_.state()==AnimationUploadState::Verifying)invalid.advanceAnimationValidation(++invalid.lastActivity_);
    assert(invalid.animationUpload_.state()==AnimationUploadState::Failed&&invalid.animationUpload_.error()==AnimationUploadError::InvalidAnimation);
    assert(invalid.storage_.installed==old&&invalid.storage_.candidate.empty());
    std::snprintf(path,sizeof(path),"/api/v2/animation/uploads/%08x",invalidId);invalid.request("GET",path);
    assert(invalid.status==200&&invalid.response_.bodyView().find("invalid_animation")!=invalid.response_.bodyView().npos);
}
void cancelRouteDiscardsOnlyThePendingCandidate() {
    DeviceHttpServer server;server.storage_.installed={'N','B','I','F',1};const auto old=server.storage_.installed;
    const auto data=makeV2();const std::string body="{\"sizeBytes\":"+std::to_string(data.size())+",\"sha256\":\""+sha256(data)+"\"}";
    server.request("POST","/api/v2/animation/uploads","application/json",body.size(),{},body);assert(server.status==201);
    const auto id=readUploadId(server.response_);char path[64];std::snprintf(path,sizeof(path),"/api/v2/animation/uploads/%08x",id);
    server.request("DELETE",path);assert(server.status==204);
    assert(server.animationUpload_.state()==AnimationUploadState::Cancelled);
    assert(server.storage_.candidate.empty()&&server.storage_.installed==old&&server.storage_.animationRevision==0);
}
}
int main(){neonbyte::validRouteUploadValidatesAndPromotesOnlyAtBoundary();
    neonbyte::checksumMismatchAndMalformedV2PreserveCurrentAnimation();
    neonbyte::cancelRouteDiscardsOnlyThePendingCandidate();
    std::puts("NBIF v2 HTTP route integration: authentication, capabilities, chunk upload, SHA-256, validation, status, cancellation and safe promotion passed.");}
'''
    sanitizers = (["-fsanitize=address,undefined", "-fno-omit-frame-pointer", "-fno-pie", "-no-pie"]
                  if os.environ.get("NEONBYTE_PROBE_SANITIZERS") == "1" else [])
    with tempfile.TemporaryDirectory(prefix="neonbyte-animation-v2-http-") as directory:
        sourcePath = Path(directory) / "probe.cpp"
        binaryPath = Path(directory) / "probe"
        sourcePath.write_text(source, encoding="utf-8")
        subprocess.run([os.environ.get("CXX", "c++"), "-std=c++17", "-Wall", "-Wextra", "-Werror",
                        *sanitizers, "-I" + str(repository / "firmware/include"), str(sourcePath),
                        str(repository / "firmware/src/animation_decoder.cpp"),
                        str(repository / "firmware/src/animation_upload.cpp"),
                        str(repository / "firmware/src/hash_job.cpp"),
                        str(repository / "firmware/src/http_headers.cpp"),
                        str(repository / "firmware/src/scene_manager.cpp"),
                        str(repository / "firmware/src/transfer.cpp"), "-lcrypto", "-o", str(binaryPath)], check=True)
        subprocess.run([str(binaryPath)], check=True)


if __name__ == "__main__":
    main()
