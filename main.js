// ---------------------------------------------------------------------------
// NS Glucose -- SuuntoPlus main.js
//
// Receives sealed glucose packets from the companion iOS bridge over BLE and
// displays current glucose, trend, age, and rate-of-change on the watch,
// a 30-minute graph, optional alerts (low, falling fast, high, signal lost)
// and a post-workout summary.
//
// This file follows the Suunto "ext-files for memory safety" idiom. Each ext
// file is loaded from flash on demand, executed once, then freed for GC:
//   ext1.js  BLE connect          ext3.js  test harness (TEST_MODE only)
//   ext2.js  UUID registration    ext4.js  packet verify + decrypt
//
// BLE packet: 13 bytes, encrypted and authenticated with the shared bridge
// key -- see ext4.js. The decrypted reading is:
//   glucose x100 (uint16), trend 0-7, age in minutes (capped 255),
//   rate int8 x10 in mmol/L per 5 min (+8 = +0.8 mmol/L per 5 min)
//
// Settings: low / high thresholds, stale age, alerts on/off, record in
// workout, bridge key (32 hex digits shown in the bridge app). Builds
// deployed from the SuuntoPlus Editor read them from data.json only -- the
// Suunto app's settings screen applies to store installs.
//
// Outputs (all numeric -- SuuntoPlus does not support string outputs):
//   con                  : mandatory "connection alive" flag for device-type
//                          apps. Nonzero closes the Searching-view popup.
//   glucoseNow           : mmol/L for display, undefined = no data
//   bloodGlucoseExercise : mmol/L, logged for the post-workout graph. Only
//                          set for fresh readings with recording enabled.
//   minutesAgo           : seconds since last reading, 9999 = no data
//   deltaRate            : rate x10 as signed integer  (1 = +0.1 per 5 min)
//   gPoint               : 30-minute graph, streamed one slot per second as
//                          index * 256 + value (see "Graph" below)
//   pumpState            : (IOB x100 + 32768) * 256 + loop age in minutes;
//                          IOB part 0 = unknown, loop 255 = unknown
//   glState              : trend + 8 * colour + 32 * status, packed into one
//                          output because a sport mode allows only ~15
//                          subscriptions in total:
//                            trend  0-7
//                            colour 0=gray 1=green 2=orange 3=red
//                            status 0 ok, 1 stale, 2 no data, 3 no key set,
//                                   4 wrong key, 5 replayed packet / clock off
// ---------------------------------------------------------------------------

var TEST_MODE = 0;

// --- Settings ----------------------------------------------------------------
var LOW_THRESH, HIGH_THRESH, AGE_STALE_SEC, ALERTS_ON, RECORD_ON, BRIDGE_KEY;

var loadSettings = function() {
  var s = null;
  try {
    if (typeof localStorage !== 'undefined') { s = localStorage.getObject('settings'); }
  } catch (e) { s = null; }
  s = s || {};
  var num  = function(v, d) { v = +v; return v > 0 ? v : d; };
  var flag = function(v, d) { return (v === undefined || v === null) ? d : (v === true || v === 'true'); };
  LOW_THRESH    = num(s.lowMmol, 5.0);
  HIGH_THRESH   = num(s.highMmol, 10.0);
  AGE_STALE_SEC = num(s.staleMin, 6) * 60; // older readings turn gray
  ALERTS_ON     = flag(s.alerts, true);
  RECORD_ON     = flag(s.record, true);
  BRIDGE_KEY    = s.bridgeKey ? '' + s.bridgeKey : '';
};

// --- State machine & BLE connection plumbing -------------------------------
var state, connection, registered, exerciseStarted;
var charId = 0; // notification characteristic, matches ext2.js
var waitingState = 99;

// --- Failure retry ----------------------------------------------------------
// On a failed connect/register/config the state machine parks in retryWaitState
// for retryDelay seconds, then re-enters retryState. The delay doubles per
// consecutive failure (5 s -> 60 s cap) and resets once notifications are on.
var retryWaitState  = 98;
var RETRY_MIN       = 5;
var RETRY_MAX       = 60;
var retryState      = 0;
var retryWait       = 0;
var retryDelay      = RETRY_MIN;

