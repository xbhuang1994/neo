import Cocoa
import FlutterMacOS

class MainFlutterWindow: NSWindow {
  override func awakeFromNib() {
    let flutterViewController = FlutterViewController()
    let windowFrame = self.frame
    self.contentViewController = flutterViewController
    self.setFrame(windowFrame, display: true)
    self.title = "Neo"
    self.minSize = NSSize(width: 420, height: 520)
    self.setFrameAutosaveName("NeoAgentMainWindow")

    // A second launch of the app asks this one, through the Dart side, to come to the front.
    let channel = FlutterMethodChannel(
      name: "neo_agent/window", binaryMessenger: flutterViewController.engine.binaryMessenger)
    channel.setMethodCallHandler { [weak self] call, result in
      guard call.method == "focus" else {
        result(FlutterMethodNotImplemented)
        return
      }
      if let window = self {
        if window.isMiniaturized { window.deminiaturize(nil) }
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
      }
      result(nil)
    }

    RegisterGeneratedPlugins(registry: flutterViewController)

    super.awakeFromNib()
  }
}
