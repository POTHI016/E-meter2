import test from 'node:test';
import assert from 'node:assert/strict';
import { getMeterUsage, getUsageOverview, combineMeterUsage, legacyUsageParams, minuteUsage, readingState, usageRange } from '../../frontend/lib/meter-usage.js';

const sum = (bins, field) => [...bins.values()].reduce((total, bin) => total + bin[field], 0);
const reading = (timestamp, current, energy) => ({ timestamp: new Date(timestamp), i_r: current, i_y: 0, i_b: 0, energy_active: energy });

test('current states distinguish running, zero current, and missing readings', () => {
    assert.equal(readingState({ i_r: '0.001', i_y: null, i_b: null }), 'running');
    assert.equal(readingState({ i_r: '0', i_y: 0, i_b: 0 }), 'idle');
    assert.equal(readingState({ i_r: null, i_y: 0, i_b: 0 }), 'unknown');
    assert.equal(readingState({}), 'unknown');
});

test('eight-hour shift has six running hours, two idle hours, and 7 kWh consumed', () => {
    const start = Date.parse('2026-10-05T08:00:00+05:30');
    const rows = Array.from({ length: 481 }, (_, minute) => reading(start + minute * 60000, minute < 180 || minute >= 300 ? 0.01 : 0, 20.3 + 7 * minute / 480));
    const bins = minuteUsage(rows, start, start + 8 * 3600000);
    assert.equal(sum(bins, 'runningSeconds'), 6 * 3600);
    assert.equal(sum(bins, 'idleSeconds'), 2 * 3600);
    assert.ok(Math.abs(sum(bins, 'energyConsumedKwh') - 7) < 1e-9);
});

test('irregular reading intervals use elapsed time, not document count', () => {
    const start = Date.parse('2026-10-05T00:00:00Z');
    const bins = minuteUsage([reading(start, 1, 10), reading(start + 10000, 0, 10.5), reading(start + 40000, 0, 10.5)], start, start + 40000);
    assert.equal(sum(bins, 'runningSeconds'), 10);
    assert.equal(sum(bins, 'idleSeconds'), 30);
});

test('missing current and long gaps never count as idle', () => {
    const start = Date.parse('2026-10-05T00:00:00Z');
    const bins = minuteUsage([reading(start, null, 10), reading(start + 60000, 0, 10), reading(start + 3600000, 0, 11)], start, start + 3600000);
    assert.equal(sum(bins, 'idleSeconds'), 0);
    assert.equal(sum(bins, 'runningSeconds'), 0);
    assert.ok([...bins.values()].some(bin => bin.energyEstimated));
});

test('duplicates and energy counter resets cannot inflate totals', () => {
    const start = Date.parse('2026-10-05T00:00:00Z');
    const bins = minuteUsage([reading(start, 1, 20), reading(start, 1, 20), reading(start + 60000, 1, 1), reading(start + 120000, 1, 2)], start, start + 120000);
    assert.equal(sum(bins, 'runningSeconds'), 120);
    assert.equal(sum(bins, 'energyConsumedKwh'), 1);
    assert.ok([...bins.values()].some(bin => bin.counterReset));
});

test('intervals crossing midnight are clipped to the selected day', () => {
    const start = Date.parse('2026-10-05T00:00:00+05:30');
    const bins = minuteUsage([reading(start - 30000, 1, 20.3), reading(start + 30000, 0, 20.5), reading(start + 90000, 0, 20.7)], start, start + 60000);
    assert.equal(sum(bins, 'runningSeconds'), 30);
    assert.equal(sum(bins, 'idleSeconds'), 30);
    assert.ok(Math.abs(sum(bins, 'energyConsumedKwh') - 0.2) < 1e-9);
});