var scheduleRetry = function(target) {
  retryState = target;
  retryWait  = retryDelay;
  retryDelay = (retryDelay * 2 > RETRY_MAX) ? RETRY_MAX : retryDelay * 2;
  state = retryWaitState;
};

// --- External-function holder ---------------------------------------------
// All ext files assign into this single var. Overwriting it lets the previous
// closure be GC'd before the next one is allocated. This mirrors the Suunto
// reference example pattern and is the documented memory-safety idiom.
var ext;

var loadExt = function(ix) {
  ext = undefined; // gc hint -- allow previous ext to be collected first
  ext = evalFile('{file_path}/ext' + ix + '.js');
};

// --- Read-heartbeat: only when the bridge has gone quiet --------------------
// The bridge notifies on every new CGM reading, so the watch only reads when
// nothing has arrived for READ_INTERVAL seconds (every accepted packet resets
// the count). With 1-minute sensors this almost never fires.
var readTick      = 0;
var READ_INTERVAL = 60;

// --- Decoded BLE values (refreshed on every accepted packet) ---------------
var rawGlucose      = 0;
var trend           = 0;
var localAgeSeconds = 0; // age of the newest reading; keeps counting while disconnected
var rateRaw         = 0; // int8 x10
var watchNow;            // watch clock (unix s), from the "now" input
var lastNonce       = 0; // newest accepted packet; older ones are replays
var packetError     = 0; // status code of the last rejected packet, 0 = none
var pumpIob         = -32768; // IOB x100 from the bridge, -32768 = unknown (MDI)
var loopOffset      = 99999;  // loop age minus reading age, in s; 99999 = unknown

// --- Sentinels -------------------------------------------------------------
var NO_DATA = 9999;

// --- Colour logic ----------------------------------------------------------
// Gray overrides everything else when data is missing or stale, so a
// forgotten phone in the changing room doesn't keep showing a "green" reading
// from 20 minutes ago.
var colorIndex = function(raw, ageSec) {
  if (raw <= 0)                return 0;
  if (ageSec >= AGE_STALE_SEC) return 0;
  if (raw < LOW_THRESH)        return 3;
  if (raw > HIGH_THRESH)       return 2;
  return 1;
};

// --- Blank all glucose outputs (startup, disconnect, no reading yet) -------
var writeNoData = function(output) {
  output.glucoseNow           = undefined;
  output.bloodGlucoseExercise = undefined;
  output.minutesAgo           = NO_DATA;
  output.deltaRate            = 0;
  output.glState              = 32 * (packetError || 2);
};

// --- Open a sealed packet (shared by notification and read_done events) ----
// A rejected packet keeps the last good reading but flags the status, so a
// wrong key or a replay attempt is visible on the watch.
var openPacket = function(data) {
  var r = -2;
  try {
    loadExt(4);
    r = ext(data, BRIDGE_KEY, watchNow, lastNonce);
  } catch (e) { systemEvent('NSG open threw'); }
  ext = undefined;
  if (typeof r === 'number') {
    packetError = (r == -1) ? 3 : (r == -2) ? 4 : 5;
    return;
  }
  packetError     = 0;
  rawGlucose      = r[0];
  trend           = r[1];
  localAgeSeconds = r[2] * 60;
  rateRaw         = r[3];
  lastNonce       = r[4];
  pumpIob         = r[5];
  loopOffset      = (r[6] == 255) ? 99999 : (r[6] - r[2]) * 60;
  readTick        = 0;
};

// --- Alerts ------------------------------------------------------------------
// Vibrate (and beep, if tones are on) when glucose is low, falling fast or
// high. Repeats every 10 min while it lasts. "Falling fast" is the CGM's own
// SingleDown / DoubleDown arrow -- no extrapolation -- with the rate
// (-0.6 mmol/L per 5 min or steeper) as fallback when the arrow is unknown.
var ALERT_REPEAT_SEC = 600;
var LOSS_SEC         = 600; // signal-lost alert after 10 min without a reading
var alertKind = 0; // 0 none, 1 low, 2 high, 3 falling fast
var alertWait = 0;
var lossAlerted = false;

