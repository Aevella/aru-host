import Foundation

enum HostCoreCommand {
    static func run(executable: URL, arguments: [String]) async throws {
        try await Task.detached {
            // File-backed stderr avoids deadlocking a verbose installer on a
            // full pipe while the parent waits for process termination.
            let errorURL = FileManager.default.temporaryDirectory.appending(path: "aru-core-\(UUID().uuidString).log")
            FileManager.default.createFile(atPath: errorURL.path, contents: nil, attributes: [.posixPermissions: 0o600])
            defer { try? FileManager.default.removeItem(at: errorURL) }
            let errors = try FileHandle(forWritingTo: errorURL)
            defer { try? errors.close() }
            let process = Process()
            process.executableURL = executable
            process.arguments = arguments
            process.standardOutput = FileHandle.nullDevice
            process.standardError = errors
            try process.run()
            process.waitUntilExit()
            guard process.terminationStatus == 0 else {
                let detail = try? String(contentsOf: errorURL, encoding: .utf8)
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                throw HostCoreInstallationError.commandFailed(detail)
            }
        }.value
    }
}
