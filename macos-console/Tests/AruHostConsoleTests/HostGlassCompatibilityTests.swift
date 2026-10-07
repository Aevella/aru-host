import AppKit
import SwiftUI
import Testing
@testable import AruHostConsole

/// Runs on both Sequoia and Tahoe in CI, exercising the available material
/// implementation on the actual OS rather than faking an availability check.
@MainActor
@Test func glassSurfacesRenderOnSupportedSystem() throws {
    let surface = VStack(spacing: 12) {
        FoundationGlass { Text("Host").padding() }
        Button("Connect") {}.buttonStyle(FloatingGlassButtonStyle())
        Circle().fill(.white.opacity(0.2))
            .hostGlassEffect(tint: .purple.opacity(0.1), in: Circle())
            .frame(width: 32, height: 32)
    }
    .padding(24)
    .frame(width: 320, height: 240)
    .background(BorrowedLightWeather())
    for scheme in [ColorScheme.light, .dark] {
        let renderer = ImageRenderer(content: surface.environment(\.colorScheme, scheme))
        let image = try #require(renderer.cgImage)
        #expect(image.width == 320)
        #expect(image.height == 240)
    }
}
