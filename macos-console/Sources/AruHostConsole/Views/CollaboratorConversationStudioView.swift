import SwiftUI

struct CollaboratorConversationStudioView: View {
    let runtime: HostConsoleRuntime
    let collaborator: HostedCollaborator

    @State private var selectedConversationId: String?
    @State private var draft = ""
    @State private var errorMessage: String?
    @State private var isCreating = false
    @State private var isRefreshing = false

    var body: some View {
        HStack(spacing: 0) {
            directory
                .frame(width: 286)
            Divider().overlay(Color.white.opacity(0.48))
            conversationPane
        }
        .task {
            var shouldSelectNewest = true
            while !Task.isCancelled {
                await refreshDirectory(selectNewestWhenNeeded: shouldSelectNewest)
                shouldSelectNewest = false
                try? await Task.sleep(for: .seconds(3))
            }
        }
        .task(id: selectedConversationId) {
            guard let selectedConversationId else { return }
            while !Task.isCancelled {
                await refreshDetail(selectedConversationId, reportError: false)
                let active = detail?.activeTurn?.isActive == true || detail?.pendingApprovalCount ?? 0 > 0
                try? await Task.sleep(for: .milliseconds(active ? 650 : 3_000))
            }
        }
    }

    private var directory: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text(L10n.conversations)
                        .font(.system(size: 15, weight: .semibold, design: .rounded))
                        .foregroundStyle(HostPalette.ink)
                    Text(L10n.hostConversationAuthority)
                        .font(.system(size: 10.5, design: .rounded))
                        .foregroundStyle(HostPalette.secondaryInk.opacity(0.58))
                }
                Spacer()
                Button {
                    Task { await createConversation() }
                } label: {
                    if isCreating { ProgressView().controlSize(.small) }
                    else { Image(systemName: "plus") }
                }
                .buttonStyle(StudioIconButtonStyle(tint: HostPalette.lavender.opacity(0.18)))
                .disabled(isCreating || !collaborator.turnExecution)
            }

            if conversations.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    Image(systemName: "bubble.left.and.bubble.right")
                        .font(.system(size: 25, weight: .light))
                        .foregroundStyle(HostPalette.lavender)
                    Text(L10n.noComputerConversations)
                        .font(.system(size: 13, weight: .semibold, design: .rounded))
                    Text(L10n.noComputerConversationsDetail)
                        .font(.system(size: 11, design: .rounded))
                        .foregroundStyle(HostPalette.secondaryInk.opacity(0.66))
                }
                .padding(.vertical, 18)
            } else {
                ScrollView {
                    LazyVStack(spacing: 8) {
                        ForEach(conversations) { conversation in
                            Button {
                                selectedConversationId = conversation.id
                            } label: {
                                conversationRow(conversation)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
            Spacer()
        }
        .padding(16)
        .background(Color.white.opacity(0.10))
    }

    private func conversationRow(_ conversation: HostCollaboratorConversation) -> some View {
        HStack(spacing: 10) {
            Circle()
                .fill(conversation.pendingApprovalCount > 0
                      ? HostPalette.amber.opacity(0.20)
                      : conversation.activeTurn?.isActive == true
                        ? HostPalette.lavender.opacity(0.18)
                        : Color.white.opacity(0.34))
                .frame(width: 34, height: 34)
                .overlay {
                    Image(systemName: conversation.pendingApprovalCount > 0
                          ? "checkmark.shield"
                          : conversation.activeTurn?.isActive == true ? "sparkles" : "bubble.left")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(conversation.pendingApprovalCount > 0
                                         ? HostPalette.amber : HostPalette.lavenderDeep)
                }
            VStack(alignment: .leading, spacing: 3) {
                Text(conversation.title)
                    .font(.system(size: 12.5, weight: .semibold, design: .rounded))
                    .foregroundStyle(HostPalette.ink)
                    .lineLimit(1)
                Text(conversationStatus(conversation))
                    .font(.system(size: 10, design: .rounded))
                    .foregroundStyle(HostPalette.secondaryInk.opacity(0.60))
                    .lineLimit(1)
            }
            Spacer()
        }
        .padding(10)
        .background(
            selectedConversationId == conversation.id
            ? HostPalette.lavender.opacity(0.15)
            : Color.white.opacity(0.18),
            in: RoundedRectangle(cornerRadius: 15, style: .continuous))
    }

    @ViewBuilder
    private var conversationPane: some View {
        if let selectedConversationId {
            VStack(spacing: 0) {
                conversationHeader
                Divider().overlay(Color.white.opacity(0.42))
                if let errorMessage {
                    SectionErrorBanner(message: errorMessage)
                        .padding(.horizontal, 18)
                        .padding(.top, 12)
                }
                timeline
                composer
            }
            .background(Color.white.opacity(0.07))
            .task { await refreshDetail(selectedConversationId, reportError: true) }
        } else {
            VStack(spacing: 12) {
                Image(systemName: "bubble.left.and.text.bubble.right")
                    .font(.system(size: 36, weight: .ultraLight))
                    .foregroundStyle(HostPalette.lavender)
                Text(L10n.selectComputerConversation)
                    .font(.system(size: 16, weight: .semibold, design: .rounded))
                    .foregroundStyle(HostPalette.ink)
                Text(L10n.selectComputerConversationDetail)
                    .font(.system(size: 11.5, design: .rounded))
                    .foregroundStyle(HostPalette.secondaryInk.opacity(0.65))
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private var conversationHeader: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(detail?.title ?? selectedProjection?.title ?? L10n.conversations)
                    .font(.system(size: 17, weight: .semibold, design: .rounded))
                    .foregroundStyle(HostPalette.ink)
                Text(detail.map(conversationStatus) ?? L10n.loading)
                    .font(.system(size: 10.5, design: .rounded))
                    .foregroundStyle(HostPalette.secondaryInk.opacity(0.60))
            }
            Spacer()
            if let turn = detail?.activeTurn, turn.isActive {
                Button {
                    Task { await cancel(turn) }
                } label: {
                    Label(L10n.stopTurn, systemImage: "stop.fill")
                }
                .buttonStyle(FloatingGlassButtonStyle(tint: HostPalette.rose.opacity(0.14)))
                .disabled(isMutating)
            }
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 13)
    }

    private var timeline: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 12) {
                    ForEach(detail?.messages ?? []) { message in
                        messageBubble(message)
                            .id(message.id)
                    }
                    ForEach(detail?.approvals?.filter(\.isPending) ?? []) { approval in
                        approvalCard(approval)
                            .id(approval.id)
                    }
                }
                .padding(18)
            }
            .onChange(of: detail?.cursor) { _, _ in
                if let last = detail?.messages?.last?.id {
                    withAnimation(.easeOut(duration: 0.18)) { proxy.scrollTo(last, anchor: .bottom) }
                }
            }
        }
    }

    private func messageBubble(_ message: HostCollaboratorConversationMessage) -> some View {
        HStack(alignment: .bottom, spacing: 8) {
            if message.role == "user" { Spacer(minLength: 120) }
            if message.role != "user" {
                HostedCollaboratorAvatar(collaborator: collaborator, size: 28)
            }
            VStack(alignment: .leading, spacing: 7) {
                Text(message.role == "user" ? L10n.you : collaborator.displayName)
                    .font(.system(size: 9.5, weight: .bold, design: .rounded))
                    .foregroundStyle(message.role == "user"
                                     ? HostPalette.lavenderDeep : HostPalette.secondaryInk.opacity(0.56))
                if message.content.isEmpty && message.status == "streaming" {
                    ProgressView().controlSize(.small)
                } else {
                    Text(message.content)
                        .font(.system(size: 13, design: .rounded))
                        .foregroundStyle(HostPalette.ink)
                        .textSelection(.enabled)
                }
                if message.status == "failed" || message.status == "interrupted" {
                    Text(message.status == "failed" ? L10n.turnFailed : L10n.turnInterrupted)
                        .font(.system(size: 10, weight: .semibold, design: .rounded))
                        .foregroundStyle(HostPalette.rose)
                }
            }
            .padding(13)
            .background(message.role == "user"
                        ? HostPalette.lavender.opacity(0.13) : Color.white.opacity(0.34),
                        in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 18).stroke(Color.white.opacity(0.48), lineWidth: 0.7))
            if message.role != "user" { Spacer(minLength: 120) }
        }
    }

    private func approvalCard(_ approval: HostCollaboratorConversationApproval) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 9) {
                Image(systemName: "checkmark.shield")
                    .foregroundStyle(HostPalette.amber)
                Text(approval.title)
                    .font(.system(size: 13.5, weight: .semibold, design: .rounded))
                    .foregroundStyle(HostPalette.ink)
            }
            Text(HostJSONValue.object(approval.detail).prettyPrinted)
                .font(.system(size: 10.5, design: .monospaced))
                .foregroundStyle(HostPalette.secondaryInk.opacity(0.70))
                .textSelection(.enabled)
                .lineLimit(8)
            HStack(spacing: 9) {
                Button(L10n.deny) { Task { await resolve(approval, decision: "deny") } }
                    .buttonStyle(FloatingGlassButtonStyle(tint: HostPalette.rose.opacity(0.12)))
                Spacer()
                Button(L10n.allowForSession) { Task { await resolve(approval, decision: "allowSession") } }
                    .buttonStyle(FloatingGlassButtonStyle())
                Button(L10n.allowOnce) { Task { await resolve(approval, decision: "allowOnce") } }
                    .buttonStyle(FloatingGlassButtonStyle(tint: HostPalette.lavender.opacity(0.22)))
            }
        }
        .padding(15)
        .background(HostPalette.amber.opacity(0.08),
                    in: RoundedRectangle(cornerRadius: 19, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 19).stroke(HostPalette.amber.opacity(0.20)))
    }

    private var composer: some View {
        HStack(alignment: .bottom, spacing: 11) {
            TextField(L10n.messageComputerCollaborator, text: $draft, axis: .vertical)
                .textFieldStyle(.plain)
                .lineLimit(1...5)
                .font(.system(size: 13.5, design: .rounded))
                .padding(.horizontal, 14)
                .padding(.vertical, 11)
                .background(Color.white.opacity(0.38),
                            in: RoundedRectangle(cornerRadius: 17, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 17).stroke(Color.white.opacity(0.56)))
                .onSubmit { Task { await send() } }
            Button {
                Task { await send() }
            } label: {
                Image(systemName: "arrow.up")
            }
            .buttonStyle(StudioIconButtonStyle(tint: HostPalette.lavender.opacity(0.22)))
            .disabled(!canSend)
        }
        .padding(16)
        .background(Color.white.opacity(0.13))
    }

    private var conversations: [HostCollaboratorConversation] {
        runtime.collaboratorConversations[collaborator.id] ?? []
    }

    private var selectedProjection: HostCollaboratorConversation? {
        conversations.first { $0.id == selectedConversationId }
    }

    private var detail: HostCollaboratorConversation? {
        guard let selectedConversationId else { return nil }
        return runtime.collaboratorConversationDetails[selectedConversationId]
    }

    private var isMutating: Bool {
        selectedConversationId.map(runtime.mutatingConversationIds.contains) == true
    }

    private var canSend: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && detail?.activeTurn?.isActive != true
            && !isMutating
            && collaborator.turnExecution
    }

    private func conversationStatus(_ conversation: HostCollaboratorConversation) -> String {
        if conversation.pendingApprovalCount > 0 { return L10n.waitingForApproval }
        switch conversation.activeTurn?.state {
        case "queued", "starting": return L10n.turnStarting
        case "streaming": return L10n.turnReplying
        case "toolRunning": return L10n.toolRunning
        case "failed": return conversation.activeTurn?.failure ?? L10n.turnFailed
        case "interrupted": return conversation.activeTurn?.failure ?? L10n.turnInterrupted
        default: return L10n.messageCount(conversation.messageCount)
        }
    }

    private func createConversation() async {
        guard !isCreating else { return }
        isCreating = true
        errorMessage = nil
        defer { isCreating = false }
        do {
            let created = try await runtime.createConversation(collaboratorId: collaborator.id)
            selectedConversationId = created.id
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func refreshDirectory(selectNewestWhenNeeded: Bool) async {
        guard !isRefreshing else { return }
        isRefreshing = true
        defer { isRefreshing = false }
        do {
            try await runtime.refreshConversations(collaboratorId: collaborator.id)
            if selectNewestWhenNeeded && selectedConversationId == nil {
                selectedConversationId = conversations.first?.id
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func refreshDetail(_ conversationId: String, reportError: Bool) async {
        do {
            _ = try await runtime.conversationDetail(
                collaboratorId: collaborator.id,
                conversationId: conversationId)
        } catch where reportError {
            errorMessage = error.localizedDescription
        } catch {}
    }

    private func send() async {
        guard canSend, let selectedConversationId else { return }
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        errorMessage = nil
        do {
            _ = try await runtime.sendConversationMessage(
                collaboratorId: collaborator.id,
                conversationId: selectedConversationId,
                text: text)
            draft = ""
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func resolve(_ approval: HostCollaboratorConversationApproval, decision: String) async {
        guard let selectedConversationId else { return }
        errorMessage = nil
        do {
            _ = try await runtime.resolveConversationApproval(
                collaboratorId: collaborator.id,
                conversationId: selectedConversationId,
                approvalId: approval.id,
                decision: decision)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func cancel(_ turn: HostCollaboratorConversationTurn) async {
        guard let selectedConversationId else { return }
        errorMessage = nil
        do {
            _ = try await runtime.cancelConversationTurn(
                collaboratorId: collaborator.id,
                conversationId: selectedConversationId,
                turnId: turn.turnId)
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
