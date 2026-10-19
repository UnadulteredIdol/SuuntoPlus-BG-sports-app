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
- **No AID system** (MDI, or nothing uploading device status): send IOB unknown and loop 255. The watch then hides its pump line.
- **IOB** comes from Nightscout `devicestatus` → `openaps.iob.iob` (an object from Trio, an array from oref0 rigs). Send unknown when its `time` is more than 30 minutes old.
- **Loop age** is measured from the newest of `openaps.suggested.timestamp` and `openaps.enacted.timestamp`.
- **Age is computed when the packet is built**, not when the reading was fetched. Every notification and every read response must be sealed fresh.
- **Rate** should be sent as 0 once the reading is older than 15 minutes.
- Convert mg/dL with Nightscout's factor (18.01559) and **round to the nearest 0.1 mmol/L before packing**. The watch displays one decimal; sending hundredths makes it round a second time (6.549 → 6.55 → 6.6) and disagree with the phone.

### 4.2 Cipher: XTEA

XTEA with a 128-bit key, 64-bit block and 32 cycles (64 Feistel rounds), standard `delta = 0x9E3779B9`:

```
encrypt(v0, v1, k[0..3]):
    sum = 0
    repeat 32 times:
        v0 += (((v1 << 4) ^ (v1 >> 5)) + v1) ^ (sum + k[sum & 3])
        sum += 0x9E3779B9
        v1 += (((v0 << 4) ^ (v0 >> 5)) + v0) ^ (sum + k[(sum >> 11) & 3])
    return (v0, v1)
```

All arithmetic is unsigned 32-bit with wrap-around. `>>` is a logical shift.

**Byte order (important):** the key words are read **little-endian** from the 16 key bytes: `k[i] = key[4i] | key[4i+1] << 8 | key[4i+2] << 16 | key[4i+3] << 24`. Data blocks are likewise built from and written back to bytes little-endian. Published XTEA test vectors use big-endian words, so check your core against the vector in section 7.1 *before* applying this byte order.

`E(a, b)` below means `encrypt(a, b, k)`.

### 4.3 Encryption (counter mode)

```
(s0, s1)   = E(nonce, 0x00000000)
keystream  = LE(s0) || LE(s1)                  // 8 bytes
ciphertext[i] = reading[i] XOR keystream[i]    // i = 0..7
```

### 4.4 Authentication tag (CBC-MAC, CCM style)

```
(x0, x1) = E(nonce, 0xFFFFFFFF)
p0       = reading[0] | reading[1] << 8 | reading[2] << 16 | reading[3] << 24
p1       = reading[4] | reading[5] << 8 | reading[6] << 16 | reading[7] << 24
tag      = first word of E(x0 XOR p0, x1 XOR p1)
```

The tag is computed over the **plaintext** reading. The second word of the counter block (`0`) and of the MAC block (`0xFFFFFFFF`) are different, so the two never share a cipher input.

### 4.5 Nonce

- `nonce = max(current unix time in seconds, previous nonce + 1)`: strictly increasing even when two packets are built in the same second.
- A nonce must never repeat under the same key. Reusing one exposes the XOR of two readings.

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

## 6. Key

- 16 random bytes from a cryptographically secure generator, created by the bridge.
- Shown to the user as 32 uppercase hex digits in groups of four: `0B30 557A 9FC4 E90E 3358 7DA2 C7EC 1136`.
- On the watch it lives in the app setting **Bridge key** (`settings.bridgeKey`):
  - **Builds sideloaded from the SuuntoPlus Editor** read settings only from the bundled `data.json`. Edits in the Suunto mobile app do not reach them.
  - **Store installs** read it from the Suunto app's settings screen.
- Store the key in the platform's secure storage (iOS Keychain, Android Keystore-backed storage), device-only and not in cloud backups.
- Regenerating the key immediately invalidates the watch until the new key is entered there.

## 7. Test vectors

### 7.1 XTEA core (standard vector, big-endian words)

```
key words  00010203 04050607 08090A0B 0C0D0E0F
plaintext  41424344 45464748
cipher     497DF3D0 72612CB5
```

### 7.2 Sealed packets

Key bytes `00 01 02 03 04 05 06 07 08 09 0A 0B 0C 0D 0E 0F` (hex string `000102030405060708090A0B0C0D0E0F`).

| Reading (hex) | Meaning | Nonce | Packet (hex) |
|---|---|---|---|
| `D0 02 04 03 F8 87 00 03` | 7.20 mmol/L, Flat, 3 min, -0.8, IOB 1.35 U, looped 3 min ago | 1792000000 | `00 C0 CF 6A D5 C6 AE C1 4F 64 DC 1C 45 CE D6 FE` |
| `7E 01 06 0C F1 D6 FF 0C` | 3.82 mmol/L, SingleDown, 12 min, -1.5, IOB -0.42 U, 12 min | 1792000001 | `01 C0 CF 6A A8 27 E8 25 BD 63 4B 56 EA 00 D5 19` |
| `00 00 00 FF 00 00 80 FF` | no data, no AID | 1792000002 | `02 C0 CF 6A FA 82 E0 6A 05 20 3B E1 C8 B7 E1 11` |

These were generated by the Swift reference and accepted by the watch reference. Flipping any single bit of a packet must make the watch reject it.

## 8. Security notes

- **Protects against:** nearby devices reading glucose over the air, spoofed or tampered readings, and replayed old packets.
- **Does not protect against:**
  - Anyone holding the key. With store installs the key passes through Suunto's settings sync.
  - Traffic analysis: an observer can see that *some* device notifies roughly every 5 minutes.
- XTEA is old, but sound for this volume of data; its 64-bit block is not a concern at a few packets per minute. If a future version changes the cipher, change the service UUID so old and new peers do not talk past each other.

## 9. Versioning

This is protocol version 2. Any incompatible change (packet layout, cipher, UUIDs) gets a new characteristic or service UUID, so a watch and bridge on different versions fail to connect instead of misreading data.

| Version | Characteristic | Change |
|---|---|---|
| 1 | `4DEC23BA-6021-4CCE-A4F8-E7EFC2E01CA9` | 5-byte reading, 13-byte packet |
| 2 | `2670495C-EC30-4317-BF55-886E6B738BB1` | adds IOB and loop age: 8-byte reading, 16-byte packet |
