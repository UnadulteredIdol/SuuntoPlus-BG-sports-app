// ---------------------------------------------------------------------------
// NS Glucose -- ext1.js
// Connect to the NS Glucose BLE bridge peripheral.
//
// Loaded from main.js via loadExt(1) on first BLE state-machine entry,
// then freed (main.js sets ext = undefined) so this closure can be GC'd.
//
// Service UUID: F17F3300-386E-46B5-A72A-C2FC31F7A639  (128-bit, little-endian)
// ---------------------------------------------------------------------------
function(evHandler) {
  return appConn.connect(
    enabledZappId,
    evHandler,

    // 128-bit service UUID, little-endian
    // Search from both partial (6) and complete (7) lists of 128-bit UUIDs
    [6, 0x39,0xA6,0xF7,0x31,0xFC,0xC2,0x2A,0xA7,0xB5,0x46,0x6E,0x38,0x00,0x33,0x7F,0xF1],
    [7, 0x39,0xA6,0xF7,0x31,0xFC,0xC2,0x2A,0xA7,0xB5,0x46,0x6E,0x38,0x00,0x33,0x7F,0xF1]
  );
}