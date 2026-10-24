import Foundation

actor HostContainerRuntimeSetup {
    static let shared = HostContainerRuntimeSetup()
    private var attempt: Task<Void, Error>?

    func prepare() async throws {
        if let attempt { return try await attempt.value }
        let task = Task.detached {
            let home = FileManager.default.homeDirectoryForCurrentUser
            let instance = LocalHostInstance(homeDirectory: home)
            let control = instance.controlTool
            let errorURL = FileManager.default.temporaryDirectory.appending(path: "aru-container-\(UUID().uuidString).log")
            FileManager.default.createFile(atPath: errorURL.path, contents: nil)
            defer { try? FileManager.default.removeItem(at: errorURL) }
            let errors = try FileHandle(forWritingTo: errorURL)
            defer { try? errors.close() }
            let process = Process()
            process.executableURL = URL(filePath: "/bin/bash")
            process.arguments = [control.path, "--instance", instance.name, "setup-runtime"]
            process.standardOutput = FileHandle.nullDevice
            process.standardError = errors
            try process.run()
            process.waitUntilExit()
            guard process.terminationStatus == 0 else {
                let detail = try? String(contentsOf: errorURL, encoding: .utf8)
                throw HostCoreInstallationError.commandFailed(detail)
            }

        }
        attempt = task
        defer { attempt = nil }
        try await task.value
    }
}
