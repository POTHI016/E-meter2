import test from 'node:test';
import assert from 'node:assert/strict';
import { minuteUsage } from '../../frontend/lib/meter-usage.js';
import { appendStatus, statusTimeline, statusPosition, statusTrendPieces, statusTrendMarkers } from '../../frontend/lib/usage-status.js';

const start = Date.parse('2026-10-17T09:00:00+05:30');
const sample = (seconds, current) => ({ timestamp: new Date(start + seconds * 1000), i_r: current, i_y: 0, i_b: 0, energy_active: seconds / 3600 });

test('trend line slopes between actual hourly running totals instead of binary state levels', () => {
    const points = [0, 1, 2].map((hour, index) => ({ start: start + hour * 3600000, end: start + (hour + 1) * 3600000,
        runningSeconds: [0, 2700, 900][index], idleSeconds: [3600, 900, 2700][index], label: String(hour) }));
    const pieces = statusTrendPieces(points, [
        { start, end: start + 3600000, state: 'idle' },
        { start: start + 3600000, end: start + 7200000, state: 'running' },
        { start: start + 7200000, end: start + 10800000, state: 'idle' }
    ]);
    assert.ok(pieces.some(piece => piece.toHours > piece.fromHours));
    assert.ok(pieces.some(piece => piece.toHours < piece.fromHours));
    assert.ok(pieces.every(piece => piece.fromHours >= 0 && piece.toHours <= 0.75));
    const middle = pieces.filter(piece => piece.state === 'running');
    assert.ok(middle.every(piece => piece.fromX >= 0.5 && piece.toX <= 1.5));
    assert.ok(middle.some(piece => piece.runningSeconds === 2700 && piece.idleSeconds === 900));
});

test('trend line keeps missing periods and unrecorded intervals blank', () => {
    const points = [0, 1, 2].map((hour, index) => ({ start: start + hour * 3600000, end: start + (hour + 1) * 3600000,
        runningSeconds: index === 1 ? null : 1800, idleSeconds: index === 1 ? null : 1800 }));
    const pieces = statusTrendPieces(points, [{ start, end: start + 10800000, state: 'running' }]);
    assert.ok(pieces.every(piece => piece.toX <= 0.5 || piece.fromX >= 1.5));
    const clipped = statusTrendPieces(points, [{ start: start + 60000, end: start + 120000, state: 'idle' }]);
    assert.ok(clipped.every(piece => piece.fromX >= -0.5 + 1 / 60 && piece.toX <= -0.5 + 2 / 60));
    assert.deepEqual(statusTrendPieces([], []), []);
});

test('period dots use actual totals and recorded states without marking missing or future readings', () => {
    const points = [0, 1, 2, 3].map(index => ({ start: start + index * 60000, end: start + (index + 1) * 60000,
        runningSeconds: index === 2 ? null : 30, idleSeconds: index === 2 ? null : 30, label: String(index) }));
    const markers = statusTrendMarkers(points, [
        { start, end: start + 30000, state: 'running' },
        { start: start + 30000, end: start + 120000, state: 'idle' }
    ]);
    assert.deepEqual(markers.map(marker => marker.x), [0, 1]);
    assert.ok(markers.every(marker => marker.hours === 30 / 3600 && marker.state === 'idle'));
    assert.deepEqual(statusTrendMarkers(points, []), []);
});

test('timeline retains within-minute running/idle/running order and unchanged duration totals', () => {
    const bins = minuteUsage([sample(0, 1), sample(10, 0), sample(40, 1), sample(60, 0)], start, start + 60000);
    const result = statusTimeline(bins, start, start + 60000);
    assert.deepEqual(result.segments, [
        { start, end: start + 10000, state: 'running' },
        { start: start + 10000, end: start + 40000, state: 'idle' },
        { start: start + 40000, end: start + 60000, state: 'running' }
    ]);
    assert.equal(bins.get(start).runningSeconds, 30);
    assert.equal(bins.get(start).idleSeconds, 30);
    assert.equal(result.incomplete, false);
});

test('timeline merges adjacent equal states across minute boundaries, but not across gaps', () => {
    const bins = minuteUsage([sample(0, 1), sample(60, 1), sample(120, null), sample(180, 0), sample(240, 0)], start, start + 240000);
    const result = statusTimeline(bins, start, start + 240000);
    assert.deepEqual(result.segments, [
        { start, end: start + 120000, state: 'running' },
        { start: start + 180000, end: start + 240000, state: 'idle' }
    ]);
    assert.deepEqual(statusTimeline(minuteUsage([sample(0, 1), sample(600, 0)], start, start + 600000), start, start + 600000).segments, []);
});

test('old archives restore only full unambiguous minutes, never fabricate mixed state order', () => {
    const bins = new Map([
        [start, { timestamp: start, runningSeconds: 60, idleSeconds: 0 }],
        [start + 60000, { timestamp: start + 60000, runningSeconds: 30, idleSeconds: 30 }],
        [start + 120000, { timestamp: start + 120000, runningSeconds: 0, idleSeconds: 60 }],
        [start + 180000, { timestamp: start + 180000, runningSeconds: 10, idleSeconds: 0 }]
    ]);
    const result = statusTimeline(bins, start + 10000, start + 170000);
    assert.deepEqual(result.segments, [
        { start: start + 10000, end: start + 60000, state: 'running' },
        { start: start + 120000, end: start + 170000, state: 'idle' }
    ]);
    assert.equal(result.incomplete, true);
});

test('stored intervals remain intact on repeated summaries and clip at selected bounds', () => {
    const bins = minuteUsage([sample(0, 1), sample(30, 0), sample(60, 0)], start, start + 60000);
    const original = JSON.stringify([...bins.values()]);
    assert.equal(statusTimeline(bins, start + 15000, start + 45000).segments.length, 2);
    assert.equal(statusTimeline(bins, start, start + 60000).segments.length, 2);
    assert.equal(JSON.stringify([...bins.values()]), original);
});

test('status positioning respects clipped bucket widths and mixed month lengths', () => {
    const points = [{ start, end: start + 60000 }, { start: start + 60000, end: start + 180000 }];
    assert.equal(statusPosition(points, start), -0.5);
    assert.equal(statusPosition(points, start + 30000), 0);
    assert.equal(statusPosition(points, start + 120000), 1);
    assert.equal(statusPosition(points, start + 180000), 1.5);
    assert.equal(statusPosition([], start), null);
    const segments = [];
    appendStatus(segments, 0, 1, 'unknown');
    appendStatus(segments, 0, 0, 'idle');
    assert.equal(segments.length, 0);
});
