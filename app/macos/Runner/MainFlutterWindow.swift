import Cocoa
import FlutterMacOS

class MainFlutterWindow: NSWindow {
  private weak var flutterViewController: FlutterViewController?
  private var windowChannel: FlutterMethodChannel?

  override func awakeFromNib() {
    let flutterViewController = FlutterViewController()
    self.flutterViewController = flutterViewController
    let windowFrame = self.frame
    self.contentViewController = flutterViewController
    self.setFrame(windowFrame, display: true)
    self.title = "Neo"
    self.minSize = NSSize(width: 420, height: 520)
    self.setFrameAutosaveName("NeoAgentMainWindow")

    // A second launch of the app asks this one, through the Dart side, to come to the front.
    let channel = FlutterMethodChannel(
      name: "neo_agent/window", binaryMessenger: flutterViewController.engine.binaryMessenger)
    self.windowChannel = channel
    channel.setMethodCallHandler { [weak self] call, result in
      guard call.method == "focus" else {
        result(FlutterMethodNotImplemented)
        return
      }
      if let window = self {
        if window.isMiniaturized { window.deminiaturize(nil) }
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
        window.ensureFlutterFirstResponder()
      }
      result(nil)
    }

    RegisterGeneratedPlugins(registry: flutterViewController)

    super.awakeFromNib()
    ensureFlutterFirstResponder()
  }

  override func becomeKey() {
    super.becomeKey()
    ensureFlutterFirstResponder()
  }

  override func performKeyEquivalent(with event: NSEvent) -> Bool {
    ensureFlutterFirstResponder()
    return super.performKeyEquivalent(with: event)
  }

  func ensureFlutterFirstResponder() {
    guard let wrapperView = flutterViewController?.view else { return }
    // Keep focus on FlutterView, FlutterTextInputPlugin, or accessibility text fields.
    if let responderView = firstResponder as? NSView, responderView.isDescendant(of: wrapperView) {
      return
    }
    if let target = wrapperView.subviews.first(where: { $0.acceptsFirstResponder })
      ?? (wrapperView.acceptsFirstResponder ? wrapperView : nil)
    {
      makeFirstResponder(target)
    }
  }

  func dispatchEditAction(_ action: String) {
    windowChannel?.invokeMethod("editAction", arguments: action)
  }
}
