import Foundation
import Photos
import SwiftUI
import UIKit

/// A downloaded message image that can be opened without fetching the
/// expiring/provider URL a second time.
struct MessageImageResource: Identifiable {
    let id = UUID()
    let image: UIImage
    let data: Data
}

/// Loads a message attachment with explicit retry and error states. AsyncImage
/// only exposes a rendered SwiftUI Image, which cannot then be written to the
/// user's photo library without downloading the attachment again.
struct RemoteMessageImage: View {
    let url: URL
    let open: (MessageImageResource) -> Void

    @State private var image: UIImage?
    @State private var imageData: Data?
    @State private var isLoading = false
    @State private var errorMessage: String?

    var body: some View {
        Group {
            if let image, let imageData {
                Button {
                    open(MessageImageResource(image: image, data: imageData))
                } label: {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFit()
                        .frame(maxWidth: 240, maxHeight: 320)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Message image")
                .accessibilityHint("Opens the image with an option to save it to Photos")
            } else if isLoading {
                ProgressView("Loading image…")
                    .frame(width: 180, height: 120)
            } else {
                VStack(spacing: 8) {
                    Image(systemName: "photo.badge.exclamationmark")
                        .font(.title2)
                    Text(errorMessage ?? "Image unavailable")
                        .font(.caption)
                        .multilineTextAlignment(.center)
                    Button("Try Again") { Task { await load(force: true) } }
                        .font(.caption.bold())
                }
                .foregroundStyle(.secondary)
                .frame(width: 180, height: 120)
                .accessibilityElement(children: .combine)
            }
        }
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .task(id: url) { await load(force: false) }
    }

    @MainActor
    private func load(force: Bool) async {
        guard force || (image == nil && !isLoading) else { return }
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }

        do {
            var request = URLRequest(url: url)
            request.cachePolicy = .returnCacheDataElseLoad
            request.timeoutInterval = 30
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let response = response as? HTTPURLResponse,
                  (200...299).contains(response.statusCode) else {
                throw MessageImageError.downloadFailed
            }
            guard data.count <= 15 * 1024 * 1024 else {
                throw MessageImageError.tooLarge
            }
            guard let decoded = UIImage(data: data) else {
                throw MessageImageError.unsupportedFormat
            }
            image = decoded
            imageData = data
        } catch is CancellationError {
            // Leaving the conversation cancels the task; that is not an error
            // the user needs to see.
        } catch {
            errorMessage = (error as? LocalizedError)?.errorDescription ?? "Image unavailable"
        }
    }
}

struct MessageImageViewer: View {
    let resource: MessageImageResource

    @Environment(\.dismiss) private var dismiss
    @State private var isSaving = false
    @State private var didSave = false
    @State private var saveError: String?

    var body: some View {
        NavigationStack {
            ZStack {
                Color.black.ignoresSafeArea()
                Image(uiImage: resource.image)
                    .resizable()
                    .scaledToFit()
                    .accessibilityLabel("Message image")
            }
            .navigationTitle("Photo")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarColorScheme(.dark, for: .navigationBar)
            .toolbarBackground(Color.black, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                        .disabled(isSaving)
                }
                ToolbarItem(placement: .primaryAction) {
                    Button(action: save) {
                        if isSaving {
                            ProgressView()
                        } else {
                            Label(didSave ? "Saved" : "Save", systemImage: didSave ? "checkmark" : "square.and.arrow.down")
                        }
                    }
                    .disabled(isSaving || didSave)
                    .accessibilityHint("Saves this image to your Photos library")
                }
            }
            .overlay(alignment: .bottom) {
                if didSave {
                    Label("Saved to Photos", systemImage: "checkmark.circle.fill")
                        .font(.subheadline.bold())
                        .padding(.horizontal, 14)
                        .padding(.vertical, 9)
                        .foregroundStyle(.white)
                        .background(.green.opacity(0.9), in: Capsule())
                        .padding(.bottom, 18)
                }
            }
        }
        .alert("Couldn’t save image", isPresented: Binding(
            get: { saveError != nil },
            set: { if !$0 { saveError = nil } }
        )) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(saveError ?? "Please try again.")
        }
    }

    private func save() {
        isSaving = true
        Task {
            defer { isSaving = false }
            do {
                try await PhotoLibrarySaver.save(resource.data)
                didSave = true
            } catch {
                saveError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            }
        }
    }
}

private enum MessageImageError: LocalizedError {
    case downloadFailed
    case tooLarge
    case unsupportedFormat

    var errorDescription: String? {
        switch self {
        case .downloadFailed: return "Image couldn’t be downloaded."
        case .tooLarge: return "Image is too large to open."
        case .unsupportedFormat: return "Image format isn’t supported."
        }
    }
}

private enum PhotoLibrarySaveError: LocalizedError {
    case invalidImage
    case permissionDenied
    case writeFailed

    var errorDescription: String? {
        switch self {
        case .invalidImage:
            return "The attachment is not a valid image."
        case .permissionDenied:
            return "Photo access is off. Allow Shore Academy to add photos in iPhone Settings, then try again."
        case .writeFailed:
            return "The image could not be added to Photos. Please check available storage and try again."
        }
    }
}

private enum PhotoLibrarySaver {
    static func save(_ data: Data) async throws {
        guard UIImage(data: data) != nil else { throw PhotoLibrarySaveError.invalidImage }

        let status = await PHPhotoLibrary.requestAuthorization(for: .addOnly)
        guard status == .authorized || status == .limited else {
            throw PhotoLibrarySaveError.permissionDenied
        }

        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            PHPhotoLibrary.shared().performChanges {
                let request = PHAssetCreationRequest.forAsset()
                request.addResource(with: .photo, data: data, options: nil)
            } completionHandler: { success, error in
                if success {
                    continuation.resume()
                } else {
                    continuation.resume(throwing: error ?? PhotoLibrarySaveError.writeFailed)
                }
            }
        }
    }
}
