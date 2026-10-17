# Meter Usage

The Live Data meter detail calls `/api/meter-usage`. The Express server and
Vercel API share calculations in `frontend/lib/meter-usage.js`.

- Any phase current above 0 A indicates running.
- All three phase currents must be present and zero to indicate idle.
- The previous reading's state applies until the next reading. Intervals
  longer than five minutes are unrecorded time, not running or idle.
- A recent reading can cover up to five minutes of elapsed live time. This
  projected tail is not saved as a measured interval.
- Consumption sums positive changes in cumulative `energy_active` (kWh).
  Counter decreases are flagged and excluded; subsequent increases count.
- Changes crossing minute boundaries are split proportionally. Energy
  distribution across long recording gaps is flagged as estimated.
- Calendar periods use Asia/Kolkata. A time filter's end is exclusive.

Complete minute totals are saved in `meter_usage_minutes` without a TTL.
They have deterministic IDs, so recomputation replaces rather than adds
totals. Ingestion saves recent minutes; report requests also backfill
available raw history. Already-expired raw history cannot be reconstructed.
Both API implementations must run the updated code to archive new readings.

## Status Timeline

Usage responses include `timeline: { segments, incomplete }`. Each segment
has numeric UTC millisecond `start` and `end` values and a `state` of
`running` or `idle`. These intervals use the same previous-reading rule as
duration totals; switching precision is limited by telemetry sampling.
Unrecorded time and future time have no coloured segment. Adjacent equal
states are merged, without bridging unknown intervals.

Minute archives now also retain ordered `states`, preserving changes within
one minute after raw history expires. Older complete single-state minutes
can be displayed directly. Older mixed/partial minutes are backfilled from
raw readings when available; otherwise `incomplete` is true and their order
is left blank instead of guessed. Duration and energy totals are unchanged.
Overview returns each meter's timeline and compact per-period `trendRows`
under `meters`, never a combined machine state across meters. The graph
connects actual running-hour totals into a sloping trend, with its coloured
sections aligned to measured running/idle intervals. Hover shows both
duration totals for the period; line height is not an on/off state value.
Deploy the updated hosted API as well as the
frontend to enable this response in a hosted dashboard.

Examples:

```text
/api/meter-usage?meterId=MTR-SSB3-156&period=day&date=2026-10-05&granularity=hour
/api/meter-usage?meterId=MTR-SSB3-156&period=day&date=2026-10-05&fromTime=08:00&toTime=16:00&granularity=minute
/api/meter-usage?meterId=MTR-SSB3-156&period=month&date=2026-10
/api/meter-usage?meterId=MTR-SSB3-156&period=year&date=2026
```

Run focused tests with `npm test` in `backend`.

Overview uses `/api/usage-overview` and the same per-meter calculation
engine. `/api/meter-hours` and `/api/energy-report` also use this engine
instead of estimating elapsed time from reading counts. See
`MULTI_DEVICE.md` for registration, payloads, multi-meter totals, and the
shared local/hosted backend flow.