test('day, month, year, and time windows use India calendar boundaries', () => {
    const now = new Date('2026-10-05T12:00:00+05:30');
    const day = usageRange({ period: 'day', date: '2026-10-05' }, now);
    assert.equal(new Date(day.start).toISOString(), '2026-10-04T18:30:00.000Z');
    assert.equal(day.end - day.start, 86400000);
    const month = usageRange({ period: 'month', date: '2024-02' }, now);
    assert.equal(month.end - month.start, 29 * 86400000);
    const year = usageRange({ period: 'year', date: '2026' }, now);
    assert.equal(year.end - year.start, 365 * 86400000);
    const window = usageRange({ date: '2026-10-05', fromTime: '08:00', toTime: '16:00', granularity: 'minute' }, now);
    assert.equal(window.end - window.start, 8 * 3600000);
    assert.throws(() => usageRange({ date: '2026-02-30' }), /Invalid date/);
    assert.throws(() => usageRange({ date: '2026-10-05', fromTime: '16:00', toTime: '08:00' }), /End time/);
});

function fakeDatabase(raw, meters = []) {
    const archived = [];
    return {
        archived,
        collection(name) {
            const rows = name === 'telemetry_history' ? raw : name === 'meter_usage_minutes' ? archived : [];
            return {
                async findOne() { return name === 'config' ? { meters } : null; },
                async distinct() { return [...new Set(rows.map(row => row.meterId))]; },
                aggregate(pipeline) {
                    const match = pipeline.find(stage => stage.$match)?.$match || {};
                    const byId = new Map();
                    for (const row of [...raw].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))) {
                        if (!match.meterId || row.meterId === match.meterId) byId.set(row.meterId, row);
                    }
                    return { async toArray() { return [...byId.values()].map(reading => ({ reading })); } };
                },
                find(query) {
                    let selected = rows.filter(row => row.meterId === query.meterId && Object.entries(query.timestamp || {}).every(([operator, date]) => {
                        const time = new Date(row.timestamp).getTime();
                        return operator === '$lt' ? time < +date : operator === '$lte' ? time <= +date : operator === '$gt' ? time > +date : time >= +date;
                    }));
                    return {
                        sort(order) { selected.sort((a, b) => (new Date(a.timestamp) - new Date(b.timestamp)) * order.timestamp); return this; },
                        limit(count) { selected = selected.slice(0, count); return this; },
                        async toArray() { return selected.map(row => ({ ...row })); }
                    };
                },
                async bulkWrite(operations) {
                    for (const { updateOne } of operations) {
                        const index = archived.findIndex(row => row._id === updateOne.filter._id);
                        const value = { _id: updateOne.filter._id, ...updateOne.update.$set };
                        if (index < 0) archived.push(value); else archived[index] = value;
                    }
                }
            };
        }
    };
}

test('permanent minute summaries support month and year after raw readings expire', async () => {
    const start = Date.parse('2026-10-05T08:00:00+05:30');
    const raw = Array.from({ length: 121 }, (_, minute) => ({ ...reading(start + minute * 60000, minute < 60 ? 1 : 0, 20.3 + 7 * minute / 120), meterId: 'archive-test' }));
    const db = fakeDatabase(raw);
    const day = await getMeterUsage(db, { meterId: 'archive-test', date: '2026-10-05' }, new Date('2026-10-06T00:00:00+05:30'));
    assert.equal(day.runningSeconds, 3600);
    assert.equal(day.idleSeconds, 3600);
    assert.equal(db.archived.length, 120);
    await getMeterUsage(db, { meterId: 'archive-test', date: '2026-10-05', granularity: 'minute' }, new Date('2026-10-06T00:00:00+05:30'));
    assert.equal(db.archived.length, 120);
    raw.length = 0;
    const month = await getMeterUsage(db, { meterId: 'archive-test', period: 'month', date: '2026-10' }, new Date('2026-11-01T00:00:00+05:30'));
    assert.equal(month.runningSeconds, 3600);
    assert.equal(month.idleSeconds, 3600);
    assert.ok(Math.abs(month.energyConsumedKwh - 7) < 1e-9);
    assert.equal(month.openingEnergy, 20.3);
    assert.equal(month.closingEnergy, 27.3);
    assert.deepEqual(month.timeline.segments, [
        { start, end: start + 3600000, state: 'running' },
        { start: start + 3600000, end: start + 7200000, state: 'idle' }
    ]);
    const year = await getMeterUsage(db, { meterId: 'archive-test', period: 'year', date: '2026' }, new Date('2027-01-01T00:00:00+05:30'));
    assert.equal(year.runningSeconds, 3600);
    assert.equal(year.rows.length, 1);
    assert.equal(year.rows[0].period, '2026-10');
});

