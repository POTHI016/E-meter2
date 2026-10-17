import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateElectricalReadings, normalizeTelemetry, telemetryMeterId, isTelemetryLive, getLatestTelemetry, saveLatestTelemetry } from '../../frontend/lib/telemetry.js';
import { usageChartPoints, usageDrillSelection } from '../../frontend/lib/usage-chart.js';

test('device identity requires an explicit unique ID, accepts aliases, and rejects conflicts', () => {
    assert.equal(telemetryMeterId({ meter_id: 'MTR-01' }), 'MTR-01');
    assert.equal(telemetryMeterId({ meterId: ' MTR-02 ', meter_id: 'MTR-02' }), 'MTR-02');
    for (const body of [{}, { meterName: 'Display name' }, { meterId: 5 }, { meterId: 'ALL' }, { meterId: '<script>' }, { meterId: 'A', meter_id: 'B' }]) assert.throws(() => telemetryMeterId(body));
});

test('electrical fallbacks use phase-to-neutral V, I and valid PF with kW/kVA units', () => {
    const result = calculateElectricalReadings({ v_r: 230, v_y: 230, v_b: 230, i_r: 2, i_y: 0, i_b: 0, pf_r: 0.8, pf_y: 1, pf_b: 1 });
    assert.equal(result.apparent_r, 0.46);
    assert.ok(Math.abs(result.power_r - 0.368) < 1e-12);
    assert.ok(Math.abs(result.total_power_kw - 0.368) < 1e-12);
    assert.equal(result.total_apparent_kva, 0.46);
    assert.equal(result.avg_power_factor, 0.8);
});

test('valid reported zeroes are preserved and current alone never invents active power', () => {
    const result = calculateElectricalReadings({ v_r: 230, i_r: 2, power_r: 0, apparent_r: 0, pf_r: 0, total_power_kw: 0, avg_power_factor: 0 });
    assert.equal(result.power_r, 0);
    assert.equal(result.apparent_r, 0);
    assert.equal(result.avg_power_factor, 0);
    const missing = calculateElectricalReadings({ v_r: 230, i_r: 2 });
    assert.equal(missing.apparent_r, 0.46);
    assert.equal(missing.power_r, null);
    assert.equal(missing.total_power_kw, null);
    assert.equal(missing.avg_power_factor, null);
    assert.equal(calculateElectricalReadings({ power_r: 0.4, apparent_r: 0.5 }).pf_r, 0.8);
});

test('telemetry normalizes missing values, timestamps and unknown machine state without shared mutation', () => {
    const now = new Date('2026-10-05T12:00:00+05:30');
    const a = normalizeTelemetry({ meterId: 'A', i_r: '0.001', i_y: 0, i_b: 0 }, now);
    const b = normalizeTelemetry({ meter_id: 'B', i_r: 0, i_y: 0, i_b: 0 }, now);
    assert.equal(a.meterId, 'A'); assert.equal(b.meterId, 'B');
    assert.equal(a.meter_status, 'active'); assert.equal(b.meter_status, 'idle');
    assert.equal(normalizeTelemetry({ meterId: 'C' }, now).meter_status, 'unknown');
    assert.equal(normalizeTelemetry({ meterId: 'C', frequency: 'invalid' }, now).frequency, null);
    assert.equal(normalizeTelemetry({ meterId: 'C', i_r: true, i_y: ' ', i_b: 0 }, now).meter_status, 'unknown');
    assert.throws(() => normalizeTelemetry({ meterId: 'A', timestamp: 'invalid' }, now), /timestamp/);
    assert.throws(() => normalizeTelemetry({ meterId: 'A', timestamp: '2027-01-01T00:00:00Z' }, now), /timestamp/);
    assert.ok(isTelemetryLive(a, +now));
    assert.equal(isTelemetryLive(a, +now + 300001), false);
});

test('latest telemetry is read independently per meter, including retained snapshots', async () => {
    const saved = [{ reading: { meterId: 'A', timestamp: new Date(1000), total_power_kw: 1 } }, { reading: { meterId: 'B', timestamp: new Date(3000), total_power_kw: 3 } }];
    const raw = [{ reading: { meterId: 'A', timestamp: new Date(2000), total_power_kw: 2 } }];
    const db = { collection(name) { return {
        async distinct() { return raw.map(doc => doc.reading.meterId); },
        find(query) { return {
            sort() { return this; }, limit() { return this; },
            async toArray() { return name === 'telemetry_latest' ? saved.filter(doc => !query._id || doc.reading.meterId === query._id)
                : raw.filter(doc => doc.reading.meterId === query.meterId).map(doc => doc.reading); }
        }; },
        aggregate(pipeline) { return { async toArray() { return raw.filter(doc => !pipeline[0].$match.meterId || doc.reading.meterId === pipeline[0].$match.meterId); } }; }
    }; } };
    const all = await getLatestTelemetry(db);
    assert.equal(all.length, 2);
    assert.equal(all[0].total_power_kw, 2);
    assert.equal(all[1].total_power_kw, 3);
    const b = await getLatestTelemetry(db, 'B');
    assert.equal(b.length, 1); assert.equal(b[0].meterId, 'B');
});

test('latest snapshot writes are ID-scoped and guard against delayed packets', async () => {
    let call;
    const db = { collection(name) { assert.equal(name, 'telemetry_latest'); return { async updateOne(...args) { call = args; } }; } };
    const doc = { meterId: 'A', timestamp: new Date(1000) };
    await saveLatestTelemetry(db, doc);
    assert.deepEqual(call[0], { _id: 'A' });
    assert.equal(call[1][0].$set.reading.$cond[0].$gte[0].$literal, doc.timestamp);
    assert.equal(call[1][0].$set.reading.$cond[2], '$reading');
    assert.equal(call[2].upsert, true);
});

test('graph intervals and drill selection respect clipped windows and midnight', () => {
    const points = usageChartPoints({ from: '2026-10-05T09:15:00+05:30', to: '2026-10-05T10:05:00+05:30', granularity: 'hour', rows: [] });
    assert.equal(points.length, 2);
    assert.equal(points[0].label, '9:15 AM - 10 AM');
    assert.equal(points[1].label, '10 AM - 10:05 AM');
    assert.equal(usageDrillSelection(points[0], 'hour').fromTime, '09:15');
    const midnight = usageChartPoints({ from: '2026-10-05T23:00:00+05:30', to: '2026-10-06T00:00:00+05:30', granularity: 'hour', rows: [] });
    assert.equal(midnight[0].label, '11 PM - 12 AM');
    assert.equal(usageDrillSelection(midnight[0], 'hour').toTime, '');
    assert.equal(usageDrillSelection(midnight[0], 'minute'), null);
});

test('range graph keeps absent days and respects leap months and year boundaries', () => {
    const days = usageChartPoints({ period: 'range', from: '2024-02-28T00:00:00+05:30', to: '2024-03-02T00:00:00+05:30', granularity: 'day', rows: [{ period: '2024-02-28', energyConsumedKwh: 1 }] });
    assert.equal(days.length, 3);
    assert.equal(days[1].period, '2024-02-29');
    assert.equal(days[1].energyConsumedKwh, undefined);
    const years = usageChartPoints({ from: '2025-12-01T00:00:00+05:30', to: '2027-02-01T00:00:00+05:30', granularity: 'year', rows: [] });
    assert.deepEqual(years.map(point => point.label), ['2025', '2026', '2027']);
    assert.equal(usageDrillSelection(years[0], 'year').period, 'year');
});
