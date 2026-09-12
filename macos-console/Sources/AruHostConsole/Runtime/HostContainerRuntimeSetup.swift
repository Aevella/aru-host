import Foundation

actor HostContainerRuntimeSetup {
    static let shared = HostContainerRuntimeSetup()
    private var attempt: Task<Void, Error>?

    func prepare() async throws {
        if let attempt { return try await attempt.value }
        let task = Task.detached {
            let home = FileManager.default.homeDirectoryForCurrentUser
            let control = home.appending(path: "Library/Application Support/Aru Self-Hosted/instances/home/current/aru-selfhostctl-macos")
            let errorURL = FileManager.default.temporaryDirectory.appending(path: "aru-container-\(UUID().uuidString).log")
            FileManager.default.createFile(atPath: errorURL.path, contents: nil)
            defer { try? FileManager.default.removeItem(at: errorURL) }
            let errors = try FileHandle(forWritingTo: errorURL)
            defer { try? errors.close() }
            let process = Process()
            process.executableURL = URL(filePath: "/bin/bash")
            process.arguments = [control.path, "--instance", "home", "setup-runtime"]
            process.standardOutput = FileHandle.nullDevice
            process.standardError = errors
            try process.run()
            process.waitUntilExit()
            guard process.terminationStatus == 0 else {
                let detail = try? String(contentsOf: errorURL, encoding: .utf8)
                throw HostCoreInstallationError.commandFailed(detail)
            }
            let manifestURL = LocalHostLocator.baseURL().appending(path: ".well-known/aru.json")
            for _ in 0..<40 {
                if let (data, response) = try? await URLSession.shared.data(from: manifestURL),
                   (response as? HTTPURLResponse)?.statusCode == 200,
                   let manifest = try? JSONDecoder().decode(HostManifest.self, from: data),
                   manifest.capabilities["workspace-runtime"]?.enabled == true {
                    return
                }
                try await Task.sleep(for: .milliseconds(500))
            }
            throw HostCoreInstallationError.commandFailed(L10n.containerSetupRestartPending)
        }
        attempt = task
        defer { attempt = nil }
        try await task.value
    }
}