test('unknown-current durations remain unavailable and do not become zero idle time', async () => {
    const start = Date.parse('2026-10-05T08:00:00+05:30');
    const db = fakeDatabase([0, 1].map(minute => ({ ...reading(start + minute * 60000, null, 20.3), meterId: 'missing-current-test' })));
    const result = await getMeterUsage(db, { meterId: 'missing-current-test', date: '2026-10-05' }, new Date('2026-10-06T00:00:00+05:30'));
    assert.equal(result.runningSeconds, null);
    assert.equal(result.idleSeconds, null);
    assert.equal(result.rows[0].idleSeconds, null);
});

test('breakdown rows flag energy interpolated across a recording gap', async () => {
    const start = Date.parse('2026-10-05T08:00:00+05:30');
    const db = fakeDatabase([0, 120].map(minute => ({ ...reading(start + minute * 60000, 1, 20 + minute / 120), meterId: 'energy-gap-test' })));
    const result = await getMeterUsage(db, { meterId: 'energy-gap-test', date: '2026-10-05' }, new Date('2026-10-06T00:00:00+05:30'));
    assert.equal(result.energyEstimated, true);
    assert.ok(result.rows.every(row => row.energyEstimated && row.runningSeconds === null));
});

test('multiple meters stay segregated and Overview sums their consumption, not cumulative counters', async () => {
    const start = Date.parse('2026-10-05T09:00:00+05:30');
    const raw = [
        ...[0, 1, 2].map(minute => ({ ...reading(start + minute * 60000, 1, 1000 + minute), meterId: 'overview-A' })),
        ...[0, 1, 2].map(minute => ({ ...reading(start + minute * 60000, 0, 20 + minute / 2), meterId: 'overview-B' }))
    ];
    const db = fakeDatabase(raw);
    const now = new Date('2026-10-06T00:00:00+05:30');
    const all = await getUsageOverview(db, { meterId: 'ALL', date: '2026-10-05' }, now);
    assert.equal(all.meterCount, 2);
    assert.equal(all.runningSeconds, 120);
    assert.equal(all.idleSeconds, 120);
    assert.equal(all.energyConsumedKwh, 3);
    assert.equal(all.rows[0].energyConsumedKwh, 3);
    assert.equal(all.latest.length, 2);
    assert.equal(all.meters[0].timeline.segments[0].state, 'running');
    assert.equal(all.meters[1].timeline.segments[0].state, 'idle');
    assert.equal(all.meters[0].trendRows[0].runningSeconds, 120);
    assert.equal(all.meters[1].trendRows[0].idleSeconds, 120);
    const onlyA = await getUsageOverview(db, { meterId: 'overview-A', date: '2026-10-05' }, now);
    assert.equal(onlyA.meterCount, 1);
    assert.equal(onlyA.energyConsumedKwh, 2);
    assert.equal(onlyA.idleSeconds, 0);
    assert.equal(onlyA.latest[0].meterId, 'overview-A');
});

test('configured meters with no telemetry stay unknown instead of adding idle hours', async () => {
    const db = fakeDatabase([], [{ id: 'unreported-meter', name: 'Not yet connected' }]);
    const result = await getUsageOverview(db, { meterId: 'ALL', date: '2026-10-05' }, new Date('2026-10-05T01:00:00+05:30'));
    assert.equal(result.meterCount, 1);
    assert.equal(result.runningSeconds, null);
    assert.equal(result.idleSeconds, null);
    assert.equal(result.energyConsumedKwh, null);
    assert.equal(result.unrecordedSeconds, 3600);
    assert.equal(result.incompleteEnergy, true);
});

