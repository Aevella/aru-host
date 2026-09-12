#!/usr/bin/env swift
// Builds the Host Console's macOS icon from AppIcon-source.png.
//
// The mark is a thought bubble in the same iridescent material as the phone
// app, because this product's identity is the colour and the translucency
// rather than a silhouette. A boundary is still required here: macOS icons are
// not full-bleed, they sit on a rounded plate inside a transparent canvas, and
// a plate of bare pastel texture loses all contrast once the Dock scales it
// down. So the texture fills the mark, and the plate stays white behind it.
//
// The grade lifts saturation slightly. It only moves pixels that already carry
// colour — white has no saturation to raise — so the source's white field and
// the highlights inside the bubble survive untouched while the pink, violet and
// cyan currents stay readable at 32 points.
//
//   swift scripts/selfhost/macos-console/make-app-icon.swift
//
// Writes AppIcon.icns beside this script. Requires macOS (sips + iconutil).
import AppKit
import CoreImage
import Foundation

let script = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
let source = script.appendingPathComponent("AppIcon-source.png")
let output = script.appendingPathComponent("AppIcon.icns")

let canvas = 1024.0
let plateSize = 824.0     // Apple's macOS icon grid: art inset inside the canvas
let corner = 185.4
let markShare = 0.88      // how much of the plate the mark may occupy
let saturation = 1.35
let contrast = 1.06
let brightness = -0.012

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("\(message)\n".utf8))
    exit(1)
}

guard let data = try? Data(contentsOf: source),
      let original = NSBitmapImageRep(data: data)?.cgImage else {
    fail("missing icon source at \(source.path)")
}

let input = CIImage(cgImage: original)
let graded = input.applyingFilter("CIColorControls", parameters: [
    kCIInputSaturationKey: saturation,
    kCIInputContrastKey: contrast,
    kCIInputBrightnessKey: brightness
])
guard let art = CIContext().createCGImage(graded, from: input.extent) else {
    fail("cannot grade icon source")
}

// The source is a mark floating in a white field. Measure the mark itself so
// the margin around it is an intended optical margin, not whatever padding the
// artwork happened to ship with.
let width = art.width
let height = art.height
var pixels = [UInt8](repeating: 0, count: width * height * 4)
guard let scan = CGContext(
    data: &pixels,
    width: width,
    height: height,
    bitsPerComponent: 8,
    bytesPerRow: width * 4,
    space: CGColorSpace(name: CGColorSpace.sRGB)!,
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
) else {
    fail("cannot scan icon source")
}
scan.draw(art, in: CGRect(x: 0, y: 0, width: width, height: height))

var minX = width, minY = height, maxX = 0, maxY = 0
for y in 0..<height {
    for x in 0..<width {
        let offset = (y * width + x) * 4
        let r = Int(pixels[offset]), g = Int(pixels[offset + 1]), b = Int(pixels[offset + 2])
        let darkness = 255 - min(r, min(g, b))
        let chroma = max(r, max(g, b)) - min(r, min(g, b))
        if darkness > 12 || chroma > 10 {
            minX = min(minX, x); maxX = max(maxX, x)
            minY = min(minY, y); maxY = max(maxY, y)
        }
    }
}
guard minX <= maxX, minY <= maxY else { fail("icon source has no visible mark") }
let box = CGRect(x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1)
guard let mark = art.cropping(to: box) else { fail("cannot crop the mark") }

let inset = (canvas - plateSize) / 2
let plate = CGRect(x: inset, y: inset, width: plateSize, height: plateSize)
let shape = CGPath(roundedRect: plate, cornerWidth: corner, cornerHeight: corner, transform: nil)

guard let context = CGContext(
    data: nil,
    width: Int(canvas),
    height: Int(canvas),
    bitsPerComponent: 8,
    bytesPerRow: 0,
    space: CGColorSpace(name: CGColorSpace.sRGB)!,
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
) else {
    fail("cannot allocate icon context")
}

// macOS expects the drop shadow to live in the file rather than being applied
// by the system, and it is what separates a white plate from a white window.
context.saveGState()
context.setShadow(
    offset: CGSize(width: 0, height: -12),
    blur: 24,
    color: CGColor(gray: 0, alpha: 0.22))
context.addPath(shape)
context.setFillColor(CGColor(gray: 1, alpha: 1))
context.fillPath()
context.restoreGState()

context.saveGState()
context.addPath(shape)
context.clip()
let target = plateSize * markShare
let scale = min(target / box.width, target / box.height)
let size = CGSize(width: box.width * scale, height: box.height * scale)
context.interpolationQuality = .high
context.draw(mark, in: CGRect(
    x: (canvas - size.width) / 2,
    y: (canvas - size.height) / 2,
    width: size.width,
    height: size.height))
context.restoreGState()

guard let composed = context.makeImage() else { fail("cannot compose icon") }

let work = URL(fileURLWithPath: NSTemporaryDirectory())
    .appendingPathComponent("aru-host-appicon-\(UUID().uuidString)")
let iconset = work.appendingPathComponent("AppIcon.iconset")
try FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)
defer { try? FileManager.default.removeItem(at: work) }

let master = work.appendingPathComponent("icon-1024.png")
let rendered = NSBitmapImageRep(cgImage: composed)
rendered.size = NSSize(width: canvas, height: canvas)
guard let png = rendered.representation(using: .png, properties: [:]) else {
    fail("cannot encode icon")
}
try png.write(to: master)

func run(_ launchPath: String, _ arguments: [String]) throws {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: launchPath)
    process.arguments = arguments
    process.standardOutput = FileHandle.nullDevice
    try process.run()
    process.waitUntilExit()
    guard process.terminationStatus == 0 else { fail("\(launchPath) failed") }
}

for points in [16, 32, 128, 256, 512] {
    for scaleFactor in [1, 2] {
        let side = points * scaleFactor
        let suffix = scaleFactor == 1 ? "" : "@2x"
        try run("/usr/bin/sips", [
            "-z", "\(side)", "\(side)", master.path,
            "--out", iconset.appendingPathComponent("icon_\(points)x\(points)\(suffix).png").path
        ])
    }
}

try run("/usr/bin/iconutil", ["--convert", "icns", iconset.path, "--output", output.path])
print("wrote \(output.path) from mark \(box.width)x\(box.height) at \(Int(markShare * 100))% of the plate")
