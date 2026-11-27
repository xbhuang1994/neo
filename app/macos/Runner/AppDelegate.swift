import Cocoa
import FlutterMacOS

@main
class AppDelegate: FlutterAppDelegate {
  override func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    return true
  }

  override func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool {
    return true
  }

  private var activeMainWindow: MainFlutterWindow? {
    return NSApp.keyWindow as? MainFlutterWindow
  }

  @objc(copy:)
  func handleEditCopy(_ sender: Any?) {
    activeMainWindow?.dispatchEditAction("copy")
  }

  @objc(cut:)
  func handleEditCut(_ sender: Any?) {
    activeMainWindow?.dispatchEditAction("cut")
  }

  @objc(paste:)
  func handleEditPaste(_ sender: Any?) {
    activeMainWindow?.dispatchEditAction("paste")
  }

  @objc(selectAll:)
  func handleEditSelectAll(_ sender: Any?) {
    activeMainWindow?.dispatchEditAction("selectAll")
  }
}