var checkAlerts = function() {
  var fast = trend >= 6 || (trend == 0 && rateRaw <= -6);
  var kind = (rawGlucose < LOW_THRESH) ? 1 : fast ? 3 : (rawGlucose > HIGH_THRESH) ? 2 : 0;
  if (kind != alertKind || (kind && --alertWait <= 0)) {
    if (kind && ALERTS_ON) { playIndication(kind == 2 ? 'Info' : 'Interval', false, kind == 1 ? 2 : 1); }
    alertKind = kind;
    alertWait = ALERT_REPEAT_SEC;
  }
};

// One buzz when no reading has arrived for 10 min (phone out of range,
// Nightscout down, bridge stopped), and one when readings are back.
var checkSignal = function() {
  var lost = localAgeSeconds >= LOSS_SEC;
  if (lost != lossAlerted) {
    lossAlerted = lost;
    if (ALERTS_ON) { playIndication(lost ? 'StopTimer' : 'Confirm', false, 1); }
  }
};

// --- Graph -------------------------------------------------------------------
// The last 30 minutes, one slot per minute (slot = unix minute % 30), value =
// mmol/L x 10, 0 = no reading. Readings land in the minute they were taken,
// so a 5-minute sensor fills every 5th slot and a 1-minute sensor all of them.
// main.js cannot hand arrays to the template, so sendGraph streams one slot
// per second through the gPoint output: 0-29 slots, 30 the newest slot's
// index. The template redraws after index 30, so about every 31 s.
var gBuf = new Uint8Array(30);
var gMin = 0; // unix minute of the newest slot
var gTx  = 0; // next slot to stream

var recordGraph = function() {
  var now = Math.floor(watchNow / 60), m;
  if (!(now > 0)) return;
  if (!gMin) { gMin = now; }
  for (m = gMin + 1; m <= now && m <= gMin + 30; m++) { gBuf[m % 30] = 0; } // drop minutes that left the window
  if (now > gMin) { gMin = now; }
  m = Math.floor((watchNow - localAgeSeconds) / 60);
  if (rawGlucose > 0 && m <= now && now - m < 30) { gBuf[m % 30] = Math.min(255, Math.round(rawGlucose * 10)); }
};

var sendGraph = function(output) {
  var i = gTx;
  gTx = (gTx + 1) % 31;
  output.gPoint = i * 256 + (i < 30 ? gBuf[i] : gMin % 30);
};

// --- Post-workout summary (sampled once per second from fresh readings) -----
// One array instead of five variables: Duktape grows its scope record once
// a script has more than ~56 top-level names.
// stats = [samples, sum, min, max, samples in range]
var stats = new Float32Array(5);

var recordStats = function() {
  if (stats[0] == 0 || rawGlucose < stats[2]) { stats[2] = rawGlucose; }
  if (rawGlucose > stats[3]) { stats[3] = rawGlucose; }
  stats[1] += rawGlucose;
  stats[0]++;
  if (rawGlucose >= LOW_THRESH && rawGlucose <= HIGH_THRESH) { stats[4]++; }
};

