import Foundation
import Synchronization
import Testing
@testable import AruHostConsole

@Test @MainActor func collaboratorDeletionStaysRemovedAcrossRefreshAndReopen() async throws {
    DeletionDirectoryProtocol.state.withLock { $0 = .init() }
    func makeRuntime() -> HostConsoleRuntime {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [DeletionDirectoryProtocol.self]
        return HostConsoleRuntime(session: URLSession(configuration: configuration),
                                  baseURL: URL(string: "http://aru-host.test")!)
    }
    let runtime = makeRuntime()
    await runtime.refresh(.collaborators)
    #expect(runtime.sectionErrors[.collaborators] == nil)
    #expect(runtime.collaborators.count == 2)
    let selected = try #require(runtime.collaborators.first { $0.id == "hostcol_aa" })
    try await runtime.deleteCollaborator(selected)
    #expect(runtime.collaborators.map(\.id) == ["hostcol_bb"])
    await runtime.refresh(.collaborators)
    #expect(runtime.sectionErrors[.collaborators] == nil)
    #expect(runtime.collaborators.map(\.id) == ["hostcol_bb"])
    // A lost receipt can be retried without reviving the row.
    try await runtime.deleteCollaborator(selected)
    let reopened = makeRuntime()
    await reopened.refresh(.collaborators)
    #expect(reopened.sectionErrors[.collaborators] == nil)
    #expect(reopened.collaborators.map(\.id) == ["hostcol_bb"])
    let state = DeletionDirectoryProtocol.state.withLock { $0 }
    #expect(state.deleted)
    #expect(state.rejectedReads.isEmpty)
    #expect(state.liveReads.contains("/aru/v1/hosted-collaborators/hostcol_bb/cognition"))
}

private final class DeletionDirectoryProtocol: URLProtocol, @unchecked Sendable {
    struct State {
        var deleted = false
        var rejectedReads: [String] = []
        var liveReads: [String] = []
    }
    static let state = Mutex(State())
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}
    override func startLoading() {
        let path = request.url!.path
        let (status, body): (Int, [String: Any]) = Self.state.withLock { state in
            func collaborator(_ id: String, archived: Bool) -> [String: Any] {
                var row: [String: Any] = ["collaboratorId": id, "displayName": "Example", "driverId": "codex",
                    "revision": archived ? 2 : 1, "activationStatus": "driver-ready", "turnExecution": true,
                    "toolAccess": ["schema": "aru.selfhost.collaborator-tool-access.v1", "mode": "all", "toolNames": []]]
                if archived { row["archivedAt"] = 123 }
                return row
            }
            if path == "/aru/v1/agent-drivers" {
                return (200, ["schema": "aru.selfhost.agent-driver-inventory.v1", "drivers": [],
                              "execution": ["enabled": true, "status": "ready"]])
            }
            if path == "/aru/v1/hosted-collaborators" {
                return (200, ["schema": "aru.selfhost.hosted-collaborator-inventory.v1",
                              "collaborators": [collaborator("hostcol_aa", archived: state.deleted), collaborator("hostcol_bb", archived: false)]])
            }
            if request.httpMethod == "DELETE", path.hasSuffix("/hostcol_aa") {
                state.deleted = true
                return (200, collaborator("hostcol_aa", archived: true))
            }
            if state.deleted && path.contains("/hostcol_aa/") {
                state.rejectedReads.append(path)
                return (404, ["error": "collaborator.unknown", "message": "unknown hosted collaborator"])
            }
            state.liveReads.append(path)
            let id = path.components(separatedBy: "/")[4]
            if path.hasSuffix("/surfaces") {
                return (200, ["schema": "aru.selfhost.collaborator-surface-inventory.v1", "collaboratorId": id, "surfaces": []])
            }
            if path.hasSuffix("/conversations") {
                return (200, ["schema": "aru.selfhost.collaborator-conversation-inventory.v1", "collaboratorId": id, "conversations": []])
            }
            if path.hasSuffix("/cognition") {
                return (200, ["schema": "aru.selfhost.collaborator-cognition.v1", "collaboratorId": id,
                              "revision": 1, "instructionEnvironment": "isolated", "systemPrompt": "",
                              "memories": [], "references": [], "createdAt": 1, "updatedAt": 1])
            }
            return (404, ["message": "Unexpected fixture request"])
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: try! JSONSerialization.data(withJSONObject: body))
        client?.urlProtocolDidFinishLoading(self)
    }
}
