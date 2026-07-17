import SwiftUI

struct ProviderProfilesPanel: View {
    @ObservedObject var runtime: HostProviderProfileRuntime
    let onChanged: () async -> Void

    @State private var editorProfile: HostProviderProfile?
    @State private var presentsEditor = false
    @State private var profileToDelete: HostProviderProfile?
    @State private var actionError: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 13) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text(L10n.providerProfiles)
                        .font(.system(size: 16, weight: .semibold, design: .rounded))
                        .foregroundStyle(HostPalette.ink)
                    Text(L10n.providerProfilesSubtitle)
                        .font(.system(size: 11, design: .rounded))
                        .foregroundStyle(HostPalette.secondaryInk.opacity(0.62))
                }
                Spacer()
                Button {
                    editorProfile = nil
                    presentsEditor = true
                } label: {
                    Label(L10n.addProviderProfile, systemImage: "plus")
                }
                .buttonStyle(FloatingGlassButtonStyle(tint: HostPalette.lavender.opacity(0.22)))
                .disabled(runtime.secretStorage?.supported == false)
            }

            if let error = actionError ?? runtime.errorMessage {
                SectionErrorBanner(message: error)
            }
            if runtime.secretStorage?.supported == false {
                EmptySectionState(
                    symbol: "key.slash",
                    title: L10n.providerKeychainUnavailable,
                    detail: L10n.providerKeychainUnavailableDetail
                )
            } else if runtime.isLoading && runtime.profiles.isEmpty {
                ReadablePanel {
                    HStack(spacing: 12) {
                        ProgressView().controlSize(.small)
                        Text(L10n.loadingProviderProfiles)
                            .font(.system(size: 12, design: .rounded))
                            .foregroundStyle(HostPalette.secondaryInk.opacity(0.68))
                    }
                    .padding(.vertical, 12)
                }
            } else if runtime.profiles.isEmpty {
                EmptySectionState(
                    symbol: "network.badge.shield.half.filled",
                    title: L10n.noProviderProfiles,
                    detail: L10n.noProviderProfilesDetail
                )
            } else {
                ReadablePanel {
                    VStack(spacing: 0) {
                        ForEach(runtime.profiles) { profile in
                            ProviderProfileRow(
                                profile: profile,
                                isMutating: runtime.mutatingProfileIds.contains(profile.profileId),
                                onEdit: {
                                    editorProfile = profile
                                    presentsEditor = true
                                },
                                onTest: { Task { await test(profile) } },
                                onDelete: { profileToDelete = profile }
                            )
                            if profile.id != runtime.profiles.last?.id {
                                Divider().padding(.leading, 48).overlay(Color.white.opacity(0.40))
                            }
                        }
                    }
                }
            }
        }
        .sheet(isPresented: $presentsEditor) {
            ProviderProfileEditorSheet(runtime: runtime, profile: editorProfile) {
                await onChanged()
            }
        }
        .alert(L10n.deleteProviderProfileTitle, isPresented: Binding(
            get: { profileToDelete != nil },
            set: { if !$0 { profileToDelete = nil } }
        )) {
            Button(L10n.cancel, role: .cancel) { profileToDelete = nil }
            Button(L10n.deleteProviderProfile, role: .destructive) {
                guard let profile = profileToDelete else { return }
                Task { await delete(profile) }
            }
        } message: {
            Text(L10n.deleteProviderProfileDetail)
        }
    }

    private func test(_ profile: HostProviderProfile) async {
        actionError = nil
        do {
            _ = try await runtime.test(profile)
            await onChanged()
        } catch {
            actionError = error.localizedDescription
        }
    }

    private func delete(_ profile: HostProviderProfile) async {
        actionError = nil
        do {
            try await runtime.delete(profile)
            profileToDelete = nil
            await onChanged()
        } catch {
            actionError = error.localizedDescription
        }
    }
}

private struct ProviderProfileRow: View {
    let profile: HostProviderProfile
    let isMutating: Bool
    let onEdit: () -> Void
    let onTest: () -> Void
    let onDelete: () -> Void

