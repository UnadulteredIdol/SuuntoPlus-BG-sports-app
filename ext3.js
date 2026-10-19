// ---------------------------------------------------------------------------
// NS Glucose -- ext3.js
// Test harness: returns one simulated reading for main.js to display, and
// seeds the graph buffer on the first call.
// (ext files can't write outputs themselves: the build rewrites output.x
// accesses in main.js only.)
//
// Loaded from main.js via loadExt(3) only when TEST_MODE = 1, once per
// scenario step, then freed (main.js sets ext = undefined). Keeping the
// scenario table here keeps it out of the shipped main.js.
//
// Each row: [glucose mmol/L, trend byte 0-7, age seconds, rate x10, status]
// Rate is per-5-min convention: +3 = +0.3 mmol/L / 5 min.
// Glucose 0 = no data (exercises the gray / "--.-" path). Status 3-5 shows
// the key/clock messages; see main.js for the codes.
// ---------------------------------------------------------------------------
function(step, graph) {
  var scenario = [
    [7.2,  4,   2,    1, 0],
    [7.4,  3,   3,    3, 0],
    [7.5,  2,   4,    5, 0],
    [11.0, 1,   5,   -2, 0],
    [3.8,  6,   6,  -10, 0],
    [4.5,  5,   7,   -5, 0],
    [5.5,  4, 400,    0, 1],
    [0,    0,   0,    0, 2],
    [0,    0,   0,    0, 3],
    [6.1,  4,  60,    0, 4],
    [6.1,  4,  60,    0, 5]
  ];
  // First call: fill the 30-minute graph with a gentle dip so the
  // simulator shows a full chart straight away.
  if (step == 0) {
    for (var i = 0; i < 30; i++) { graph[i] = 70 + Math.round(18 * Math.sin(i / 4.5)); }
  }
  return scenario[step % scenario.length];
}