// ---------------------------------------------------------------------------
// BLE event handler -- dispatches state-machine transitions on framework
// events. The framework attempts automatic reconnection on DISCONNECT (101),
// which re-fires CONNECTED (100) and re-enters the registration flow. Failure
// events (108/110/112) schedule a delayed retry of the step that failed.
// ---------------------------------------------------------------------------
var bleEventHandler = function(characteristicId, eventId, data) {
  // systemEvent('BLE ', eventId); // uncomment to trace events in the watch log
  switch (eventId) {
    case 100: // CONNECTED
      // If we've already registered the characteristic (reconnect case),
      // skip straight to re-enabling notifications. Otherwise register first.
      if (!registered) { state = 1; } else { state = 4; }
      break;

    case 107: // UUID_REGISTERED
      registered = 1;
      state = 4; // next: enable notifications
      break;

    case 101: // DISCONNECTED (framework will auto-reconnect)
      state = 5;
      break;

    case 109: // CONFIG_DONE (notifications enabled)
      retryDelay = RETRY_MIN;
      state = 6;
      break;

    case 108: // UUID_REGISTER_FAILED
      systemEvent('NSG register failed');
      scheduleRetry(1);
      break;

    case 110: // CONFIG_FAILED
      systemEvent('NSG config failed');
      scheduleRetry(4);
      break;

    case 112: // CONNECT_FAILED
      systemEvent('NSG connect failed');
      connection = undefined;
      scheduleRetry(0);
      break;

    case 102: // READ_DONE
    case 106: // NOTIFICATION
      if (characteristicId == charId) { openPacket(data); }
      break;
  }
};

// ---------------------------------------------------------------------------
// Lifecycle callbacks
// ---------------------------------------------------------------------------
function onLoad(input, output) {
  loadSettings();
  packetError = BRIDGE_KEY ? 0 : 3;
  output.con = 0;
  writeNoData(output);
  registered      = 0;
  exerciseStarted = 0;
  state           = 0;
}

function onExerciseStart(input, output) {
  exerciseStarted = 1;
  if (rawGlucose <= 0) { localAgeSeconds = 0; } // give the link 10 min before "signal lost"
}

// ---------------------------------------------------------------------------
// Test harness -- feeds simulated data from ext3.js when TEST_MODE = 1.
// ---------------------------------------------------------------------------
var testTick = 0; // a new scenario row every 11 s