    var body: some View {
        HStack(spacing: 14) {
            StatusGlyph(state: glyphState)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 7) {
                    Text(profile.displayName)
                        .font(.system(size: 14, weight: .semibold, design: .rounded))
                        .foregroundStyle(HostPalette.ink)
                    Text(protocolLabel)
                        .font(.system(size: 9.5, weight: .bold, design: .rounded))
                        .foregroundStyle(HostPalette.lavenderDeep.opacity(0.78))
                        .padding(.horizontal, 7)
                        .padding(.vertical, 3)
                        .background(HostPalette.lavender.opacity(0.12), in: Capsule())
                }
                Text("\(profile.model) · \(profile.baseURL)")
                    .font(.system(size: 11, design: .rounded))
                    .foregroundStyle(HostPalette.secondaryInk.opacity(0.65))
                    .lineLimit(1)
                Text(L10n.providerToolRoundsSummary(profile.maxToolRounds))
                    .font(.system(size: 10, design: .rounded))
                    .foregroundStyle(HostPalette.secondaryInk.opacity(0.54))
                if let error = profile.lastError, profile.health == .unhealthy {
                    Text(error)
                        .font(.system(size: 10.5, design: .rounded))
                        .foregroundStyle(HostPalette.rose)
                        .lineLimit(2)
                }
            }
            Spacer()
            if isMutating {
                ProgressView().controlSize(.small)
            } else {
                Button(L10n.testConnection, action: onTest)
                    .buttonStyle(FloatingGlassButtonStyle())
                Menu {
                    Button(L10n.edit, action: onEdit)
                    Button(L10n.deleteProviderProfile, role: .destructive, action: onDelete)
                } label: {
                    Image(systemName: "ellipsis")
                        .frame(width: 28, height: 28)
                }
                .menuStyle(.borderlessButton)
                .fixedSize()
            }
        }
        .padding(.vertical, 11)
    }

    private var glyphState: StatusGlyph.State {
        switch profile.health {
        case .ready: .ready
        case .unchecked: .waiting
        case .unhealthy: .unavailable
        }
    }

    private var protocolLabel: String {
        profile.protocol == .anthropicMessages ? "Anthropic" : "OpenAI compatible"
    }
}

private struct ProviderProfileEditorSheet: View {
    @ObservedObject var runtime: HostProviderProfileRuntime
    let profile: HostProviderProfile?
    let onSaved: () async -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var workingProfile: HostProviderProfile?
    @State private var displayName: String
    @State private var providerProtocol: HostProviderProtocol
    @State private var baseURL: String
    @State private var path: String
    @State private var model: String
    @State private var authMode: HostProviderAuthMode
    @State private var maxOutputTokens: String
    @State private var maxToolRounds: String
    @State private var apiKey = ""
    @State private var errorMessage: String?

    init(
        runtime: HostProviderProfileRuntime,
        profile: HostProviderProfile?,
        onSaved: @escaping () async -> Void
    ) {
        self.runtime = runtime
        self.profile = profile
        self.onSaved = onSaved
        _workingProfile = State(initialValue: profile)
        _displayName = State(initialValue: profile?.displayName ?? "")
        _providerProtocol = State(initialValue: profile?.protocol ?? .openAICompatible)
        _baseURL = State(initialValue: profile?.baseURL ?? "https://api.openai.com/")
        _path = State(initialValue: profile?.path ?? "v1/chat/completions")
        _model = State(initialValue: profile?.model ?? "")
        _authMode = State(initialValue: profile?.authMode ?? .bearer)
        _maxOutputTokens = State(initialValue: String(profile?.maxOutputTokens ?? 16_384))
        _maxToolRounds = State(initialValue: profile?.maxToolRounds.map(String.init) ?? "")
    }

