import AppKit
import SwiftUI

@main
struct DocifyAdminApp: App {
    init() {
        // Started from `swift run` there is no app bundle, so make the window come to the front.
        NSApplication.shared.setActivationPolicy(.regular)
        NSApplication.shared.activate(ignoringOtherApps: true)
    }

    var body: some Scene {
        WindowGroup("Docify") {
            ContentView()
                .frame(minWidth: 820, minHeight: 460)
        }
        Settings {
            SettingsView()
        }
    }
}

@MainActor
final class Store: ObservableObject {
    @Published var sources: [SourceInfo] = []
    @Published var error: String?
    @Published var log = ""
    /// Prepare runs that this app started, by source id.
    @Published var running: [String: Process] = [:]

    func refresh() async {
        do {
            sources = try await DocifyCLI.sources()
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    func add(library: String, locator: String, version: String) async {
        var args = ["add", library, locator]
        if !version.isEmpty { args += ["--version", version] }
        await perform(args)
    }

    func remove(_ id: String) async {
        await perform(["remove", id])
    }

    func prepare(_ id: String, graph: Bool, force: Bool) {
        var args = ["prepare", id]
        if !graph { args.append("--no-graph") }
        if force { args.append("--force") }
        let p = DocifyCLI.makeProcess(args)
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = pipe
        pipe.fileHandleForReading.readabilityHandler = { handle in
            let text = String(decoding: handle.availableData, as: UTF8.self)
            guard !text.isEmpty else { return }
            Task { @MainActor in self.log += text }
        }
        p.terminationHandler = { proc in
            pipe.fileHandleForReading.readabilityHandler = nil
            Task { @MainActor in
                self.running[id] = nil
                self.log += "prepare \(id) exited with \(proc.terminationStatus)\n"
                await self.refresh()
            }
        }
        do {
            try p.run()
            running[id] = p
            log += "$ docify \(args.joined(separator: " "))\n"
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// SIGINT matches Ctrl-C in the CLI, which aborts and keeps the previous generation.
    func cancel(_ id: String) {
        running[id]?.interrupt()
    }

    private func perform(_ args: [String]) async {
        log += "$ docify \(args.joined(separator: " "))\n"
        do {
            log += try await DocifyCLI.run(args)
            error = nil
        } catch {
            self.error = error.localizedDescription
            log += "error: \(error.localizedDescription)\n"
        }
        await refresh()
    }
}

struct ContentView: View {
    @StateObject private var store = Store()
    @State private var selection: SourceInfo.ID?
    @State private var showAdd = false
    @State private var confirmRemove = false
    @State private var withGraph = true
    @State private var force = false

    private var selected: SourceInfo? { store.sources.first { $0.id == selection } }

    var body: some View {
        VStack(spacing: 0) {
            Table(store.sources, selection: $selection) {
                TableColumn("ID", value: \.id)
                TableColumn("Library", value: \.library)
                TableColumn("Version") { Text($0.version ?? "unknown") }
                TableColumn("Kind", value: \.kind).width(50)
                TableColumn("State") { s in
                    Text(store.running[s.id] != nil ? "preparing" : s.state).foregroundStyle(color(for: s))
                }.width(80)
                TableColumn("Latest") { s in Text(latestText(s)).help(latestText(s)) }
                TableColumn("Embeddings") { s in Text(s.activeGeneration?.embeddingModel ?? "") }
                TableColumn("Location", value: \.locator)
            }
            if let error = store.error {
                Text(error).foregroundStyle(.red).textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(8)
            }
            Divider()
            ScrollView {
                Text(store.log.isEmpty ? "Log is empty." : store.log)
                    .font(.system(.caption, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(8)
            }
            .defaultScrollAnchor(.bottom)
            .frame(height: 120)
        }
        .toolbar {
            Button { showAdd = true } label: { Label("Add", systemImage: "plus") }
            Button { Task { await store.refresh() } } label: { Label("Refresh", systemImage: "arrow.clockwise") }
            Toggle("Graph", isOn: $withGraph).help("Run Graphify extraction (calls an LLM)")
            Toggle("Force", isOn: $force).help("Rebuild even if nothing changed")
            if let s = selected, store.running[s.id] != nil {
                Button { store.cancel(s.id) } label: { Label("Cancel", systemImage: "stop.fill") }
            } else {
                Button { if let s = selected { store.prepare(s.id, graph: withGraph, force: force) } } label: {
                    Label("Prepare", systemImage: "play.fill")
                }.disabled(selected == nil)
            }
            Button(role: .destructive) { confirmRemove = true } label: { Label("Remove", systemImage: "trash") }
                .disabled(selected == nil || selected.map { store.running[$0.id] != nil } == true)
            SettingsLink { Label("Settings", systemImage: "gearshape") }
        }
        .sheet(isPresented: $showAdd) {
            AddSourceView { library, locator, version in
                Task { await store.add(library: library, locator: locator, version: version) }
            }
        }
        .confirmationDialog("Remove \(selection ?? "")?", isPresented: $confirmRemove) {
            Button("Remove", role: .destructive) {
                if let id = selection { Task { await store.remove(id) } }
            }
        } message: {
            Text("Deletes the source and its prepared data from the Docify store.")
        }
        .task {
            // Poll so progress from any docify process (this app, CLI, web UI) shows up.
            while !Task.isCancelled {
                await store.refresh()
                try? await Task.sleep(for: .seconds(3))
            }
        }
    }

    private func latestText(_ s: SourceInfo) -> String {
        guard let g = s.latest else { return "" }
        if let e = g.error { return "\(g.status): \(e)" }
        return [g.status, g.phase, g.progress].compactMap { $0 }.joined(separator: " ")
    }

    private func color(for s: SourceInfo) -> Color {
        switch s.state {
        case "ready": .green
        case "failed": .red
        case "stale": .orange
        case "preparing": .blue
        default: .secondary
        }
    }
}

struct AddSourceView: View {
    let onAdd: (String, String, String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var library = ""
    @State private var locator = ""
    @State private var version = ""

    var body: some View {
        Form {
            TextField("Library", text: $library)
            HStack {
                TextField("Path or URL", text: $locator)
                Button("Choose…") { choose() }
            }
            TextField("Version (optional)", text: $version)
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
                Button("Add") {
                    onAdd(library.trimmed, locator.trimmed, version.trimmed)
                    dismiss()
                }
                .keyboardShortcut(.defaultAction)
                .disabled(library.trimmed.isEmpty || locator.trimmed.isEmpty)
            }
        }
        .padding()
        .frame(width: 460)
    }

    private func choose() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = true
        if panel.runModal() == .OK, let url = panel.url { locator = url.path }
    }
}

private extension String {
    var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
}
