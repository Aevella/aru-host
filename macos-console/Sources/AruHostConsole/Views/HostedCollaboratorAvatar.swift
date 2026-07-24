import AppKit
import SwiftUI

enum HostCollaboratorAvatarPreset {
    static let count = 36

    static func assetName(for seed: String) -> String {
        let number = number(for: seed)
        return "AvatarPresetCollaborator\(String(format: "%02d", number))"
    }

    @MainActor
    static func image(for seed: String) -> NSImage? {
        let key = seed as NSString
        if let cached = imageCache.object(forKey: key) { return cached }
        guard let url = resourceURL(for: seed),
              let image = NSImage(contentsOf: url) else { return nil }
        imageCache.setObject(image, forKey: key)
        return image
    }

    static func resourceURL(for seed: String) -> URL? {
        let number = number(for: seed)
        let suffix = String(format: "%02d", number)
        return Bundle.module.url(
            forResource: "avatar-preset-collaborator-\(suffix)",
            withExtension: "png",
            subdirectory: "AvatarPresets.xcassets/AvatarPresetCollaborator\(suffix).imageset"
        )
    }

    @MainActor
    private static let imageCache = NSCache<NSString, NSImage>()

    private static func number(for seed: String) -> Int {
        stableIndex(for: seed, modulo: count) + 1
    }

    private static func stableIndex(for seed: String, modulo: Int) -> Int {
        var hash: UInt64 = 14_695_981_039_346_656_037
        for byte in seed.utf8 {
            hash ^= UInt64(byte)
            hash &*= 1_099_511_628_211
        }
        return Int(hash % UInt64(modulo))
    }
}

struct HostedCollaboratorAvatar: View {
    let collaborator: HostedCollaborator
    var size: CGFloat = 40
    var statusColor: Color? = nil

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            Group {
                if let image = HostCollaboratorAvatarPreset.image(for: collaborator.id) {
                    Image(nsImage: image)
                        .resizable()
                        .scaledToFill()
                } else {
                    Circle()
                        .fill(HostPalette.lavender.opacity(0.16))
                        .overlay {
                            Image(systemName: "sparkles")
                                .foregroundStyle(HostPalette.lavenderDeep.opacity(0.72))
                        }
                }
            }
            .frame(width: size, height: size)
            .clipShape(Circle())
            .overlay {
                Circle()
                    .stroke(Color.white.opacity(0.68), lineWidth: max(0.7, size * 0.025))
            }
            .shadow(color: HostPalette.lavenderDeep.opacity(0.12), radius: size * 0.14, y: size * 0.08)

            if let statusColor {
                Circle()
                    .fill(statusColor)
                    .frame(width: max(7, size * 0.22), height: max(7, size * 0.22))
                    .overlay(Circle().stroke(Color.white.opacity(0.92), lineWidth: 1.5))
                    .padding(1)
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}
