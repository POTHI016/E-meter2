# Multiple Devices and Overview

## Device Identity

One API endpoint supports many meters. Register each meter in Settings with
a unique ID, name, building, floor, and panel. Configure its firmware to send
that exact ID with every reading. IDs are case-sensitive; use letters,
numbers, hyphens, underscores, dots, or colons (maximum 128 characters).
Never reuse an ID for a different meter: its historical energy counter and
usage belong to that ID.

An ESP32 reading multiple Modbus meters can send one request per meter,
mapping each Modbus slave address to a different logical meter ID. Separate
ESP32 devices use the same endpoint with their own meter IDs. No separate
backend or endpoint is needed for each device.

POST `/api/telemetry/esp32` (or `/api/telemetry`) with `Content-Type:
application/json` and an existing valid `x-api-key` header. The API key
authorizes posting; the meter ID separates data. IDs alone are not an
authorization boundary or tenant-isolation mechanism.

Example for the first device:

```json
{
  "meterId": "MTR-001",
  "v_r": 230,
  "v_y": 231,
  "v_b": 229,
  "i_r": 2,
  "i_y": 1.5,
  "i_b": 1,
  "pf_r": 0.85,
  "pf_y": 0.86,
  "pf_b": 0.84,
  "energy_active": 120.3,
  "frequency": 50
}
```

The second device sends its own readings with `"meterId": "MTR-002"`.
`meter_id` is also accepted; if both aliases are sent they must agree.
A display name cannot replace the ID. Send cumulative active energy in kWh,
phase powers in kW, apparent phase powers in kVA, and phase-to-neutral
voltages in V. Omit unavailable fields rather than sending placeholder zero.
Omit `timestamp` for server receipt time, or send a valid measurement ISO
timestamp with timezone. Future timestamps beyond one minute are rejected.

## Data Flow

1. Validate the key and meter identity.
2. Normalize numeric readings and derive missing electrical values when
   sufficient valid inputs exist. Real reported zeroes are retained.
3. Match the ID against Settings metadata.
4. Save raw history with the ID and timestamp.
5. Maintain a separate permanent latest snapshot for each ID. A delayed
   packet cannot replace a newer snapshot.
6. Archive complete minute usage for that same meter ID.
7. Poll all latest readings for the Live Data button list. Each meter's
   live/offline badge is based on its own timestamp (five-minute timeout).
8. Read the selected meter's usage independently; Overview sums each
   meter's calculated consumption, not their absolute energy counters.

API queries:

```text
GET /api/telemetry?all=true
GET /api/telemetry?meterId=MTR-001
GET /api/meter-usage?meterId=MTR-001&period=day&date=2026-10-05
GET /api/usage-overview?meterId=ALL&period=day&date=2026-10-05
GET /api/usage-overview?meterId=MTR-001&period=month&date=2026-10
GET /api/usage-overview?meterId=ALL&period=year&date=2026
GET /api/usage-overview?meterId=ALL&period=range&fromDate=2026-10-01&toDate=2026-10-05&granularity=day
```

Overview cards, tables, and graphs share one selection. Duration totals
across multiple meters are meter-hours: two meters running simultaneously
for one hour add up to two meter-hours. Unrecorded time is not idle time.
Live power and live power factor use recent readings, independently of the
historical period selected for energy and hours. Missing values stay
unavailable; totals with incomplete data are flagged.

Electrical fallbacks use phase apparent power `V * I / 1000`, phase active
power `kVA * PF`, and power factor `kW / kVA` when valid. Current alone
cannot determine active power. Frequency and reactive energy must come
from the meter; neither is fabricated.

Both the Express server and Vercel API share the calculations. Restart the
local backend after code changes; deploy the updated hosted API if devices
post to Vercel. Archived history that already expired before minute
archiving was introduced cannot be recovered. Period queries reuse complete
minute archives and backfill missing raw intervals in bounded batches.

Run tests with `npm test` in `backend` and build with `npm run build` in
`frontend`.
