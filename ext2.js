// ---------------------------------------------------------------------------
// NS Glucose -- ext2.js
// Register the notification characteristic for the BLE connection.
//
// Loaded from main.js via loadExt(2) when advancing to UUID registration,
// then freed (main.js sets ext = undefined) so this closure can be GC'd.
// Filename must start with 'ext' or the build system will exclude it.
//
// Service:        F17F3300-386E-46B5-A72A-C2FC31F7A639  (little-endian)
// Characteristic: 2670495C-EC30-4317-BF55-886E6B738BB1  (little-endian;
//                 protocol v2, see PROTOCOL.md)
// charId == 0 (framework convention for notification characteristics)
// ---------------------------------------------------------------------------
function(connection) {
  appConn.regUuid(
    connection,
    0, // notification characteristic id
    [0x39,0xA6,0xF7,0x31,0xFC,0xC2,0x2A,0xA7,0xB5,0x46,0x6E,0x38,0x00,0x33,0x7F,0xF1],
    [0xB1,0x8B,0x73,0x6B,0x6E,0x88,0x55,0xBF,0x17,0x43,0x30,0xEC,0x5C,0x49,0x70,0x26]
  );
}