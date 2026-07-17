import Foundation

@MainActor
extension HostConsoleRuntime {
    func refreshCognition(collaboratorId: String) async throws {
        let value: HostCollaboratorCognition = try await request(
            "/aru/v1/hosted-collaborators/\(collaboratorId)/cognition",
            authenticated: true)
        guard value.schema == "aru.selfhost.collaborator-cognition.v1",
              value.collaboratorId == collaboratorId else {
            throw HostConsoleModelError.invalidCollaboratorSchema
        }
        collaboratorCognitions[collaboratorId] = value
    }

    @discardableResult
    func updateCognition(collaboratorId: String,
                         instructionEnvironment: HostCollaboratorInstructionEnvironment,
                         systemPrompt: String) async throws -> HostCollaboratorCognition {
        let current = try await cognitionForMutation(collaboratorId)
        return try await mutateCognition(
            collaboratorId: collaboratorId,
            path: "/aru/v1/hosted-collaborators/\(collaboratorId)/cognition",
            method: "PUT",
            body: UpdateHostCollaboratorCognitionBody(
                expectedRevision: current.revision,
                instructionEnvironment: instructionEnvironment,
                systemPrompt: systemPrompt))
    }

    @discardableResult
    func saveCognitionRecord(collaboratorId: String,
                             kind: HostCollaboratorCognitionRecordKind,
                             recordId: String?,
                             title: String,
                             content: String) async throws -> HostCollaboratorCognition {
        let current = try await cognitionForMutation(collaboratorId)
        let root = "/aru/v1/hosted-collaborators/\(collaboratorId)/cognition/\(kind.rawValue)"
        return try await mutateCognition(
            collaboratorId: collaboratorId,
            path: recordId.map { "\(root)/\($0)" } ?? root,
            method: recordId == nil ? "POST" : "PUT",
            body: MutateHostCollaboratorCognitionRecordBody(
                expectedRevision: current.revision,
                title: title,
                content: content))
    }

    @discardableResult
    func setCognitionRecordArchived(_ archived: Bool,
                                    collaboratorId: String,
                                    kind: HostCollaboratorCognitionRecordKind,
                                    recordId: String) async throws -> HostCollaboratorCognition {
        let current = try await cognitionForMutation(collaboratorId)
        let action = archived ? "archive" : "restore"
        return try await mutateCognition(
            collaboratorId: collaboratorId,
            path: "/aru/v1/hosted-collaborators/\(collaboratorId)/cognition/\(kind.rawValue)/\(recordId)/\(action)",
            method: "POST",
            body: ArchiveHostCollaboratorCognitionRecordBody(
                expectedRevision: current.revision))
    }

    private func cognitionForMutation(_ collaboratorId: String) async throws -> HostCollaboratorCognition {
        if let current = collaboratorCognitions[collaboratorId] { return current }
        try await refreshCognition(collaboratorId: collaboratorId)
        guard let current = collaboratorCognitions[collaboratorId] else {
            throw HostConsoleModelError.invalidCollaboratorSchema
        }
        return current
    }

    private func mutateCognition<Body: Encodable>(
        collaboratorId: String,
        path: String,
        method: String,
        body: Body
    ) async throws -> HostCollaboratorCognition {
        guard !mutatingCognitionIds.contains(collaboratorId) else {
            throw HostConsoleHTTPError.server(L10n.cognitionMutationInProgress)
        }
        mutatingCognitionIds.insert(collaboratorId)
        defer { mutatingCognitionIds.remove(collaboratorId) }
        let data = try JSONEncoder().encode(body)
        let value: HostCollaboratorCognition = try await request(
            path, method: method, body: data, authenticated: true)
        guard value.schema == "aru.selfhost.collaborator-cognition.v1",
              value.collaboratorId == collaboratorId else {
            throw HostConsoleModelError.invalidCollaboratorSchema
        }
        collaboratorCognitions[collaboratorId] = value
        return value
    }
}
