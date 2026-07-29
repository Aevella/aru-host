import SwiftUI

struct CollaboratorInitiativeStudioView: View {
    let runtime: HostConsoleRuntime
    let collaborator: HostedCollaborator

    @State private var title = ""
    @State private var goal = ""
    @State private var instructions = ""
    @State private var fireAfterMinutes = 30
    @State private var recurrenceMinutes = 0
    @State private var notificationsEnabled = true
    @State private var errorMessage: String?

    var body: some View {
        HStack(spacing: 0) {
            composer
                .frame(width: 360)
            Divider().overlay(Color.white.opacity(0.48))
            ruleList
        }
        .task { await refresh() }
    }

    private var composer: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text(L10n.initiativeNew)
                    .font(.system(size: 18, weight: .semibold, design: .rounded))
                    .foregroundStyle(HostPalette.ink)
                TextField(L10n.initiativeTitle, text: $title)
                    .textFieldStyle(.roundedBorder)
                TextField(L10n.initiativeGoal, text: $goal, axis: .vertical)
                    .textFieldStyle(.roundedBorder)
                    .lineLimit(3...6)
                TextField(L10n.initiativeInstructions, text: $instructions, axis: .vertical)
                    .textFieldStyle(.roundedBorder)
                    .lineLimit(3...6)
                Picker(L10n.initiativeWhen, selection: $fireAfterMinutes) {
                    ForEach([1, 5, 15, 30, 60, 180], id: \.self) { minutes in
                        Text(L10n.initiativeMinutes(minutes)).tag(minutes)
                    }
                }
                Picker(L10n.initiativeRepeat, selection: $recurrenceMinutes) {
                    Text(L10n.initiativeOnce).tag(0)
                    Text(L10n.initiativeHourly).tag(60)
                    Text(L10n.initiativeDaily).tag(1_440)
                    Text(L10n.initiativeWeekly).tag(10_080)
                }
                Toggle(L10n.initiativeNotify, isOn: $notificationsEnabled)
                Button {
                    Task { await create() }
                } label: {
                    Label(L10n.initiativeCreate, systemImage: "sparkles")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(FloatingGlassButtonStyle())
                .disabled(goal.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isMutating)
                if let errorMessage {
                    Text(errorMessage)
                        .font(.system(size: 11, design: .rounded))
                        .foregroundStyle(HostPalette.rose)
                }
            }
            .padding(22)
        }
    }

    private var ruleList: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 12) {
                HStack {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(L10n.initiativePlans)
                            .font(.system(size: 18, weight: .semibold, design: .rounded))
                        Text(L10n.initiativeOwnedByHost)
                            .font(.system(size: 11, design: .rounded))
                            .foregroundStyle(HostPalette.secondaryInk.opacity(0.66))
                    }
                    Spacer()
                    Button { Task { await refresh() } } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                    .buttonStyle(StudioIconButtonStyle(tint: HostPalette.lavender.opacity(0.18)))
                }
                if rules.isEmpty {
                    ContentUnavailableView(L10n.initiativeEmpty,
                                           systemImage: "sparkles",
                                           description: Text(L10n.initiativeEmptyDetail))
                        .frame(maxWidth: .infinity, minHeight: 360)
                } else {
                    ForEach(rules) { rule in
                        ruleCard(rule)
                    }
                }
            }
            .padding(22)
        }
    }

    private func ruleCard(_ rule: HostCollaboratorInitiativeRule) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 10) {
                Circle()
                    .fill(rule.isRunning ? HostPalette.mint : HostPalette.lavender)
                    .frame(width: 7, height: 7)
                    .padding(.top, 6)
                VStack(alignment: .leading, spacing: 3) {
                    Text(rule.title)
                        .font(.system(size: 14, weight: .semibold, design: .rounded))
                    Text(rule.goal)
                        .font(.system(size: 11.5, design: .rounded))
                        .foregroundStyle(HostPalette.secondaryInk.opacity(0.72))
                }
                Spacer()
                Menu {
                    Button(rule.enabled ? L10n.initiativePause : L10n.initiativeResume) {
                        Task { await setEnabled(!rule.enabled, rule: rule) }
                    }
                    Button(L10n.initiativeRunNow) { Task { await run(rule) } }
                    Button(L10n.archive, role: .destructive) { Task { await archive(rule) } }
                } label: {
                    Image(systemName: "ellipsis")
                        .frame(width: 30, height: 30)
                }
                .disabled(isMutating || rule.isRunning)
            }
            HStack(spacing: 10) {
                Label(stateText(rule), systemImage: rule.isRunning ? "sparkles" : "clock")
                if rule.notificationsEnabled {
                    Label(L10n.initiativeNotifyShort, systemImage: "bell")
                }
                Text(L10n.initiativeDeliveries(rule.deliveryCount))
            }
            .font(.system(size: 10.5, design: .rounded))
            .foregroundStyle(HostPalette.secondaryInk.opacity(0.58))
            if let failure = rule.lastFailure, !failure.isEmpty {
                Text(failure)
                    .font(.system(size: 10.5, design: .rounded))
                    .foregroundStyle(HostPalette.rose)
            }
        }
        .padding(15)
        .background(Color.white.opacity(0.46), in: RoundedRectangle(cornerRadius: 18))
        .overlay(RoundedRectangle(cornerRadius: 18).stroke(Color.white.opacity(0.72), lineWidth: 0.7))
        .opacity(rule.enabled ? 1 : 0.62)
    }

    private func refresh() async {
        do {
            try await runtime.refreshInitiative(collaboratorId: collaborator.id)
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func create() async {
        do {
            _ = try await runtime.createInitiativeRule(
                collaboratorId: collaborator.id,
                title: title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? goal : title,
                goal: goal,
                instructions: instructions,
                fireAfterMinutes: fireAfterMinutes,
                recurrenceMinutes: recurrenceMinutes == 0 ? nil : recurrenceMinutes,
                notificationsEnabled: notificationsEnabled)
            title = ""
            goal = ""
            instructions = ""
            errorMessage = nil
        } catch { errorMessage = error.localizedDescription }
    }

    private func setEnabled(_ enabled: Bool, rule: HostCollaboratorInitiativeRule) async {
        do {
            _ = try await runtime.setInitiativeRuleEnabled(
                enabled, collaboratorId: collaborator.id, ruleId: rule.ruleId)
            errorMessage = nil
        } catch { errorMessage = error.localizedDescription }
    }

    private func run(_ rule: HostCollaboratorInitiativeRule) async {
        do {
            _ = try await runtime.runInitiativeRule(
                collaboratorId: collaborator.id, ruleId: rule.ruleId)
            errorMessage = nil
        } catch { errorMessage = error.localizedDescription }
    }

    private func archive(_ rule: HostCollaboratorInitiativeRule) async {
        do {
            _ = try await runtime.archiveInitiativeRule(
                collaboratorId: collaborator.id, ruleId: rule.ruleId)
            errorMessage = nil
        } catch { errorMessage = error.localizedDescription }
    }

    private func stateText(_ rule: HostCollaboratorInitiativeRule) -> String {
        if rule.isRunning { return L10n.initiativeRunning }
        if !rule.enabled { return L10n.initiativePaused }
        guard let timestamp = rule.nextFireAt else { return L10n.initiativeReady }
        return Date(timeIntervalSince1970: Double(timestamp) / 1_000)
            .formatted(date: .abbreviated, time: .shortened)
    }

    private var rules: [HostCollaboratorInitiativeRule] {
        (runtime.collaboratorInitiatives[collaborator.id]?.rules ?? [])
            .filter { !$0.isArchived }
            .sorted { $0.updatedAt > $1.updatedAt }
    }

    private var isMutating: Bool { runtime.mutatingInitiativeIds.contains(collaborator.id) }
}
