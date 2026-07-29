import SwiftUI

struct CollaboratorCognitionStudioView: View {
    let runtime: HostConsoleRuntime
    let collaborator: HostedCollaborator

    @State private var environment = HostCollaboratorInstructionEnvironment.isolated
    @State private var systemPrompt = ""
    @State private var errorMessage: String?
    @State private var saved = false
    @State private var draft: CognitionDraft?

    fileprivate struct CognitionDraft: Identifiable {
        let id = UUID()
        var kind: HostCollaboratorCognitionRecordKind
        var recordId: String?
        var title: String
        var content: String
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                identitySection
                promptSection
                HStack(alignment: .top, spacing: 16) {
                    recordSection(kind: .memories)
                    recordSection(kind: .references)
                }
                if let errorMessage {
                    Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                        .font(.system(size: 11, design: .rounded))
                        .foregroundStyle(HostPalette.rose)
                }
            }
            .padding(20)
        }
        .task { await refresh() }
        .sheet(item: $draft) { value in
            cognitionEditor(value)
        }
    }

    private var identitySection: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Label(L10n.cognitionEnvironment, systemImage: "person.text.rectangle")
                    .font(.system(size: 14, weight: .semibold, design: .rounded))
                    .foregroundStyle(HostPalette.ink)
                Spacer()
                Text(environment == .isolated ? L10n.cognitionIsolated : L10n.cognitionInheritCodex)
                    .font(.system(size: 10.5, weight: .semibold, design: .rounded))
                    .foregroundStyle(HostPalette.lavenderDeep)
            }
            Picker(L10n.cognitionEnvironment, selection: $environment) {
                Text(L10n.cognitionIsolated).tag(HostCollaboratorInstructionEnvironment.isolated)
                Text(L10n.cognitionInheritCodex).tag(HostCollaboratorInstructionEnvironment.inheritCodex)
            }
            .pickerStyle(.segmented)
            Text(environment == .isolated
                 ? L10n.cognitionIsolatedDetail
                 : L10n.cognitionInheritCodexDetail)
                .font(.system(size: 11, design: .rounded))
                .foregroundStyle(HostPalette.secondaryInk.opacity(0.68))
        }
        .padding(16)
        .background(studioCard)
    }

    private var promptSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text(L10n.cognitionSystemPrompt)
                        .font(.system(size: 14, weight: .semibold, design: .rounded))
                        .foregroundStyle(HostPalette.ink)
                    Text(L10n.cognitionSystemPromptDetail)
                        .font(.system(size: 10.5, design: .rounded))
                        .foregroundStyle(HostPalette.secondaryInk.opacity(0.62))
                }
                Spacer()
                Button {
                    Task { await saveSettings() }
                } label: {
                    HStack(spacing: 7) {
                        if isMutating { ProgressView().controlSize(.small) }
                        Image(systemName: saved ? "checkmark" : "square.and.arrow.down")
                        Text(saved ? L10n.cognitionSaved : L10n.save)
                    }
                }
                .buttonStyle(FloatingGlassButtonStyle(tint: HostPalette.lavender.opacity(0.24)))
                .disabled(isMutating || !hasSettingsChanges)
            }
            TextEditor(text: $systemPrompt)
                .font(.system(size: 12.5, design: .rounded))
                .scrollContentBackground(.hidden)
                .frame(minHeight: 190)
                .padding(12)
                .background(Color.white.opacity(0.42),
                            in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 16).stroke(Color.white.opacity(0.58)))
        }
        .padding(16)
        .background(studioCard)
    }

    private func recordSection(kind: HostCollaboratorCognitionRecordKind) -> some View {
        let rows = records(kind: kind)
        return VStack(alignment: .leading, spacing: 10) {
            HStack {
                Label(kind == .memories ? L10n.cognitionMemories : L10n.cognitionReferences,
                      systemImage: kind == .memories ? "sparkles" : "doc.text")
                    .font(.system(size: 14, weight: .semibold, design: .rounded))
                    .foregroundStyle(HostPalette.ink)
                Spacer()
                Button {
                    draft = CognitionDraft(kind: kind, recordId: nil, title: "", content: "")
                } label: {
                    Image(systemName: "plus")
                }
                .buttonStyle(FloatingGlassButtonStyle())
            }
            if rows.isEmpty {
                Text(kind == .memories ? L10n.cognitionMemoriesEmpty : L10n.cognitionReferencesEmpty)
                    .font(.system(size: 11, design: .rounded))
                    .foregroundStyle(HostPalette.secondaryInk.opacity(0.62))
                    .frame(maxWidth: .infinity, minHeight: 90, alignment: .center)
            } else {
                ForEach(rows) { row in
                    HStack(alignment: .top, spacing: 10) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(row.title)
                                .font(.system(size: 12.5, weight: .semibold, design: .rounded))
                                .foregroundStyle(HostPalette.ink)
                            Text(row.content)
                                .font(.system(size: 10.5, design: .rounded))
                                .foregroundStyle(HostPalette.secondaryInk.opacity(0.68))
                                .lineLimit(3)
                        }
                        Spacer()
                        Menu {
                            if !row.archived {
                                Button(L10n.edit) {
                                    draft = CognitionDraft(kind: kind, recordId: row.id,
                                                           title: row.title, content: row.content)
                                }
                            }
                            Button(row.archived ? L10n.restore : L10n.archive) {
                                Task { await setArchived(!row.archived, row: row) }
                            }
                        } label: {
                            Image(systemName: "ellipsis")
                        }
                        .menuStyle(.borderlessButton)
                    }
                    .padding(11)
                    .background(Color.white.opacity(row.archived ? 0.18 : 0.34),
                                in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                }
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .background(studioCard)
    }

    private struct RecordRow: Identifiable {
        var id: String
        var title: String
        var content: String
        var archived: Bool
        var kind: HostCollaboratorCognitionRecordKind
    }

    private func records(kind: HostCollaboratorCognitionRecordKind) -> [RecordRow] {
        guard let cognition else { return [] }
        let values: [RecordRow]
        switch kind {
        case .memories:
            values = cognition.memories.map {
                RecordRow(id: $0.memoryId, title: $0.title, content: $0.content,
                          archived: $0.isArchived, kind: .memories)
            }
        case .references:
            values = cognition.references.map {
                RecordRow(id: $0.referenceId, title: $0.title, content: $0.content,
                          archived: $0.isArchived, kind: .references)
            }
        }
        return values.sorted {
            if $0.archived != $1.archived { return !$0.archived }
            return $0.title.localizedStandardCompare($1.title) == .orderedAscending
        }
    }

    private func cognitionEditor(_ initial: CognitionDraft) -> some View {
        CognitionRecordEditor(
            initial: initial,
            save: { value in await saveRecord(value) },
            cancel: { draft = nil })
    }

    private func refresh() async {
        do {
            try await runtime.refreshCognition(collaboratorId: collaborator.id)
            seed()
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func seed() {
        guard let cognition else { return }
        environment = cognition.instructionEnvironment
        systemPrompt = cognition.systemPrompt
        saved = false
    }

    private func saveSettings() async {
        do {
            _ = try await runtime.updateCognition(
                collaboratorId: collaborator.id,
                instructionEnvironment: environment,
                systemPrompt: systemPrompt)
            seed()
            saved = true
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func saveRecord(_ value: CognitionDraft) async {
        do {
            _ = try await runtime.saveCognitionRecord(
                collaboratorId: collaborator.id,
                kind: value.kind,
                recordId: value.recordId,
                title: value.title,
                content: value.content)
            draft = nil
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func setArchived(_ archived: Bool, row: RecordRow) async {
        do {
            _ = try await runtime.setCognitionRecordArchived(
                archived,
                collaboratorId: collaborator.id,
                kind: row.kind,
                recordId: row.id)
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private var cognition: HostCollaboratorCognition? {
        runtime.collaboratorCognitions[collaborator.id]
    }

    private var isMutating: Bool { runtime.mutatingCognitionIds.contains(collaborator.id) }
    private var hasSettingsChanges: Bool {
        guard let cognition else { return false }
        return environment != cognition.instructionEnvironment || systemPrompt != cognition.systemPrompt
    }

    private var studioCard: some View {
        RoundedRectangle(cornerRadius: 20, style: .continuous)
            .fill(Color.white.opacity(0.22))
            .overlay(RoundedRectangle(cornerRadius: 20).stroke(Color.white.opacity(0.52), lineWidth: 0.7))
    }
}

private struct CognitionRecordEditor: View {
    let initial: CollaboratorCognitionStudioView.CognitionDraft
    let save: (CollaboratorCognitionStudioView.CognitionDraft) async -> Void
    let cancel: () -> Void

    @State private var value: CollaboratorCognitionStudioView.CognitionDraft

    init(initial: CollaboratorCognitionStudioView.CognitionDraft,
         save: @escaping (CollaboratorCognitionStudioView.CognitionDraft) async -> Void,
         cancel: @escaping () -> Void) {
        self.initial = initial
        self.save = save
        self.cancel = cancel
        _value = State(initialValue: initial)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(value.kind == .memories ? L10n.cognitionMemoryEditor : L10n.cognitionReferenceEditor)
                .font(.system(size: 21, weight: .light, design: .rounded))
            TextField(L10n.cognitionRecordTitle, text: $value.title)
                .textFieldStyle(.roundedBorder)
            TextEditor(text: $value.content)
                .font(.system(size: 12.5, design: .rounded))
                .frame(minHeight: 240)
                .padding(10)
                .background(Color.white.opacity(0.52),
                            in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            HStack {
                Spacer()
                Button(L10n.cancel, action: cancel)
                    .buttonStyle(FloatingGlassButtonStyle())
                Button(L10n.save) { Task { await save(value) } }
                    .buttonStyle(FloatingGlassButtonStyle(tint: HostPalette.lavender.opacity(0.28)))
                    .disabled(value.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                              || value.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(22)
        .frame(width: 560, height: 440)
        .background(BorrowedLightWeather())
    }
}
