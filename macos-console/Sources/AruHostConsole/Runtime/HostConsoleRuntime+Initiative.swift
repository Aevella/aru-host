import Foundation

@MainActor
extension HostConsoleRuntime {
    func refreshInitiative(collaboratorId: String) async throws {
        let value: HostCollaboratorInitiative = try await request(
            initiativeRoot(collaboratorId), authenticated: true)
        try acceptInitiative(value, collaboratorId: collaboratorId)
    }

    @discardableResult
    func createInitiativeRule(collaboratorId: String,
                              title: String,
                              goal: String,
                              instructions: String,
                              fireAfterMinutes: Int,
                              recurrenceMinutes: Int?,
                              notificationsEnabled: Bool) async throws -> HostCollaboratorInitiative {
        let current = try await initiativeForMutation(collaboratorId)
        return try await mutateInitiative(
            collaboratorId: collaboratorId,
            path: initiativeRoot(collaboratorId),
            method: "POST",
            body: CreateHostCollaboratorInitiativeRuleBody(
                expectedRevision: current.revision,
                title: title,
                goal: goal,
                instructions: instructions,
                nextFireAt: Int64(Date().timeIntervalSince1970 * 1_000)
                    + Int64(fireAfterMinutes) * 60_000,
                recurrenceMinutes: recurrenceMinutes,
                notificationsEnabled: notificationsEnabled,
                enabled: true))
    }

    @discardableResult
    func setInitiativeRuleEnabled(_ enabled: Bool,
                                  collaboratorId: String,
                                  ruleId: String) async throws -> HostCollaboratorInitiative {
        let current = try await initiativeForMutation(collaboratorId)
        return try await mutateInitiative(
            collaboratorId: collaboratorId,
            path: "\(initiativeRoot(collaboratorId))/rules/\(ruleId)",
            method: "PUT",
            body: UpdateHostCollaboratorInitiativeRuleBody(
                expectedRevision: current.revision, enabled: enabled))
    }

    @discardableResult
    func runInitiativeRule(collaboratorId: String,
                           ruleId: String) async throws -> HostCollaboratorInitiative {
        try await mutateInitiativeAction(collaboratorId: collaboratorId,
                                         ruleId: ruleId,
                                         action: "run")
    }

    @discardableResult
    func archiveInitiativeRule(collaboratorId: String,
                               ruleId: String) async throws -> HostCollaboratorInitiative {
        try await mutateInitiativeAction(collaboratorId: collaboratorId,
                                         ruleId: ruleId,
                                         action: "archive")
    }

    private func initiativeRoot(_ collaboratorId: String) -> String {
        "/aru/v1/hosted-collaborators/\(collaboratorId)/initiative"
    }

    private func initiativeForMutation(_ collaboratorId: String) async throws -> HostCollaboratorInitiative {
        if let current = collaboratorInitiatives[collaboratorId] { return current }
        try await refreshInitiative(collaboratorId: collaboratorId)
        guard let current = collaboratorInitiatives[collaboratorId] else {
            throw HostConsoleModelError.invalidCollaboratorSchema
        }
        return current
    }

    private func mutateInitiativeAction(collaboratorId: String,
                                        ruleId: String,
                                        action: String) async throws -> HostCollaboratorInitiative {
        let current = try await initiativeForMutation(collaboratorId)
        return try await mutateInitiative(
            collaboratorId: collaboratorId,
            path: "\(initiativeRoot(collaboratorId))/rules/\(ruleId)/\(action)",
            method: "POST",
            body: MutateHostCollaboratorInitiativeRuleBody(expectedRevision: current.revision))
    }

    private func mutateInitiative<Body: Encodable>(collaboratorId: String,
                                                    path: String,
                                                    method: String,
                                                    body: Body) async throws -> HostCollaboratorInitiative {
        guard !mutatingInitiativeIds.contains(collaboratorId) else {
            throw HostConsoleHTTPError.server(L10n.initiativeMutationInProgress)
        }
        mutatingInitiativeIds.insert(collaboratorId)
        defer { mutatingInitiativeIds.remove(collaboratorId) }
        let data = try JSONEncoder().encode(body)
        let value: HostCollaboratorInitiative = try await request(
            path, method: method, body: data, authenticated: true)
        try acceptInitiative(value, collaboratorId: collaboratorId)
        return value
    }

    private func acceptInitiative(_ value: HostCollaboratorInitiative,
                                  collaboratorId: String) throws {
        guard value.schema == "aru.selfhost.collaborator-initiative.v1",
              value.collaboratorId == collaboratorId else {
            throw HostConsoleModelError.invalidCollaboratorSchema
        }
        collaboratorInitiatives[collaboratorId] = value
    }
}
