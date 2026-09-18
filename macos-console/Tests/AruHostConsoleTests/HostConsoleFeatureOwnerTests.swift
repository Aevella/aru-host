import Foundation
import Testing
@testable import AruHostConsole

@MainActor
struct HostConsoleFeatureOwnerTests {
    func inventory(_ owner: String) -> Data {
        Data("{\"schema\":\"aru.selfhost.collaborator-conversation-inventory.v1\",\"collaboratorId\":\"\(owner)\",\"conversations\":[]}".utf8)
    }

    @Test func conversationsHaveIndependentProjectionAndRejectLateSession() async throws {
        var pending: CheckedContinuation<Data, any Error>?
        let first = HostConsoleConversations(load: { _, _, _ in
            try await withCheckedThrowingContinuation { pending = $0 }
        })
        let second = HostConsoleConversations(load: { _, _, _ in inventory("second") })
        let task = Task { try await first.refreshConversations(collaboratorId: "first") }
        for _ in 0..<100 where pending == nil { await Task.yield() }
        let response = try #require(pending)
        try await second.refreshConversations(collaboratorId: "second")
        #expect(second.collaboratorConversations["second"] == [])
        first.clear()
        response.resume(returning: inventory("first"))
        await #expect(throws: CancellationError.self) { try await task.value }
        #expect(first.collaboratorConversations.isEmpty)
        #expect(second.collaboratorConversations["second"] == [])
    }

    @Test func surfaceReadFailureDoesNotBecomeEmptySuccess() async throws {
        let surfaces = HostConsoleSurfaces(load: { _, _, _ in throw URLError(.notConnectedToInternet) })
        await #expect(throws: URLError.self) { try await surfaces.refreshSurfaces(collaboratorId: "owner") }
        #expect(surfaces.collaboratorSurfaces["owner"] == nil)
    }
}