    var body: some View {
        ZStack {
            BorrowedLightWeather()
            VStack(spacing: 0) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(workingProfile == nil ? L10n.addProviderProfile : L10n.editProviderProfile)
                            .font(.system(size: 25, weight: .light, design: .rounded))
                            .foregroundStyle(HostPalette.ink)
                        Text(L10n.providerEditorSubtitle)
                            .font(.system(size: 12, design: .rounded))
                            .foregroundStyle(HostPalette.secondaryInk.opacity(0.72))
                    }

                    BorrowedLightChoiceStrip(
                        choices: [
                            (.openAICompatible, "OpenAI compatible"),
                            (.anthropicMessages, "Anthropic Messages"),
                        ],
                        selection: $providerProtocol
                    )
                    .onChange(of: providerProtocol) { _, value in
                        guard workingProfile == nil else { return }
                        if value == .anthropicMessages {
                            baseURL = "https://api.anthropic.com/"
                            path = "v1/messages"
                            authMode = .xAPIKey
                        } else {
                            baseURL = "https://api.openai.com/"
                            path = "v1/chat/completions"
                            authMode = .bearer
                        }
                    }

                    VStack(spacing: 12) {
                        ProviderEditorField(title: L10n.providerName, text: $displayName)
                        ProviderEditorField(title: L10n.providerBaseURL, text: $baseURL)
                        ProviderEditorField(title: L10n.providerPath, text: $path)
                        ProviderEditorField(title: L10n.providerModel, text: $model)
                        if providerProtocol == .anthropicMessages {
                            ProviderEditorField(
                                title: L10n.providerMaxOutputTokens,
                                detail: L10n.providerMaxOutputTokensDetail,
                                text: $maxOutputTokens
                            )
                        }
                        ProviderEditorField(
                            title: L10n.providerMaxToolRounds,
                            detail: L10n.providerMaxToolRoundsDetail,
                            text: $maxToolRounds
                        )
                        ProviderEditorSecureField(
                            title: L10n.providerAPIKey,
                            placeholder: workingProfile == nil
                                ? L10n.providerAPIKeyRequired
                                : L10n.providerAPIKeyKeep,
                            text: $apiKey
                        )
                        Picker(L10n.providerAuthMode, selection: $authMode) {
                            Text("Bearer").tag(HostProviderAuthMode.bearer)
                            Text("x-api-key").tag(HostProviderAuthMode.xAPIKey)
                            Text(L10n.providerNoAuth).tag(HostProviderAuthMode.none)
                        }
                    }
                    .padding(18)
                    .background(Color.white.opacity(0.34), in: RoundedRectangle(cornerRadius: 22, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 22).stroke(Color.white.opacity(0.60), lineWidth: 0.7))

                    Label(L10n.providerKeychainDetail, systemImage: "key.horizontal.fill")
                        .font(.system(size: 11, design: .rounded))
                        .foregroundStyle(HostPalette.secondaryInk.opacity(0.66))

                    if let errorMessage {
                        SectionErrorBanner(message: errorMessage)
                    }

                    }
                    .padding(30)
                }

                HStack {
                    Button(L10n.cancel) { dismiss() }
                        .buttonStyle(FloatingGlassButtonStyle())
                    Spacer()
                    Button {
                        Task { await save() }
                    } label: {
                        HStack(spacing: 8) {
                            if isSaving { ProgressView().controlSize(.small) }
                            Text(L10n.saveAndTest)
                        }
                    }
                    .buttonStyle(FloatingGlassButtonStyle(tint: HostPalette.lavender.opacity(0.28)))
                    .disabled(!canSave || isSaving)
                }
                .padding(.horizontal, 30)
                .padding(.top, 12)
                .padding(.bottom, 26)
            }
            .background {
                RoundedRectangle(cornerRadius: 34, style: .continuous)
                    .fill(Color.white.opacity(0.24))
                    .glassEffect(.regular.tint(Color.white.opacity(0.10)), in: RoundedRectangle(cornerRadius: 34))
            }
            .padding(18)
        }
        .frame(width: 620, height: 720)
        .preferredColorScheme(.light)
    }

    private var isSaving: Bool {
        runtime.mutatingProfileIds.contains(workingProfile?.profileId ?? "new")
    }

    private var canSave: Bool {
        !displayName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !baseURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !path.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !model.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && (providerProtocol != .anthropicMessages
                || (Int(maxOutputTokens).map { $0 > 0 } ?? false))
            && (maxToolRounds.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                || (Int(maxToolRounds).map { $0 > 0 } ?? false))
            && (workingProfile != nil || !apiKey.isEmpty)
    }

    private func save() async {
        errorMessage = nil
        do {
            let saved = try await runtime.save(
                profile: workingProfile,
                displayName: displayName,
                protocol: providerProtocol,
                baseURL: baseURL,
                path: path,
                model: model,
                authMode: authMode,
                maxOutputTokens: Int(maxOutputTokens),
                maxToolRounds: Int(maxToolRounds.trimmingCharacters(in: .whitespacesAndNewlines)),
                apiKey: apiKey
            )
            workingProfile = saved
            apiKey = ""
            await onSaved()
            if saved.health == .ready {
                dismiss()
            } else {
                errorMessage = saved.lastError ?? L10n.providerConnectionFailed
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

private struct ProviderEditorField: View {
    let title: String
    var detail: String? = nil
    @Binding var text: String
    @FocusState private var isFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.system(size: 11, weight: .semibold, design: .rounded))
                .foregroundStyle(HostPalette.secondaryInk.opacity(0.72))
            TextField(title, text: $text)
                .textFieldStyle(.plain)
                .focused($isFocused)
                .providerInputSurface(isFocused: isFocused)
            if let detail {
                Text(detail)
                    .font(.system(size: 9.5, design: .rounded))
                    .foregroundStyle(HostPalette.secondaryInk.opacity(0.54))
            }
        }
    }
}

private struct ProviderEditorSecureField: View {
    let title: String
    let placeholder: String
    @Binding var text: String
    @FocusState private var isFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.system(size: 11, weight: .semibold, design: .rounded))
                .foregroundStyle(HostPalette.secondaryInk.opacity(0.72))
            SecureField(placeholder, text: $text)
                .textFieldStyle(.plain)
                .focused($isFocused)
                .providerInputSurface(isFocused: isFocused)
        }
    }
}

private extension View {
    func providerInputSurface(isFocused: Bool) -> some View {
        padding(.horizontal, 10)
            .frame(minHeight: 30)
            .background(Color.white.opacity(0.50), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .stroke(
                        isFocused
                            ? HostPalette.lavenderDeep.opacity(0.42)
                            : Color.white.opacity(0.68),
                        lineWidth: isFocused ? 1.15 : 0.65
                    )
            }
            .shadow(
                color: isFocused ? HostPalette.lavenderDeep.opacity(0.10) : .clear,
                radius: 8,
                y: 2
            )
            .animation(.easeOut(duration: 0.14), value: isFocused)
    }
}
