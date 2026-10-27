#include "neonbyte/esp8266/http_server.h"
#include "neonbyte/esp8266/display.h"
extern "C" {
unsigned char probeStartup[sizeof(neonbyte::SafeStartup)];
unsigned char probeScene[sizeof(neonbyte::SceneManager)];
unsigned char probeProtocol[sizeof(neonbyte::ProtocolHandler)];
unsigned char probeHttp[sizeof(neonbyte::DeviceHttpServer)];
unsigned char probeDisplay[sizeof(neonbyte::DeviceDisplay)];
unsigned char probeStorage[sizeof(neonbyte::PersistentStorage)];
unsigned char probeAuthenticator[sizeof(neonbyte::BearerTokenAuthenticator)];
unsigned char probeConfiguration[sizeof(neonbyte::DeviceConfiguration)];
unsigned char probeHashJob[sizeof(neonbyte::HashJob)];
unsigned char probeFileSource[sizeof(neonbyte::FileSource)];
}
