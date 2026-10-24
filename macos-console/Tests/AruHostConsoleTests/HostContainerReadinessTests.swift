import Foundation
import Testing
@testable import AruHostConsole

@MainActor
struct HostContainerReadinessTests {
    private func manifest(_ status: String, enabled: Bool = false) throws -> HostManifest {
        try JSONDecoder().decode(HostManifest.self, from: Data("""
        {"schema":"test","serverId":"test-host","nodeKind":"host","displayName":"Test",
        "serverVersion":"test","capabilities":{"workspace-runtime":{"enabled":\(enabled),
        "readiness":{"status":"\(status)","message":"Background engine unavailable"}}}}
        """.utf8))
    }

    @Test func waitsThroughRestartAndCheckingWithoutReadingDiagnosticsOnSuccess() async throws {
        var reads = 0
        try await HostContainerReadiness.wait(interval: .milliseconds(1), readManifest: {
            reads += 1
            if reads == 1 { throw URLError(.cannotConnectToHost) }
            return try manifest(reads < 45 ? "checking" : "ready", enabled: reads >= 45)
        }, readDiagnostics: {
            Issue.record("Successful readiness must not fetch diagnostics")
            throw URLError(.unsupportedURL)
        })
        #expect(reads == 45)
    }

    @Test func failedCoreReportsStageAndDetailImmediatelyAndRetrySucceeds() async throws {
        var reads = 0
        do {
            try await HostContainerReadiness.wait(readManifest: {
                reads += 1
                return try manifest("failed")
            }, readDiagnostics: {
                HostContainerDiagnostics(status: "failed", failure: .init(
                    stage: "python", executable: "podman", image: "python:test", detail: "socket denied"))
            })
            Issue.record("Expected a Core failure")
        } catch {
            #expect(error.localizedDescription.contains("Background engine unavailable"))
            #expect(error.localizedDescription.contains("python: podman"))
            #expect(error.localizedDescription.contains("socket denied"))
        }
        #expect(reads == 1)
        try await HostContainerReadiness.wait(readManifest: { try manifest("ready", enabled: true) },
            readDiagnostics: { throw URLError(.unsupportedURL) })
    }

    @Test func timeoutDistinguishesUnconfiguredFromInstallationFailure() async throws {
        do {
            try await HostContainerReadiness.wait(timeout: .milliseconds(5), interval: .milliseconds(1),
                readManifest: { try manifest("unconfigured") },
                readDiagnostics: { .init(status: "unconfigured", failure: nil) })
            Issue.record("Expected readiness timeout")
        } catch {
            #expect(error.localizedDescription.contains(L10n.containerReadinessUnconfigured))
        }
    }

    @Test func cancellationDoesNotBecomeReadinessFailure() async throws {
        await #expect(throws: CancellationError.self) {
            try await HostContainerReadiness.wait(readManifest: { throw CancellationError() },
                readDiagnostics: { Issue.record("Cancelled attempts must not read diagnostics"); throw CancellationError() })
        }
    }
}
