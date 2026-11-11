import FrameOSKit
import SwiftUI

struct SignInView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.openURL) private var openURL
    @Environment(\.dismiss) private var dismiss
    @Environment(\.webAuthenticationSession) private var webAuthenticationSession
    @State private var model = SignInModel()
    /// Shown from Settings → Add account (dismissable), or as the first screen.
    var isSheet = false
    var startWithBackend = false

    var body: some View {
        NavigationStack {
            Form {
                header
                switch model.step {
                case .cloud: cloudFields
                case .cloudCode: codeFields
                case .backend: backendFields
                }
                if let error = model.error {
                    Section { Label(error, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.red) }
                }
                Section {
                    AsyncButton {
                        await model.submit(app: app)
                    } label: {
                        Text(submitTitle).frame(maxWidth: .infinity).fontWeight(.semibold)
                    }
                    .disabled(!model.canSubmit)
                }
                if model.step == .cloud { webSignIn }
                alternatives
            }
            .navigationTitle(isSheet ? "Add account" : "")
            .inlineTitle()
            .toolbar {
                if isSheet {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                }
            }
            .onAppear { if startWithBackend { model.useBackend() } }
            .onChange(of: app.current?.id) { _, _ in if isSheet { dismiss() } }
        }
    }

    var submitTitle: String {
        switch model.step {
        case .cloud: return "Sign in"
        case .cloudCode: return "Verify"
        case .backend: return model.backendNeedsSignUp ? "Create account" : "Sign in"
        }
    }

    @ViewBuilder var header: some View {
        Section {
            VStack(spacing: 10) {
                Image("Logo", bundle: nil)
                    .resizable()
                    .scaledToFit()
                    .frame(width: 64, height: 64)
                    .accessibilityHidden(true)
                Text(model.step == .backend ? "Self-hosted backend" : "FrameOS")
                    .font(.title.weight(.bold))
                Text(model.step == .backend
                    ? "Sign in to the FrameOS backend you run yourself."
                    : "Control your frames, scenes and photos.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 8)
        }
        .listRowBackground(Color.clear)
    }

    @ViewBuilder var cloudFields: some View {
        Section {
            TextField("Email", text: $model.email).emailInput()
            SecureField("Password", text: $model.password).passwordInput()
                .onSubmit { Task { await model.submit(app: app) } }
        } header: {
            Text("FrameOS Cloud")
        } footer: {
            if model.showCloudAddress {
                TextField("Cloud address", text: $model.cloudAddress).urlInput()
            }
        }
    }

    @ViewBuilder var codeFields: some View {
        Section {
            TextField("123456", text: $model.code).codeInput()
                .font(.title3.monospacedDigit())
                .onSubmit { Task { await model.submit(app: app) } }
        } header: {
            Text("Two-factor sign-in")
        } footer: {
            Text("Type the code from your authenticator app, or one of your recovery codes.")
        }
    }

    @ViewBuilder var backendFields: some View {
        Section {
            TextField("frameos.local:8989", text: $model.backendAddress).urlInput()
                .onSubmit { Task { await model.checkBackend() } }
                .onChange(of: model.backendAddress) { _, _ in model.backendNeedsSignUp = false }
        } header: {
            Text("Backend address")
        } footer: {
            Text("The address you open the backend at in a browser. Without a port it is 8989.")
        }
        Section {
            TextField("Email", text: $model.email).emailInput()
            SecureField(model.backendNeedsSignUp ? "Password (8 characters or more)" : "Password", text: $model.password)
                .passwordInput(new: model.backendNeedsSignUp)
                .onSubmit { Task { await model.submit(app: app) } }
        } footer: {
            if model.backendNeedsSignUp {
                Text("This backend has no account yet: this creates the first one.")
            } else {
                Text("The app keeps a year-long API token for this backend, listed in its Settings → API tokens and revoked when you sign out here.")
            }
        }
        .task(id: model.backendAddress) {
            try? await Task.sleep(nanoseconds: 700_000_000)
            await model.checkBackend()
        }
    }

    /// Google and the rest of the web's sign-in (passkeys), through the
    /// system's sign-in sheet (CloudWebSignIn).
    @ViewBuilder var webSignIn: some View {
        Section {
            AsyncButton {
                await model.signInOnWeb(app: app, provider: .google) { try await WebSignIn.open(webAuthenticationSession, $0) }
            } label: {
                Label("Continue with Google", systemImage: "person.crop.circle.badge.checkmark")
                    .frame(maxWidth: .infinity)
            }
            AsyncButton {
                await model.signInOnWeb(app: app, provider: nil) { try await WebSignIn.open(webAuthenticationSession, $0) }
            } label: {
                Label("Use a passkey or another way", systemImage: "person.badge.key")
                    .frame(maxWidth: .infinity)
            }
        } footer: {
            Text("Opens the FrameOS Cloud sign-in page. The app gets a sign-in of its own; your password never passes through it.")
        }
    }

    @ViewBuilder var alternatives: some View {
        switch model.step {
        case .cloud:
            Section {
                Button("Create a FrameOS Cloud account") { openWeb("/signup") }
                Button("Forgot your password?") { openWeb("/recovery") }
                Button(model.showCloudAddress ? "Use cloud.frameos.net" : "Use another cloud address") {
                    model.showCloudAddress.toggle()
                    if !model.showCloudAddress { model.cloudAddress = Account.defaultCloudURL.absoluteString }
                }
            }
            Section {
                Button {
                    model.useBackend()
                } label: {
                    Label("Sign in to a self-hosted backend", systemImage: "server.rack")
                }
            }
        case .cloudCode:
            Section { Button("Start again") { model.useCloud() } }
        case .backend:
            Section {
                Button {
                    model.useCloud()
                } label: {
                    Label("Sign in to FrameOS Cloud instead", systemImage: "cloud")
                }
            }
        }
    }

    func openWeb(_ path: String) {
        guard let base = model.cloudURL, let url = URL(string: path, relativeTo: base) else { return }
        openURL(url)
    }
}
