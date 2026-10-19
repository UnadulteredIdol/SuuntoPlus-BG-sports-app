# NS Glucose bridge protocol — version 2

This document specifies how a phone app (a "bridge") sends glucose readings to the **NS Glucose** SuuntoPlus watch app over Bluetooth Low Energy. Any app on any platform can act as a bridge if it implements this page. The watch app does not know or care which bridge it talks to.

Reference implementations:

| Side | File | Language |
|---|---|---|
| Bridge (sealing) | `BLE Bridge/BLE Bridge/BridgeSecurity.swift` (`PacketSealer`) | Swift |
| Watch (opening) | `Suunto/Nightscout Widget/ext4.js` | ES5 JavaScript |

## 1. Roles

- **Bridge = BLE peripheral (GATT server).** It advertises, holds the reading, and pushes it.
- **Watch = BLE central (GATT client).** It scans, connects, subscribes to notifications and reads periodically.

## 2. GATT layout

| Item | UUID |
|---|---|
| Primary service | `F17F3300-386E-46B5-A72A-C2FC31F7A639` |
| Characteristic (v2) | `2670495C-EC30-4317-BF55-886E6B738BB1` |

The characteristic must support **Notify** and **Read**, with no encryption or pairing requirement. Confidentiality comes from the packet itself (section 4), because SuuntoPlus apps cannot pair.

## 3. Advertising

- Advertise the service UUID in the 128-bit UUID list (complete or partial). The watch searches both lists.
- **Do not advertise a local name or anything else that identifies the device as glucose-related.** Anyone scanning nearby can see advertisements.
- **iOS limitation:** a backgrounded iOS app moves its service UUIDs to an Apple-only "overflow" area, which the watch cannot see. The watch can therefore only *find* an iOS bridge while the bridge app is in the foreground. An established connection survives backgrounding. iOS bridges should keep the screen awake until the watch has connected.

## 4. Packet (16 bytes)

All multi-byte integers are **little-endian**.

```
offset  size  field
0       4     nonce       uint32, unix time in seconds (UTC), strictly increasing
4       8     ciphertext  the 8-byte reading (4.1), encrypted (4.3)
12      4     tag         authentication tag (4.4)
```

### 4.1 Reading (plaintext, 8 bytes = one cipher block)

```
offset  size  field
0       2     glucose   uint16, mmol/L x 100        (720 = 7.20 mmol/L)
2       1     trend     uint8, 0-7 (table below)
3       1     age       uint8, minutes since the CGM reading, capped at 255
4       1     rate      int8, mmol/L per 5 minutes x 10   (+8 = +0.8, -15 = -1.5)
5       2     iob       int16, insulin on board in units x 100 (135 = 1.35 U);
                        -32768 (0x8000) = unknown
7       1     loop      uint8, minutes since the AID app's last loop, capped at
                        254; 255 = unknown
```

| Trend | Nightscout `direction` |
|---|---|
| 0 | unknown / NOT COMPUTABLE / RATE OUT OF RANGE |
| 1 | DoubleUp |
| 2 | SingleUp |
| 3 | FortyFiveUp |
| 4 | Flat |
| 5 | FortyFiveDown |
| 6 | SingleDown |
| 7 | DoubleDown |

Rules for bridges:

- **No reading available:** send glucose 0, trend 0, age 255, rate 0. The watch shows "no data". The pump fields are still sent.
- **Age is computed when the packet is built**, not when the reading was fetched. Every notification and every read response must be sealed fresh.
- **Rate** should be sent as 0 once the reading is older than 15 minutes.

## 5. Watch behaviour

The watch opens a packet only if **all** of these hold, in this order:

1. The key setting holds exactly 32 hex digits. Spaces and other non-hex characters are ignored; case does not matter. Otherwise it shows **"Set key"**.
2. The packet is exactly 16 bytes and the tag matches. Otherwise it shows **"Wrong key"**.
3. `nonce > last accepted nonce` and `|nonce - watch time| <= 600 s`. Otherwise it shows **"Clock error"**. This blocks replays and needs the phone and watch clocks within 10 minutes of each other.

A rejected packet never replaces the last good reading.

Timing:

- The watch subscribes to notifications and **reads the characteristic only after 60 s without an accepted packet**, to re-sync the age. Bridges must notify whenever a new CGM reading arrives; there is no need to notify more often. With 1-minute sensors the watch then rarely reads at all.
- During a workout the watch buzzes once when no reading has been received for 10 minutes, and once when readings return.
- Between packets the watch counts the age up locally, once per second.
- The watch reconnects by itself after a disconnect, re-enabling notifications without re-registering.
