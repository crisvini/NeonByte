#!/usr/bin/env python3
"""Exercise the target HTTP loop with socket doubles; never access a device."""
import os
import subprocess
import tempfile
from pathlib import Path

from probe_compatibility import extractFunction


def main():
    repository = Path(__file__).resolve().parents[2]
    adapter = (repository / "firmware/src/esp8266/http_server.cpp").read_text()
    source = r'''
#include "neonbyte/http_headers.h"
#include "neonbyte/transfer.h"
#include <algorithm>
#include <array>
#include <cassert>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <deque>
#include <functional>
#include <memory>
#include <string>
#include <string_view>
using std::size_t;
unsigned flashMessageReads = 0;
unsigned char readFlashMessageByte(const void* address) {
    ++flashMessageReads;
    return *static_cast<const unsigned char*>(address);
}
#define pgm_read_byte(address) readFlashMessageByte(address)
#define PSTR(value) (value)
#define snprintf_P std::snprintf
struct SocketState { bool connected = true; std::string input, output; size_t offset = 0; };
struct Client {
    std::shared_ptr<SocketState> state;
    operator bool() { return available() || connected(); }
    int available() { return state ? static_cast<int>(state->input.size()-state->offset) : 0; }
    bool connected() { return state && (state->connected || available()); }
    void setNoDelay(bool) {} void setTimeout(int) {}
    void stop() { if (state) { state->connected = false; state->offset = state->input.size(); } }
    int availableForWrite() { return connected() ? 512 : 0; }
    size_t write(const uint8_t* data, size_t count) { state->output.append(reinterpret_cast<const char*>(data),count); return count; }
    int read() { return available() ? state->input[state->offset++] : -1; }
    int read(uint8_t* out,size_t count) { count=std::min(count,static_cast<size_t>(available())); std::memcpy(out,state->input.data()+state->offset,count); state->offset+=count; return count; }
};
struct Server {
    std::deque<Client> pending; unsigned accepts=0;
    Client accept() { ++accepts; if (pending.empty()) return {}; auto client=pending.front(); pending.pop_front(); return client; }
};
struct Sink : neonbyte::TransferSink {
    bool active=false, temporaryRetained=false; unsigned aborts=0, commits=0; std::string accepted;
    std::function<bool()> sourceClosed;
    std::array<uint8_t,4> rtc{};
    bool begin(uint32_t) override { active=true; return true; }
    bool write(const uint8_t* data,size_t count) override { accepted.append(reinterpret_cast<const char*>(data),count); return active; }
    bool commit() override { ++commits; active=false; rtc={{'E','B','O','T'}}; return true; }
    void abort() override { ++aborts; temporaryRetained=sourceClosed && !sourceClosed(); active=false; rtc={}; }
};
struct HashJob {};
struct Source {};
struct Diagnostics {
    uint32_t connectionsAccepted=0, connectionsDisconnected=0, idleTimeouts=0, totalTimeouts=0;
    uint32_t uploadsStarted=0, uploadsAborted=0, uploadsCompleted=0, uploadFailures=0, uploadBytes=0, maxLoopGapMs=0;
};
struct Restart { unsigned calls=0; void restart() { ++calls; } } ESP;
enum class AnimationV2Request { none, chunk };
enum class AnimationUploadState { Idle, Ready };
enum class AnimationUploadError { PromotionFailed };
struct StorageState {
    uint32_t animationRevision=0;
    bool animationPromotionFailed() const { return false; }
    void discardAnimationCandidate() {}
};
struct AnimationUploadStateStub {
    bool expire(uint64_t) { return false; }
    bool hasPendingChunk() const { return false; }
    AnimationUploadState state() const { return AnimationUploadState::Idle; }
    uint32_t installedGeneration() const { return 0; }
    void fail(AnimationUploadError,uint64_t) {}
    void markInstalled(uint64_t) {}
};
bool maintenanceOtaBodyHasNoExtraBytes(uint32_t received,uint32_t expected,size_t extra) { return received==expected && !extra; }
class DeviceHttpServer {
public:
    StorageState storage_; AnimationUploadStateStub animationUpload_;
    Sink assetSink_, otaSink_; neonbyte::Transfer transfer_{assetSink_}, maintenanceOta_{otaSink_};
    neonbyte::Transfer* activeTransfer_=&transfer_; neonbyte::Transfer* activeRawOta_=&maintenanceOta_;
    std::unique_ptr<HashJob> hashJob_; std::unique_ptr<Source> fileHashSource_; Source* hashSource_=nullptr;
    std::unique_ptr<uint8_t[]> animationChunkBody_;
    std::unique_ptr<char[]> body_; Client client_; Server server_; neonbyte::HttpHeaders headers_; neonbyte::HttpResponse response_; Diagnostics diagnostics_;
    std::array<char,4096> headerBytes_{}; std::array<char,192> responseHeaders_{}; std::array<uint8_t,512> chunk_{};
    size_t headerSize_=0,received_=0,sent_=0,responseHeaderSize_=0;
    uint64_t started_=0,lastActivity_=0,restartAt_=0,lastTick_=0,requestDeadlineMs_=60000;
    bool rebootPending_=false,finalizing_=false,readingBody_=false,sending_=false,binary_=false,firmware_=false,maintenanceFirmware_=false,stockRestore_=false,maintenance_=false,clientActive_=false,uploadActive_=false,lastTickValid_=false;
    bool legacyAnimationPromotionPending_=false,animationChunkWriting_=false,animationChunkDetached_=false;
    bool animationV2Route_=false,animationValidationHashDone_=false,animationValidationOpened_=false;
    AnimationV2Request animationV2Request_=AnimationV2Request::none;
    char* bodyData() { return body_.get(); }
    void error(unsigned,const char*,const char*);
    void advanceAnimationValidation(uint64_t) {}
    void finishAnimationChunkRequest(uint64_t) {}
    void prepareResponse() { sending_=true; sent_=0; body_.reset(); }
    void finishBinary() { assert(false); }
    void headersComplete() {
        const std::string_view request(headerBytes_.data(),headerSize_);
        assert(request == "GET /api/v1/status HTTP/1.1\r\nHost: test\r\n\r\n");
        assert(headers_.parse(request) && headers_.method==neonbyte::HttpMethod::get);
        assert(headers_.path=="/api/v1/status" && headers_.authorization.empty() && headers_.sha256.empty() && headers_.trackId.empty());
        const std::string response="HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n";
        std::memcpy(responseHeaders_.data(),response.data(),response.size()); responseHeaderSize_=response.size(); sending_=true;
    }
    void bodyComplete() { assert(false); }
    void close(); void tick(uint64_t now);
};
''' + extractFunction(adapter, "void DeviceHttpServer::close()") + "\n" + extractFunction(adapter, "void DeviceHttpServer::error(") + "\n" + extractFunction(adapter, "void DeviceHttpServer::tick(") + r'''
std::shared_ptr<SocketState> addStatus(DeviceHttpServer& server) {
    auto socket=std::make_shared<SocketState>();
    socket->input="GET /api/v1/status HTTP/1.1\r\nHost: test\r\n\r\n";
    server.server_.pending.push_back({socket}); return socket;
}
void expectStatus(DeviceHttpServer& server, uint64_t now) {
    auto socket=addStatus(server);
    for (unsigned i=0;i<8;++i) server.tick(now+i);
    assert(socket->output == "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
    assert(!server.clientActive_);
}
void disconnectedUploadDoesNotPoisonNextRequest() {
    DeviceHttpServer server; auto old=std::make_shared<SocketState>(); old->connected=false;
    server.client_={old}; server.clientActive_=true; server.readingBody_=server.binary_=true;
    server.uploadActive_=true; assert(server.transfer_.begin(1000,1000,std::string(64,'a'))); server.received_=10;
    server.tick(1000); server.tick(72000);
    assert(server.assetSink_.aborts==1 && !server.assetSink_.active && !server.readingBody_ && !server.clientActive_);
    assert(server.diagnostics_.connectionsDisconnected==1 && server.diagnostics_.uploadsAborted==1);
    assert(server.received_==0 && server.headerSize_==0);
    expectStatus(server,72001);
    assert(server.assetSink_.accepted.empty());
}
void queuedClientIsAcceptedOnlyAfterAbortingOldUpload() {
    DeviceHttpServer server; auto old=std::make_shared<SocketState>(); old->connected=false;
    server.client_={old}; server.clientActive_=true; server.readingBody_=server.binary_=server.uploadActive_=true;
    assert(server.transfer_.begin(1000,1000,std::string(64,'a'))); server.received_=23;
    auto next=addStatus(server);
    for (unsigned i=0;i<8;++i) server.tick(72000+i);
    assert(server.assetSink_.aborts==1 && server.assetSink_.accepted.empty());
    assert(next->output == "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
}
void disconnectedHeaderHashAndResponseAreCleared() {
    for (unsigned stage=0;stage<3;++stage) {
        DeviceHttpServer server; auto old=std::make_shared<SocketState>(); old->connected=false;
        server.client_={old}; server.clientActive_=true;
        if (stage==0) { server.headerSize_=13; server.headers_.path="/stale"; server.headers_.authorization="Bearer stale"; server.headers_.sha256="stale"; server.headers_.trackId="stale"; }
        if (stage==1) { server.finalizing_=server.binary_=server.uploadActive_=true; assert(server.transfer_.begin(1000,1000,std::string(64,'a'))); server.hashJob_.reset(new HashJob); server.fileHashSource_.reset(new Source); server.hashSource_=server.fileHashSource_.get(); server.assetSink_.sourceClosed=[&server] { return !server.hashJob_ && !server.fileHashSource_ && !server.hashSource_; }; }
        if (stage==2) { server.sending_=true; server.sent_=1; server.responseHeaderSize_=20; }
        server.tick(6000);
        assert(!server.clientActive_ && !server.finalizing_ && !server.sending_ && server.headerSize_==0);
        assert(!server.hashJob_ && !server.fileHashSource_ && !server.hashSource_);
        assert(server.headers_.path.empty() && server.headers_.authorization.empty() && server.headers_.sha256.empty() && server.headers_.trackId.empty());
        if (stage==1) assert(server.assetSink_.aborts==1 && !server.assetSink_.temporaryRetained);
        expectStatus(server,6001);
    }
}
void uploadErrorClosesReadbackBeforeDeletingCandidate() {
    DeviceHttpServer server;
    server.finalizing_=server.binary_=server.uploadActive_=true;
    assert(server.transfer_.begin(1000,1000,std::string(64,'a')));
    server.hashJob_.reset(new HashJob); server.fileHashSource_.reset(new Source); server.hashSource_=server.fileHashSource_.get();
    server.assetSink_.sourceClosed=[&server] { return !server.hashJob_ && !server.fileHashSource_ && !server.hashSource_; };
    server.error(500,"internal_error","Read failure.");
    assert(server.assetSink_.aborts==1 && !server.assetSink_.temporaryRetained && !server.finalizing_);
    assert(server.response_.statusCode==500 && server.sending_);
    assert(server.response_.bodyView()=="{\"code\":\"internal_error\",\"message\":\"Read failure.\"}");
    assert(flashMessageReads > 0);
}
void idleAndTotalDeadlineAreFinite() {
    DeviceHttpServer idle; auto socket=std::make_shared<SocketState>();
    idle.client_={socket}; idle.clientActive_=true; idle.readingBody_=idle.binary_=idle.uploadActive_=true; assert(idle.transfer_.begin(1000,1000,std::string(64,'a')));
    idle.started_=idle.lastActivity_=100; idle.tick(5101);
    assert(!idle.clientActive_ && idle.assetSink_.aborts==1);
    assert(idle.diagnostics_.idleTimeouts==1 && idle.diagnostics_.uploadsAborted==1);
    expectStatus(idle,5102);
    DeviceHttpServer large; socket=std::make_shared<SocketState>(); large.client_={socket}; large.clientActive_=true;
    large.readingBody_=large.binary_=large.uploadActive_=true; assert(large.transfer_.begin(1000,1000,std::string(64,'a')));
    large.started_=100; large.lastActivity_=65000; large.requestDeadlineMs_=120000;
    large.tick(65001); assert(large.clientActive_);
    large.lastActivity_=120101; large.tick(120102); assert(!large.clientActive_ && large.assetSink_.aborts==1);
    assert(large.diagnostics_.totalTimeouts==1 && large.diagnostics_.uploadsAborted==1);
}
void activatedOtaNeverAcceptsNewClientOrAborts() {
    DeviceHttpServer server; auto old=std::make_shared<SocketState>(); old->connected=false;
    server.client_={old}; server.clientActive_=true; server.rebootPending_=server.sending_=true;
    const std::string hash(64,'a'); const uint8_t byte=42;
    assert(server.maintenanceOta_.begin(1,1,hash)); assert(server.maintenanceOta_.append(&byte,1));
    assert(server.maintenanceOta_.finish(hash,true));
    const auto savedRtc=server.otaSink_.rtc;
    assert(server.otaSink_.commits==1 && savedRtc[0]=='E');
    server.activeTransfer_=&server.maintenanceOta_;
    auto next=addStatus(server);
    server.tick(1000); assert(server.rebootPending_ && server.otaSink_.aborts==0 && server.otaSink_.rtc==savedRtc && server.server_.accepts==0 && next->output.empty());
    server.tick(3001); assert(ESP.calls==1 && server.server_.accepts==0 && server.otaSink_.rtc==savedRtc);
}
int main() {
    disconnectedUploadDoesNotPoisonNextRequest();
    queuedClientIsAcceptedOnlyAfterAbortingOldUpload();
    disconnectedHeaderHashAndResponseAreCleared();
    uploadErrorClosesReadbackBeforeDeletingCandidate();
    idleAndTotalDeadlineAreFinite();
    activatedOtaNeverAcceptsNewClientOrAborts();
    std::puts("HTTP lifecycle: interrupted uploads, header/hash/response cleanup, finite deadlines, recovery and activated OTA protection passed.");
}
'''
    sanitizers = (["-fsanitize=address,undefined", "-fno-omit-frame-pointer", "-fno-pie", "-no-pie"]
                  if os.environ.get("NEONBYTE_PROBE_SANITIZERS") == "1" else [])
    with tempfile.TemporaryDirectory(prefix="neonbyte-http-lifecycle-") as directory:
        code = Path(directory) / "probe.cpp"
        binary = Path(directory) / "probe"
        code.write_text(source, encoding="utf-8")
        subprocess.run([os.environ.get("CXX", "c++"), "-std=c++17", "-Wall", "-Wextra", "-Werror",
                        *sanitizers, "-I" + str(repository / "firmware/include"), str(code),
                        str(repository / "firmware/src/transfer.cpp"), str(repository / "firmware/src/http_headers.cpp"),
                        "-o", str(binary)], check=True)
        subprocess.run([str(binary)], check=True)


if __name__ == "__main__":
    main()
