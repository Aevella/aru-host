import Foundation
import Observation

/// Owns conversation projections and mutation admission. The connection supplies
/// authenticated bytes; no credentials or durable Host truth are copied here.
@MainActor @Observable
final class HostConsoleConversations {
    private(set) var collaboratorConversations: [String: [HostCollaboratorConversation]] = [:]
    private(set) var collaboratorConversationDetails: [String: HostCollaboratorConversation] = [:]
    private(set) var mutatingConversationIds: Set<String> = []
    private let load: (String, String, Data?) async throws -> Data
    private let didUpdate: () -> Void
    private var generation = 0

    init(load: @escaping (String, String, Data?) async throws -> Data,
         didUpdate: @escaping () -> Void = {}) {
        self.load = load
        self.didUpdate = didUpdate
    }

    func clear() {
        generation += 1
        collaboratorConversations = [:]
        collaboratorConversationDetails = [:]
        mutatingConversationIds = []
    }

    private func request<Response: Decodable>(_ path: String, method: String = "GET",
        body: Data? = nil) async throws -> Response {
        let epoch = generation
        let data = try await load(path, method, body)
        guard epoch == generation else { throw CancellationError() }
        return try JSONDecoder().decode(Response.self, from: data)
    }

    func refreshConversations(collaboratorId: String) async throws {
        let epoch = generation
        let inventory: HostCollaboratorConversationInventory = try await request(
            "/aru/v1/hosted-collaborators/\(collaboratorId)/conversations")
        guard epoch == generation else { throw CancellationError() }
        guard inventory.schema == "aru.selfhost.collaborator-conversation-inventory.v1",
              inventory.collaboratorId == collaboratorId else {
            throw HostConsoleModelError.invalidCollaboratorSchema
        }
        if collaboratorConversations[collaboratorId] != inventory.conversations {
            collaboratorConversations[collaboratorId] = inventory.conversations
        }
        didUpdate()
    }

    func createConversation(collaboratorId: String) async throws -> HostCollaboratorConversation {
        let epoch = generation
        let body = try JSONEncoder().encode(CreateHostCollaboratorConversationBody(title: nil))
        let created: HostCollaboratorConversation = try await request(
            "/aru/v1/hosted-collaborators/\(collaboratorId)/conversations",
            method: "POST",
            body: body)
        try await refreshConversations(collaboratorId: collaboratorId)
        guard epoch == generation else { throw CancellationError() }
        collaboratorConversationDetails[created.conversationId] = created
        return created
    }

    func conversationDetail(
        collaboratorId: String,
        conversationId: String
    ) async throws -> HostCollaboratorConversation {
        let epoch = generation
        let detail: HostCollaboratorConversation = try await request(
            "/aru/v1/hosted-collaborators/\(collaboratorId)/conversations/\(conversationId)")
        guard epoch == generation else { throw CancellationError() }
        collaboratorConversationDetails[conversationId] = detail
        mergeConversationProjection(detail)
        return detail
    }

    func sendConversationMessage(
        collaboratorId: String,
        conversationId: String,
        text: String
    ) async throws -> HostCollaboratorConversation {
        guard !mutatingConversationIds.contains(conversationId) else {
            throw HostConsoleHTTPError.server(L10n.conversationMutationInProgress)
        }
        let mutationGeneration = generation
        mutatingConversationIds.insert(conversationId)
        defer { if generation == mutationGeneration { mutatingConversationIds.remove(conversationId) } }
        let epoch = generation
        let body = try JSONEncoder().encode(SendHostCollaboratorConversationMessageBody(
            clientRequestId: "console_\(UUID().uuidString)",
            text: text.trimmingCharacters(in: .whitespacesAndNewlines)))
        let detail: HostCollaboratorConversation = try await request(
            "/aru/v1/hosted-collaborators/\(collaboratorId)/conversations/\(conversationId)/messages",
            method: "POST",
            body: body)
        guard epoch == generation else { throw CancellationError() }
        collaboratorConversationDetails[conversationId] = detail
        mergeConversationProjection(detail)
        return detail
    }

    func resolveConversationApproval(
        collaboratorId: String,
        conversationId: String,
        approvalId: String,
        decision: String
    ) async throws -> HostCollaboratorConversation {
        guard !mutatingConversationIds.contains(conversationId) else { return try await conversationDetail(
            collaboratorId: collaboratorId, conversationId: conversationId) }
        let mutationGeneration = generation
        mutatingConversationIds.insert(conversationId)
        defer { if generation == mutationGeneration { mutatingConversationIds.remove(conversationId) } }
        let epoch = generation
        let body = try JSONEncoder().encode(ResolveHostCollaboratorConversationApprovalBody(
            decision: decision))
        let detail: HostCollaboratorConversation = try await request(
            "/aru/v1/hosted-collaborators/\(collaboratorId)/conversations/\(conversationId)/approvals/\(approvalId)",
            method: "POST",
            body: body)
        guard epoch == generation else { throw CancellationError() }
        collaboratorConversationDetails[conversationId] = detail
        mergeConversationProjection(detail)
        return detail
    }

    func cancelConversationTurn(
        collaboratorId: String,
        conversationId: String,
        turnId: String
    ) async throws -> HostCollaboratorConversation {
        guard !mutatingConversationIds.contains(conversationId) else { return try await conversationDetail(
            collaboratorId: collaboratorId, conversationId: conversationId) }
        let mutationGeneration = generation
        mutatingConversationIds.insert(conversationId)
        defer { if generation == mutationGeneration { mutatingConversationIds.remove(conversationId) } }
        let epoch = generation
        let detail: HostCollaboratorConversation = try await request(
            "/aru/v1/hosted-collaborators/\(collaboratorId)/conversations/\(conversationId)/turns/\(turnId)/cancel",
            method: "POST")
        guard epoch == generation else { throw CancellationError() }
        collaboratorConversationDetails[conversationId] = detail
        mergeConversationProjection(detail)
        return detail
    }

    private func mergeConversationProjection(_ detail: HostCollaboratorConversation) {
        var items = collaboratorConversations[detail.collaboratorId] ?? []
        if let index = items.firstIndex(where: { $0.id == detail.id }) {
            items[index] = detail
        } else {
            items.append(detail)
        }
        collaboratorConversations[detail.collaboratorId] = items.sorted { $0.updatedAt > $1.updatedAt }
        didUpdate()
    }

}
