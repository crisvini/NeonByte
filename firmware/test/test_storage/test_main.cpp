#include <unity.h>
#include "neonbyte/storage_mount.h"
#include <string>

using namespace neonbyte;
namespace {
struct FakeLittleFs {
    std::string calls;
    bool mountOk = true, namespaceOk = true;
    bool autoFormatDisabled = false;
    void disableAutoFormat() { autoFormatDisabled = true; calls += 'A'; }
    bool mount() { calls += 'M'; return mountOk; }
    bool ensureNamespace() { calls += 'D'; return namespaceOk; }
    void cleanupTemporaryFiles() { calls += 'R'; }
};

void testConfigurationMountDoesNotCreateOrCleanStoragePaths() {
    StorageMountState state;
    FakeLittleFs filesystem;
    TEST_ASSERT_TRUE(mountFilesystemForConfiguration(state,filesystem));
    TEST_ASSERT_TRUE(filesystem.autoFormatDisabled);
    TEST_ASSERT_EQUAL_STRING("AM",filesystem.calls.c_str());
    TEST_ASSERT_TRUE(state.mounted);
    TEST_ASSERT_FALSE(state.prepared);
    TEST_ASSERT_TRUE(mountFilesystemForConfiguration(state,filesystem));
    TEST_ASSERT_EQUAL_STRING("AM",filesystem.calls.c_str());
}

void testExplicitPreparationReusesMountThenCreatesNamespaceAndCleansTemporaryFiles() {
    StorageMountState state;
    FakeLittleFs filesystem;
    TEST_ASSERT_TRUE(mountFilesystemForConfiguration(state,filesystem));
    TEST_ASSERT_TRUE(prepareFilesystem(state,filesystem));
    TEST_ASSERT_EQUAL_STRING("AMDR",filesystem.calls.c_str());
    TEST_ASSERT_TRUE(state.mounted);
    TEST_ASSERT_TRUE(state.prepared);
    TEST_ASSERT_TRUE(prepareFilesystem(state,filesystem));
    TEST_ASSERT_EQUAL_STRING("AMDR",filesystem.calls.c_str());
}

void testFailedPreparationCanRetryWithoutRemountingOrFormatting() {
    StorageMountState state;
    FakeLittleFs filesystem;
    filesystem.namespaceOk = false;
    TEST_ASSERT_FALSE(prepareFilesystem(state,filesystem));
    TEST_ASSERT_EQUAL_STRING("AMD",filesystem.calls.c_str());
    TEST_ASSERT_TRUE(state.mounted);
    TEST_ASSERT_FALSE(state.prepared);

    filesystem.namespaceOk = true;
    TEST_ASSERT_TRUE(prepareFilesystem(state,filesystem));
    TEST_ASSERT_EQUAL_STRING("AMDDR",filesystem.calls.c_str());
    TEST_ASSERT_TRUE(state.prepared);
}

void testMountFailureDoesNotCreateOrCleanPaths() {
    StorageMountState state;
    FakeLittleFs filesystem;
    filesystem.mountOk = false;
    TEST_ASSERT_FALSE(prepareFilesystem(state,filesystem));
    TEST_ASSERT_EQUAL_STRING("AM",filesystem.calls.c_str());
    TEST_ASSERT_FALSE(state.mounted);
    TEST_ASSERT_FALSE(state.prepared);
}
}

void setUp() {}
void tearDown() {}
int main(int, char**) {
    UNITY_BEGIN();
    RUN_TEST(testConfigurationMountDoesNotCreateOrCleanStoragePaths);
    RUN_TEST(testExplicitPreparationReusesMountThenCreatesNamespaceAndCleansTemporaryFiles);
    RUN_TEST(testFailedPreparationCanRetryWithoutRemountingOrFormatting);
    RUN_TEST(testMountFailureDoesNotCreateOrCleanPaths);
    return UNITY_END();
}