test('Overview preserves unavailable totals and flags incomplete meter buckets', () => {
    const range = usageRange({ date: '2026-10-05' });
    const missing = { hasData: false, runningSeconds: null, idleSeconds: null, energyConsumedKwh: null, unrecordedSeconds: 60, rows: [] };
    const known = { hasData: true, runningSeconds: 60, idleSeconds: 0, energyConsumedKwh: 0, unrecordedSeconds: 0,
        rows: [{ period: '2026-10-05T09', runningSeconds: 60, idleSeconds: 0, energyConsumedKwh: 0, energyAvailable: true }] };
    const result = combineMeterUsage([known, missing], range);
    assert.equal(result.runningSeconds, 60);
    assert.equal(result.idleSeconds, 0);
    assert.equal(result.energyConsumedKwh, 0);
    assert.equal(result.incompleteEnergy, true);
    assert.equal(result.rows[0].incomplete, true);
    assert.equal(combineMeterUsage([missing], range).energyConsumedKwh, null);
});

test('custom date ranges and legacy report filters use inclusive India dates', () => {
    const range = usageRange(legacyUsageParams({ from: '2026-10-05', to: '2026-10-06', granularity: 'daily' }));
    assert.equal(new Date(range.start).toISOString(), '2026-10-04T18:30:00.000Z');
    assert.equal(new Date(range.end).toISOString(), '2026-10-06T18:30:00.000Z');
    assert.throws(() => usageRange({ period: 'range', fromDate: '2026-10-06', toDate: '2026-10-05' }), /ordered date range/);
    assert.throws(() => usageRange({ period: 'range', fromDate: '2026-01-01', toDate: '2026-03-01', granularity: 'hour' }), /31 days/);
});

test('bounded historical backfill preserves intervals and counters across six-hour batches', async () => {
    const start = Date.parse('2026-09-05T09:00:00+05:30');
    const raw = Array.from({ length: 841 }, (_, sample) => ({ ...reading(start + sample * 30000, 1, 50 + 14 * sample / 840), meterId: 'bounded-backfill' }));
    const db = fakeDatabase(raw);
    const result = await getMeterUsage(db, { meterId: 'bounded-backfill', date: '2026-09-05' }, new Date('2026-09-06T00:00:00+05:30'));
    assert.equal(result.runningSeconds, 7 * 3600);
    assert.equal(result.idleSeconds, 0);
    assert.ok(Math.abs(result.energyConsumedKwh - 14) < 1e-9);
    assert.equal(result.openingEnergy, 50);
    assert.equal(result.closingEnergy, 64);
    raw.length = 0;
    const retained = await getMeterUsage(db, { meterId: 'bounded-backfill', period: 'year', date: '2026' }, new Date('2027-01-01T00:00:00+05:30'));
    assert.equal(retained.runningSeconds, 7 * 3600);
    assert.ok(Math.abs(retained.energyConsumedKwh - 14) < 1e-9);
});

test('energy changes across long gaps survive batching without turning gaps into idle time', async () => {
    const start = Date.parse('2026-10-04T09:00:00+05:30');
    const raw = [0, 8 * 60].map(minute => ({ ...reading(start + minute * 60000, 1, 20 + minute / (8 * 60) * 7), meterId: 'bounded-energy-gap' }));
    const result = await getMeterUsage(fakeDatabase(raw), { meterId: 'bounded-energy-gap', date: '2026-10-04' }, new Date('2026-10-05T00:00:00+05:30'));
    assert.equal(result.runningSeconds, null);
    assert.equal(result.idleSeconds, null);
    assert.ok(Math.abs(result.energyConsumedKwh - 7) < 1e-9);
    assert.equal(result.energyEstimated, true);
});

test('a period entirely within a telemetry gap reports estimated energy and unknown duration', async () => {
    const start = Date.parse('2026-10-03T23:00:00+05:30');
    const raw = [0, 120].map(minute => ({ ...reading(start + minute * 60000, 1, 20 + minute / 120 * 2), meterId: 'bracketed-window' }));
    const result = await getMeterUsage(fakeDatabase(raw), { meterId: 'bracketed-window', date: '2026-10-04', fromTime: '00:10', toTime: '00:20' }, new Date('2026-10-05T00:00:00+05:30'));
    assert.equal(result.runningSeconds, null);
    assert.equal(result.idleSeconds, null);
    assert.ok(Math.abs(result.energyConsumedKwh - 1 / 6) < 1e-9);
    assert.equal(result.energyEstimated, true);
});
