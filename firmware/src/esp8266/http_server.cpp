#ifdef ARDUINO_ARCH_ESP8266
#include "neonbyte/esp8266/http_server.h"
#include "neonbyte/wifi_configuration.h"
#include <bearssl/bearssl_hash.h>
#include <algorithm>
#include <cstdio>
#include <cstring>
#include <new>
namespace neonbyte {
void Sha256Digest::finish(char* hex64) {
    std::uint8_t bytes[32]; constexpr char HEX_DIGITS[] = "0123456789abcdef";
    br_sha256_out(&context_,bytes);
    for (unsigned i=0;i<32;++i) { hex64[2*i] = HEX_DIGITS[bytes[i]>>4]; hex64[2*i+1] = HEX_DIGITS[bytes[i]&15]; }
}
void DeviceHttpServer::close() {
    transfer_.abort(); hashJob_.reset(); hashSource_.reset(); client_.stop(); body_.reset();
    headerSize_ = received_ = sent_ = 0;
    finalizing_ = readingBody_ = sending_ = binary_ = firmware_ = false;
}
void DeviceHttpServer::error(unsigned status, const char* code, const char* message) {
    transfer_.abort(); hashJob_.reset(); hashSource_.reset(); finalizing_ = false; response_ = {}; response_.statusCode = status;
    response_.contentType = "application/json";
    response_.bodySize = snprintf(response_.body.data(),response_.body.size(),"{\"code\":\"%s\",\"message\":\"%s\"}",code,message);
    prepareResponse();
}
void DeviceHttpServer::prepareResponse() {
    const auto type = response_.contentType.empty() ? std::string_view("application/json") : response_.contentType;
    responseHeaderSize_ = snprintf(responseHeaders_.data(),responseHeaders_.size(),
        "HTTP/1.1 %u %s\r\nContent-Length: %u\r\nContent-Type: %.*s\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n",
        response_.statusCode,response_.statusCode < 300 ? "OK" : "Error",unsigned(response_.bodySize),int(type.size()),type.data());
    sending_ = true; sent_ = 0; body_.reset();
}
void DeviceHttpServer::headersComplete() {
    if (!headers_.parse({headerBytes_.data(),headerSize_})) { error(400,"invalid_request","Use unambiguous HTTP/1.1 framing and Content-Length."); return; }
    if (headers_.path != "/api/v1/status" && !authenticator_.isAuthorized(headers_.authorization)) { error(401,"unauthorized","A valid bearer token is required."); return; }
    firmware_ = headers_.path == "/api/v1/firmware";
    binary_ = firmware_ || headers_.path == "/api/v1/cover" || headers_.path == "/api/v1/animation";
    if (binary_) {
        if (headers_.method != HttpMethod::put) { error(400,"invalid_request","The upload route requires PUT."); return; }
        if (firmware_ && !NEONBYTE_ENABLE_OTA) { error(409,"conflict","OTA is disabled pending installation and recovery validation."); return; }
        if (headers_.contentType != "application/octet-stream") { error(415,"unsupported_media_type","Upload application/octet-stream."); return; }
        const auto kind = firmware_ ? AssetKind::firmware : headers_.path == "/api/v1/cover" ? AssetKind::cover : AssetKind::animation;
        const auto limit = firmware_ ? FIRMWARE_BYTES_LIMIT : kind == AssetKind::cover ? COVER_BYTES : ANIMATION_BYTES_LIMIT;
        if (headers_.contentLength > limit) { error(413,"payload_too_large","The asset exceeds this build's upload limit."); return; }
        if (!headers_.contentLength || !isSha256(headers_.sha256)) { error(400,"invalid_request","Provide a nonzero length and lowercase SHA-256."); return; }
        if (kind == AssetKind::cover && headers_.contentLength != COVER_BYTES) { error(422,"invalid_content","The cover must be NBIC v1 at 240 by 240."); return; }
        if (!storage_.selectAsset(kind,headers_.trackId)) { error(400,"invalid_request","Provide a percent-encoded UTF-8 X-Track-Id of 1 to 256 code points."); return; }
        if (!transfer_.begin(headers_.contentLength,limit,headers_.sha256)) { error(409,"conflict","Storage is unavailable or insufficient for atomic replacement."); return; }
    } else {
        const auto limit = headers_.path == "/api/v1/config" ? 512U : JSON_BODY_LIMIT;
        if (headers_.contentLength > limit) { error(413,"payload_too_large","The request body exceeds the route limit."); return; }
        body_.reset(new (std::nothrow) char[headers_.contentLength+1]);
        if (!body_) { error(500,"internal_error","Insufficient memory for this request."); return; }
    }
    readingBody_ = true;
    if (!headers_.contentLength) bodyComplete();
}
void DeviceHttpServer::configureWifi() {
    if (headers_.method != HttpMethod::put || headers_.contentType != "application/x-www-form-urlencoded") { error(400,"invalid_request","Use PUT with an ssid and password form."); return; }
    WifiCredentials credentials;
    if (!parseWifiConfiguration({body_.get(),received_},credentials)) { error(400,"invalid_request","Provide a valid ssid and password form."); return; }
    DeviceConfiguration candidate = storage_.configuration;
    memcpy(candidate.ssid,credentials.ssid,sizeof(candidate.ssid));
    memcpy(candidate.password,credentials.password,sizeof(candidate.password));
    if (!storage_.saveConfiguration(candidate)) { error(500,"internal_error","The Wi-Fi configuration could not be saved."); return; }
    configurationChanged = true; response_ = {}; response_.statusCode = 204; prepareResponse();
}
void DeviceHttpServer::finishBinary() {
    const auto result = hashJob_->step(chunk_.data(),chunk_.size());
    if (result == HashStep::pending) return;
    if (result == HashStep::failed) { error(500,"internal_error","The staged asset could not be read."); return; }
    char actualHash[64]; digest_.finish(actualHash);
    hashJob_.reset(); hashSource_.reset(); finalizing_ = false;
    if (!transfer_.finish({actualHash,sizeof(actualHash)},true)) { error(422,"invalid_content","Checksum validation or atomic installation failed."); return; }
    if (firmware_) {
        if (!storage_.applyFirmware()) { error(500,"internal_error","Firmware staging was rejected; no restart was requested."); return; }
        rebootPending_ = true;
    }
    response_ = {}; response_.statusCode = 204; prepareResponse();
}
void DeviceHttpServer::dispatchJson() {
    body_[received_] = 0;
    if (headers_.path == "/api/v1/config") { configureWifi(); return; }
    const String ip = WiFi.status() == WL_CONNECTED ? WiFi.localIP().toString() : WiFi.softAPIP().toString();
    const HttpRequest request{headers_.method,headers_.path,headers_.authorization,headers_.contentType,{body_.get(),received_}};
    response_ = protocol_.handle(request,{"0.1.0-phase4",{ip.c_str(),ip.length()}}); prepareResponse();
}
void DeviceHttpServer::bodyComplete() {
    if (!binary_) { dispatchJson(); return; }
    storage_.sealStaged();
    if (!storage_.validateStaged()) { error(422,"invalid_content","The uploaded asset format is invalid."); return; }
    const char* path = firmware_ ? "/neonbyte/firmware.part" : headers_.path == "/api/v1/cover" ? "/neonbyte/cover.part" : "/neonbyte/animation.part";
    const auto prefix = headers_.path == "/api/v1/cover" ? COVER_TRACK_BYTES : 0U;
    hashSource_.reset(new (std::nothrow) FileSource(path));
    if (hashSource_) hashJob_.reset(new (std::nothrow) HashJob(*hashSource_,digest_,prefix,received_));
    if (!hashJob_) { error(500,"internal_error","Insufficient memory to validate the upload."); return; }
    finalizing_ = true;
}
void DeviceHttpServer::tick(std::uint64_t now) {
    if (rebootPending_) {
        if (!restartAt_) restartAt_ = now+2000;
        if (now >= restartAt_) { client_.stop(); ESP.restart(); }
        // Do not accept another mutation after Update.end schedules the boot copy.
        if (!sending_) return;
    }
    if (!client_) {
        client_ = server_.accept(); if (!client_) return;
        client_.setNoDelay(true); client_.setTimeout(10); started_ = lastActivity_ = now;
    }
    if ((!finalizing_ && now-lastActivity_ > 5000) || now-started_ > 60000 || (!client_.connected() && !client_.available())) { close(); return; }
    if (finalizing_) { lastActivity_ = now; finishBinary(); return; }
    if (sending_) {
        const auto capacity = client_.availableForWrite(); if (capacity <= 0) return;
        const char* source; std::size_t remaining;
        if (sent_ < responseHeaderSize_) { source = responseHeaders_.data()+sent_; remaining = responseHeaderSize_-sent_; }
        else { source = response_.body.data()+sent_-responseHeaderSize_; remaining = response_.bodySize-(sent_-responseHeaderSize_); }
        if (!remaining) { close(); return; }
        const auto count = std::min<std::size_t>({remaining,std::size_t(capacity),512});
        const auto written = client_.write(reinterpret_cast<const std::uint8_t*>(source),count);
        if (written) { sent_ += written; lastActivity_ = now; }
        return;
    }
    std::size_t budget = 512;
    while (budget && client_.available() && !readingBody_ && !sending_) {
        const char c = client_.read(); --budget; lastActivity_ = now;
        if (headerSize_ == headerBytes_.size()) { error(413,"payload_too_large","Request headers exceed 4096 bytes."); return; }
        headerBytes_[headerSize_++] = c;
        if (headerSize_ >= 4 && std::string_view(headerBytes_.data()+headerSize_-4,4) == "\r\n\r\n") headersComplete();
    }
    if (!readingBody_ || sending_ || !budget) return;
    const auto count = std::min<std::size_t>({budget,std::size_t(client_.available()),std::size_t(headers_.contentLength-received_)});
    if (!count) return;
    const auto bytes = client_.read(chunk_.data(),count);
    if (bytes <= 0) return;
    lastActivity_ = now;
    if (binary_) {
        if (!transfer_.append(chunk_.data(),bytes)) { error(500,"internal_error","The staged upload could not be written."); return; }
    } else memcpy(body_.get()+received_,chunk_.data(),bytes);
    received_ += bytes;
    if (received_ == headers_.contentLength) bodyComplete();
}
} // namespace neonbyte
#endif