// ---------------------------------------------------------------------------
// Main loop -- fires ~1 Hz after onLoad, before and during the workout.
// ---------------------------------------------------------------------------
function evaluate(input, output) {
  // systemEvent('STATE ', state); // uncomment for state-machine debugging
  watchNow = input.now;

  // --- Test harness path: bypass BLE, feed outputs directly ---------------
  if (TEST_MODE) {
    // The simulator may not provide Dev/Time, so test mode keeps its own clock.
    if (!(watchNow > 0)) { watchNow = 1792000000 + testTick; }
    if (testTick % 11 == 0) {
      loadExt(3);
      var t = ext(testTick / 11, gBuf); // also seeds the graph on the first call
      ext = undefined;
      rawGlucose      = t[0];
      localAgeSeconds = t[2];
      output.con                  = 1;
      output.glucoseNow           = t[0] > 0 ? t[0] : undefined;
      output.bloodGlucoseExercise = (t[0] > 0 && t[2] < AGE_STALE_SEC) ? t[0] : undefined;
      output.minutesAgo           = t[0] > 0 ? t[2] : NO_DATA;
      output.deltaRate            = t[3];
      output.glState              = t[1] + 8 * colorIndex(t[0], t[2]) + 32 * t[4];
    }
    testTick++;
    recordGraph();
    sendGraph(output);
    output.pumpState = (135 + 32768) * 256 + 3; // IOB 1.35 U, looped 3 min ago
    return;
  }

  // --- Local age heartbeat ------------------------------------------------
  // Tick every second so the age display updates smoothly between BLE pushes.
  // Re-synced to authoritative value from the bridge on every packet. It
  // keeps counting while disconnected, which drives the signal-lost alert.
  localAgeSeconds++;

  if (exerciseStarted) {
    checkSignal();
    recordGraph();
    sendGraph(output);
    // Loop age counts up with the reading's age between packets.
    output.pumpState = (pumpIob + 32768) * 256
                     + (loopOffset == 99999 ? 255 : Math.min(254, Math.floor((localAgeSeconds + loopOffset) / 60)));
  }

  switch (state) {
    // appConn calls can throw on the watch; an uncaught throw would abort
    // evaluate(), so each step falls back to the timed retry instead.
    case 0:
      // Initiate connection. Load ext1 from flash, call it, free it.
      try {
        loadExt(1);
        connection = ext(bleEventHandler);
        state = waitingState; // wait for CONNECTED (100)
      } catch (e) { systemEvent('NSG connect threw'); scheduleRetry(0); }
      ext = undefined;
      break;

    case 1:
      // Register notification characteristic. Load ext2, call it, free it.
      try {
        loadExt(2);
        ext(connection);
        state = waitingState; // wait for UUID_REGISTERED (107)
      } catch (e) { systemEvent('NSG register threw'); scheduleRetry(1); }
      ext = undefined;
      break;

    case 4:
      // Enable notifications on the registered characteristic.
      try {
        appConn.enaCharNotf(connection, charId);
        state = waitingState; // wait for CONFIG_DONE (109)
      } catch (e) { systemEvent('NSG notify threw'); scheduleRetry(4); }
      break;

    case 5:
      // Post-disconnect cleanup. The framework auto-reconnects, which will
      // re-fire CONNECTED. We keep `registered = 1` so the reconnect path
      // skips straight to enabling notifications (state 4) rather than
      // re-registering. Blank the outputs so the screen doesn't freeze on
      // the last reading while disconnected.
      output.con = 0;
      rawGlucose = 0;
      trend      = 0;
      rateRaw    = 0;
      alertKind  = 0;
      writeNoData(output);
      state = waitingState;
      break;

    case 6:
      // Notifications enabled -- close the Searching-view.
      output.con = 1;
      if (exerciseStarted) { state = 10; }
      break;

    case retryWaitState:
      // Back off after a failure event, then retry the failed step.
      retryWait--;
      if (retryWait <= 0) { state = retryState; }
      break;

    case waitingState:
      // Idle; next state set by BLE event handler.
      break;

    case 10:
      // Connected and exercise running. Write outputs every tick and
      // periodically issue an explicit read to re-sync the age.
      output.con = 1;
      if (rawGlucose > 0) {
        var fresh = localAgeSeconds < AGE_STALE_SEC;
        output.glucoseNow           = rawGlucose;
        output.bloodGlucoseExercise = (RECORD_ON && fresh) ? rawGlucose : undefined;
        output.minutesAgo           = localAgeSeconds;
        output.deltaRate            = rateRaw;
        output.glState              = trend + 8 * colorIndex(rawGlucose, localAgeSeconds)
                                    + 32 * (packetError || (fresh ? 0 : 1));
        if (fresh) {
          checkAlerts();
          if (RECORD_ON) { recordStats(); }
        } else {
          alertKind = 0; // re-alert straight away once data is fresh again
        }
      } else {
        writeNoData(output);
      }

      readTick++;
      if (readTick >= READ_INTERVAL) {
        readTick = 0;
        try { appConn.readChar(connection, charId); } catch (e) { systemEvent('NSG read threw'); }
      }
      break;
  }
}

// ---------------------------------------------------------------------------
// UI template selection and post-workout summary
// ---------------------------------------------------------------------------
function getUserInterface(input, output) { return { template: 'q' }; }

function getSummaryOutputs(input, output) {
  if (!RECORD_ON || stats[0] == 0) return [];
  return [
    { id: 'gAvg', name: 'Avg glucose',   format: 'OneDecimal_Fourdigits', value: Math.round(stats[1] / stats[0] * 100) / 100, postfix: 'mmol/L' },
    { id: 'gMin', name: 'Min glucose',   format: 'OneDecimal_Fourdigits', value: Math.round(stats[2] * 100) / 100, postfix: 'mmol/L' },
    { id: 'gMax', name: 'Max glucose',   format: 'OneDecimal_Fourdigits', value: Math.round(stats[3] * 100) / 100, postfix: 'mmol/L' },
    { id: 'gTir', name: 'Time in range', format: 'Count_Threedigits',     value: Math.round(stats[4] * 100 / stats[0]), postfix: '%' }
  ];
}
