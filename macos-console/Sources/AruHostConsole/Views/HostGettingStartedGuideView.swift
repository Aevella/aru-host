import SwiftUI

struct HostGettingStartedGuideView: View {
    @ObservedObject var runtime: HostConsoleRuntime
    let onOpenCollaborators: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var presentsPairingCode = false

    var body: some View {
        ZStack {
            BorrowedLightWeather()

            VStack(spacing: 0) {
                header
                Divider().overlay(Color.white.opacity(0.42))

                ScrollView {
                    VStack(alignment: .leading, spacing: 22) {
                        welcomePanel
                        stepGrid
                        approvalPanel
                        recoveryPanel
                    }
                    .padding(28)
                }
            }
        }
        .frame(minWidth: 820, minHeight: 680)
        .sheet(isPresented: $presentsPairingCode) {
            HostPairingQRCodeSheet(runtime: runtime)
        }
    }

    private var header: some View {
        HStack(alignment: .top, spacing: 18) {
            VStack(alignment: .leading, spacing: 6) {
                Text(L10n.guideTitle)
                    .font(.system(size: 26, weight: .light, design: .rounded))
                    .foregroundStyle(HostPalette.ink)
                Text(L10n.guideSubtitle)
                    .font(.system(size: 12, design: .rounded))
                    .foregroundStyle(HostPalette.secondaryInk.opacity(0.70))
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
            Button(L10n.close) { dismiss() }
                .buttonStyle(FloatingGlassButtonStyle())
        }
        .padding(.horizontal, 28)
        .padding(.vertical, 22)
    }

    private var welcomePanel: some View {
        ReadablePanel {
            HStack(spacing: 20) {
                ZStack {
                    Circle().fill(Color.white.opacity(0.30))
                    Image(systemName: "sparkles.rectangle.stack")
                        .font(.system(size: 30, weight: .ultraLight))
                        .foregroundStyle(HostPalette.lavenderDeep)
                }
                .frame(width: 70, height: 70)

                VStack(alignment: .leading, spacing: 7) {
                    Text(L10n.guideWelcomeTitle)
                        .font(.system(size: 19, weight: .semibold, design: .rounded))
                        .foregroundStyle(HostPalette.ink)
                    Text(L10n.guideWelcomeDetail)
                        .font(.system(size: 12, design: .rounded))
                        .foregroundStyle(HostPalette.secondaryInk.opacity(0.70))
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    private var stepGrid: some View {
        LazyVGrid(
            columns: [GridItem(.flexible(), spacing: 14), GridItem(.flexible(), spacing: 14)],
            spacing: 14
        ) {
            HostGuideStepCard(
                number: "1",
                symbol: "power",
                title: L10n.guideStepHostTitle,
                detail: L10n.guideStepHostDetail,
                status: hostStatus
            )

            HostGuideStepCard(
                number: "2",
                symbol: "qrcode.viewfinder",
                title: L10n.guideStepPhoneTitle,
                detail: L10n.guideStepPhoneDetail,
                status: phoneStatus,
                actionTitle: L10n.showPairingCode
            ) {
                presentsPairingCode = true
            }

            HostGuideStepCard(
                number: "3",
                symbol: "person.crop.circle.badge.plus",
                title: L10n.guideStepCollaboratorTitle,
                detail: L10n.guideStepCollaboratorDetail,
                status: collaboratorStatus,
                actionTitle: L10n.openCollaborators
            ) {
                dismiss()
                onOpenCollaborators()
            }

            HostGuideStepCard(
                number: "4",
                symbol: "bubble.left.and.bubble.right",
                title: L10n.guideStepConversationTitle,
                detail: L10n.guideStepConversationDetail,
                status: conversationStatus
            )
        }
    }

    private var approvalPanel: some View {
        VStack(alignment: .leading, spacing: 13) {
            guideSectionHeader(
                title: L10n.guideApprovalTitle,
                detail: L10n.guideApprovalDetail,
                symbol: "hand.raised"
            )

            ReadablePanel {
                HStack(alignment: .top, spacing: 12) {
                    HostGuideChoice(
                        title: L10n.allowOnce,
                        detail: L10n.guideAllowOnceDetail,
                        tint: HostPalette.lavenderDeep
                    )
                    HostGuideChoice(
                        title: L10n.allowForSession,
                        detail: L10n.guideAllowSessionDetail,
                        tint: HostPalette.mint
                    )
                    HostGuideChoice(
                        title: L10n.deny,
                        detail: L10n.guideDenyDetail,
                        tint: HostPalette.rose
                    )
                }
            }
        }
    }

    private var recoveryPanel: some View {
        VStack(alignment: .leading, spacing: 13) {
            guideSectionHeader(
                title: L10n.guideRecoveryTitle,
                detail: L10n.guideRecoveryDetail,
                symbol: "lifepreserver"
            )

            ReadablePanel {
                LazyVGrid(
                    columns: [GridItem(.flexible()), GridItem(.flexible())],
                    alignment: .leading,
                    spacing: 11
                ) {
                    ForEach(Array(L10n.guideRecoveryItems.enumerated()), id: \.offset) { index, item in
                        HStack(alignment: .top, spacing: 10) {
                            Text("\(index + 1)")
                                .font(.system(size: 10, weight: .bold, design: .rounded))
                                .foregroundStyle(HostPalette.lavenderDeep)
                                .frame(width: 22, height: 22)
                                .background(Circle().fill(Color.white.opacity(0.30)))
                            Text(item)
                                .font(.system(size: 11, design: .rounded))
                                .foregroundStyle(HostPalette.secondaryInk.opacity(0.72))
                                .fixedSize(horizontal: false, vertical: true)
                            Spacer(minLength: 6)
                        }
                    }
                }
            }
        }
    }

    private func guideSectionHeader(title: String, detail: String, symbol: String) -> some View {
        HStack(alignment: .top, spacing: 11) {
            Image(systemName: symbol)
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(HostPalette.lavenderDeep)
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.system(size: 15, weight: .semibold, design: .rounded))
                    .foregroundStyle(HostPalette.ink)
                Text(detail)
                    .font(.system(size: 11, design: .rounded))
                    .foregroundStyle(HostPalette.secondaryInk.opacity(0.64))
            }
        }
    }

    private var hostStatus: HostGuideStatus {
        let hostReady = runtime.diagnostics?.manifest == "ok" && runtime.diagnostics?.auth == "ok"
        let driverReady = runtime.driverInventory?.drivers.contains(where: {
            ($0.id == "codex" || $0.id == "api") && $0.status == .ready
        }) == true
        return HostGuideStatus(
            label: hostReady && driverReady ? L10n.guideHostReady : L10n.guideHostNeedsAttention,
            ready: hostReady && driverReady
        )
    }

    private var phoneStatus: HostGuideStatus {
        let count = runtime.pairedDevices.filter { $0.isActive && !$0.isCurrent }.count
        return HostGuideStatus(
            label: count > 0 ? L10n.guidePairedPhoneCount(count) : L10n.guideNoPairedPhone,
            ready: count > 0
        )
    }

    private var collaboratorStatus: HostGuideStatus {
        HostGuideStatus(
            label: runtime.collaborators.isEmpty
                ? L10n.guideNoCollaborator
                : L10n.guideCollaboratorCount(runtime.collaborators.count),
            ready: !runtime.collaborators.isEmpty
        )
    }

    private var conversationStatus: HostGuideStatus {
        let count = runtime.collaboratorConversations.values.reduce(0) { $0 + $1.count }
        return HostGuideStatus(
            label: count > 0 ? L10n.guideConversationCount(count) : L10n.guideNoConversation,
            ready: count > 0
        )
    }
}

private struct HostGuideStatus {
    let label: String
    let ready: Bool
}

private struct HostGuideStepCard: View {
    let number: String
    let symbol: String
    let title: String
    let detail: String
    let status: HostGuideStatus
    var actionTitle: String?
    var action: (() -> Void)?

    var body: some View {
        ReadablePanel {
            VStack(alignment: .leading, spacing: 14) {
                HStack(spacing: 10) {
                    Text(number)
                        .font(.system(size: 11, weight: .bold, design: .rounded))
                        .foregroundStyle(HostPalette.lavenderDeep)
                        .frame(width: 28, height: 28)
                        .background(Circle().fill(Color.white.opacity(0.30)))
                    Image(systemName: symbol)
                        .font(.system(size: 17, weight: .light))
                        .foregroundStyle(HostPalette.lavenderDeep)
                    Spacer()
                    HStack(spacing: 6) {
                        Circle()
                            .fill(status.ready ? HostPalette.mint : HostPalette.amber)
                            .frame(width: 6, height: 6)
                        Text(status.label)
                            .font(.system(size: 10, weight: .semibold, design: .rounded))
                    }
                    .foregroundStyle(status.ready ? HostPalette.mint : HostPalette.amber)
                }

                VStack(alignment: .leading, spacing: 5) {
                    Text(title)
                        .font(.system(size: 15, weight: .semibold, design: .rounded))
                        .foregroundStyle(HostPalette.ink)
                    Text(detail)
                        .font(.system(size: 11, design: .rounded))
                        .foregroundStyle(HostPalette.secondaryInk.opacity(0.68))
                        .fixedSize(horizontal: false, vertical: true)
                }

                if let actionTitle, let action {
                    Button(actionTitle, action: action)
                        .buttonStyle(FloatingGlassButtonStyle(tint: HostPalette.lavender.opacity(0.20)))
                }
            }
            .frame(maxWidth: .infinity, minHeight: 146, alignment: .topLeading)
        }
    }
}

private struct HostGuideChoice: View {
    let title: String
    let detail: String
    let tint: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 7) {
                Circle().fill(tint).frame(width: 7, height: 7)
                Text(title)
                    .font(.system(size: 12, weight: .semibold, design: .rounded))
                    .foregroundStyle(HostPalette.ink)
            }
            Text(detail)
                .font(.system(size: 10, design: .rounded))
                .foregroundStyle(HostPalette.secondaryInk.opacity(0.66))
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .padding(14)
        .background(RoundedRectangle(cornerRadius: 18).fill(Color.white.opacity(0.18)))
    }
}
