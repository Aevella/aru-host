import Foundation

struct HostContainerDiagnostics: Decodable, Sendable {
    struct Failure: Decodable, Sendable {
        let stage: String
        let executable: String
        let image: String?
        let detail: String
    }
    let status: String
    let failure: Failure?
}

/// Preparation and service-side readiness are distinct receipts. The Console
/// waits through restart, but reports Core failure without rerunning installation.
@MainActor
enum HostContainerReadiness {
    static func wait(
        timeout: Duration = .seconds(240), interval: Duration = .milliseconds(500),
        readManifest: () async throws -> HostManifest,
        readDiagnostics: () async throws -> HostContainerDiagnostics
    ) async throws {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: timeout)
        var failureMessage: String?
        while clock.now < deadline {
            try Task.checkCancellation()
            let manifest: HostManifest?
            do { manifest = try await readManifest() }
            catch is CancellationError { throw CancellationError() }
            catch { manifest = nil } // Expected while the service restarts.
            try Task.checkCancellation()
            if let capability = manifest?.capabilities["workspace-runtime"] {
                if capability.enabled { return }
                if capability.readiness?.status == "failed" {
                    failureMessage = capability.readiness?.message
                    break
                }
            }
            try await Task.sleep(for: min(interval, clock.now.duration(to: deadline)))
        }
        var message = failureMessage ?? L10n.containerReadinessPending
        do {
            let diagnostics = try await readDiagnostics()
            if let failure = diagnostics.failure {
                message += "\n\(failure.stage): \(failure.executable)"
                if let image = failure.image { message += "\n\(image)" }
                message += "\n\(failure.detail)"
            } else if diagnostics.status == "unconfigured" {
                message += "\n" + L10n.containerReadinessUnconfigured
            }
        } catch is CancellationError { throw CancellationError() }
        catch { /* Older Hosts may not expose diagnostics; retain the primary failure. */ }
        throw HostConsoleHTTPError.server(message)
    }
}

extension HostConsoleRuntime {
    func prepareContainerRuntime() async throws {
        let serverId = manifest?.serverId
        try await HostContainerRuntimeSetup.shared.prepare()
        try await HostContainerReadiness.wait(readManifest: {
            let current: HostManifest = try await self.request("/.well-known/aru.json")
            guard serverId == nil || current.serverId == serverId else { throw CancellationError() }
            return current
        }, readDiagnostics: {
            try await self.request("/aru/v1/container-runtime", authenticated: true)
        })
    }
}
