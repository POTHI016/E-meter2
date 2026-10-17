import { getLatestTelemetry, numericReading } from './telemetry.js';
import { appendStatus, statusTimeline } from './usage-status.js';

// Calendar periods use India time; cumulative energy counters remain in kWh.
const MINUTE = 60000;
const INDIA_OFFSET = 330 * MINUTE;
export const MAX_READING_GAP_MS = 5 * MINUTE;
const cache = new Map();
const pendingUsage = new Map();

const numeric = numericReading;

export function readingState(reading) {
    const currents = ['i_r', 'i_y', 'i_b'].map(key => numeric(reading[key]));
    if (currents.some(value => value !== null && value > 0)) return 'running';
    return currents.every(value => value === 0) ? 'idle' : 'unknown';
}

export function usageRange(params, now = new Date()) {
    const period = params.period || 'day';
    const today = new Date(now.getTime() + INDIA_OFFSET).toISOString().slice(0, 10);
    if (period === 'range') {
        const first = usageRange({ period: 'day', date: params.fromDate || today }, now);
        const last = usageRange({ period: 'day', date: params.toDate || today }, now);
        if (last.end <= first.start || last.end - first.start > 5 * 366 * 86400000) throw new Error('Select an ordered date range of no more than five years');
        const granularity = params.granularity || 'day';
        if (!['hour', 'day', 'month', 'year'].includes(granularity)) throw new Error('Invalid breakdown');
        if (granularity === 'hour' && last.end - first.start > 31 * 86400000) throw new Error('Hourly ranges are limited to 31 days');
        return { start: first.start, end: last.end, effectiveEnd: Math.max(first.start, Math.min(last.end, now.getTime())), period, date: `${first.date} - ${last.date}`, granularity };
    }
    const date = params.date || (period === 'year' ? today.slice(0, 4) : period === 'month' ? today.slice(0, 7) : today);
    const pattern = period === 'day' ? /^\d{4}-\d{2}-\d{2}$/ : period === 'month' ? /^\d{4}-\d{2}$/ : /^\d{4}$/;
    if (!['day', 'month', 'year'].includes(period) || !pattern.test(date)) throw new Error('Invalid period or date');
    const [year, month = 1, day = 1] = date.split('-').map(Number);
    const startLocal = new Date(Date.UTC(year, month - 1, day));
    if (year < 2000 || year > 2100 || startLocal.toISOString().slice(0, date.length) !== date) throw new Error('Invalid date');
    const endLocal = new Date(Date.UTC(year, period === 'year' ? 12 : period === 'month' ? month : month - 1, period === 'day' ? day + 1 : 1));
    let start = startLocal.getTime() - INDIA_OFFSET;
    let end = endLocal.getTime() - INDIA_OFFSET;
    if (period === 'day') {
        const timeOffset = (value, fallback) => {
            if (!value) return fallback;
            if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error('Invalid time');
            const [hours, minutes] = value.split(':').map(Number);
            return (hours * 60 + minutes) * MINUTE;
        };
        end = start + timeOffset(params.toTime, 24 * 60 * MINUTE);
        start += timeOffset(params.fromTime, 0);
    }
    if (end <= start) throw new Error('End time must be after start time');
    const granularity = params.granularity || (period === 'day' ? 'hour' : period === 'month' ? 'day' : 'month');
    if (!(period === 'day' ? ['minute', 'hour'] : period === 'month' ? ['day'] : ['month']).includes(granularity)) throw new Error('Invalid breakdown');
    return { start, end, effectiveEnd: Math.max(start, Math.min(end, now.getTime())), period, date, granularity };
}

export function minuteUsage(readings, start, end) {
    const bins = new Map();
    const ordered = [...readings].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    for (let index = 1; index < ordered.length; index++) {
        const previous = ordered[index - 1];
        const current = ordered[index];
        const previousTime = new Date(previous.timestamp).getTime();
        const currentTime = new Date(current.timestamp).getTime();
        if (!Number.isFinite(previousTime) || !Number.isFinite(currentTime) || currentTime <= previousTime) continue;
        const left = Math.max(start, previousTime);
        const right = Math.min(end, currentTime);
        if (right <= left) continue;
        const state = currentTime - previousTime <= MAX_READING_GAP_MS ? readingState(previous) : 'unknown';
        const opening = numeric(previous.energy_active);
        const closing = numeric(current.energy_active);
        const energyDelta = opening !== null && closing !== null && closing >= opening ? closing - opening : null;
        for (let position = left; position < right;) {
            const timestamp = Math.floor(position / MINUTE) * MINUTE;
            const next = Math.min(right, timestamp + MINUTE);
            const seconds = (next - position) / 1000;
            const fraction = (next - position) / (currentTime - previousTime);
            const bin = bins.get(timestamp) || { timestamp, runningSeconds: 0, idleSeconds: 0, energyConsumedKwh: 0, energyAvailable: false, energyEstimated: false, counterReset: false, openingEnergy: null, closingEnergy: null, states: [] };
            appendStatus(bin.states, position, next, state);
            if (state === 'running') bin.runningSeconds += seconds;
            if (state === 'idle') bin.idleSeconds += seconds;
            if (energyDelta !== null) {
                bin.energyConsumedKwh += energyDelta * fraction;
                bin.energyAvailable = true;
                bin.energyEstimated ||= currentTime - previousTime > MAX_READING_GAP_MS;
                bin.openingEnergy ??= opening + energyDelta * ((position - previousTime) / (currentTime - previousTime));
                bin.closingEnergy = opening + energyDelta * ((next - previousTime) / (currentTime - previousTime));
            }
            bin.counterReset ||= opening !== null && closing !== null && closing < opening;
            bins.set(timestamp, bin);
            position = next;
        }
    }
    return bins;
}

function summarize(bins, range, openingEnergy, closingEnergy) {
    const grouped = new Map();
    let runningSeconds = 0, idleSeconds = 0, energyConsumedKwh = 0;
    let energyAvailable = false, energyEstimated = false, counterReset = false;
    for (const bin of bins.values()) {
        const local = new Date(Number(bin.timestamp) + INDIA_OFFSET).toISOString();
        const key = local.slice(0, { minute: 16, hour: 13, day: 10, month: 7, year: 4 }[range.granularity]);
        const row = grouped.get(key) || { period: key, runningSeconds: 0, idleSeconds: 0, energyConsumedKwh: 0, energyAvailable: false, energyEstimated: false };
        for (const metric of ['runningSeconds', 'idleSeconds', 'energyConsumedKwh']) row[metric] += bin[metric];
        row.energyAvailable ||= bin.energyAvailable;
        row.energyEstimated ||= bin.energyEstimated;
        grouped.set(key, row);
        runningSeconds += bin.runningSeconds;
        idleSeconds += bin.idleSeconds;
        energyConsumedKwh += bin.energyConsumedKwh;
        energyAvailable ||= bin.energyAvailable;
        energyEstimated ||= bin.energyEstimated;
        counterReset ||= bin.counterReset;
    }
    return {
        period: range.period, date: range.date, granularity: range.granularity, timezone: 'Asia/Kolkata',
        from: new Date(range.start).toISOString(), to: new Date(range.end).toISOString(),
        hasData: bins.size > 0,
        runningSeconds: runningSeconds + idleSeconds > 0 ? runningSeconds : null,
        idleSeconds: runningSeconds + idleSeconds > 0 ? idleSeconds : null,
        unrecordedSeconds: Math.max(0, (range.effectiveEnd - range.start) / 1000 - runningSeconds - idleSeconds),
        energyConsumedKwh: energyAvailable ? energyConsumedKwh : null,
        openingEnergy, closingEnergy, energyEstimated, counterReset,
        timeline: statusTimeline(bins, range.start, range.effectiveEnd),
        rows: [...grouped.values()].sort((a, b) => a.period.localeCompare(b.period)).map(row => ({ ...row,
            runningSeconds: row.runningSeconds + row.idleSeconds > 0 ? row.runningSeconds : null,
            idleSeconds: row.runningSeconds + row.idleSeconds > 0 ? row.idleSeconds : null,
            energyConsumedKwh: row.energyAvailable ? row.energyConsumedKwh : null }))
    };
}

async function loadReadings(db, meterId, start, end) {
    const collection = db.collection('telemetry_history');
    const projection = { meterId: 1, timestamp: 1, i_r: 1, i_y: 1, i_b: 1, energy_active: 1 };
    const [previous, readings, following] = await Promise.all([
        collection.find({ meterId, timestamp: { $lt: new Date(start) } }, { projection }).sort({ timestamp: -1 }).limit(1).toArray(),
        collection.find({ meterId, timestamp: { $gte: new Date(start), $lte: new Date(end) } }, { projection }).sort({ timestamp: 1, _id: 1 }).toArray(),
        collection.find({ meterId, timestamp: { $gt: new Date(end), $lte: new Date() } }, { projection }).sort({ timestamp: 1 }).limit(1).toArray()
    ]);
    // Distant boundary readings can bracket energy changes; minuteUsage still treats their duration as unrecorded.
    if (previous[0]) readings.unshift(previous[0]);
    if (following[0]) readings.push(following[0]);
    return readings;
}

async function persistBins(db, meterId, readings, bins, existing = new Map()) {
    if (readings.length < 2) return;
    const firstTime = new Date(readings[0].timestamp).getTime();
    const lastTime = new Date(readings[readings.length - 1].timestamp).getTime();
    const operations = [];
    for (const bin of bins.values()) {
        // Only archive complete minutes; otherwise a TTL boundary could overwrite a complete archived minute.
        if (bin.timestamp < firstTime || bin.timestamp + MINUTE > lastTime) continue;
        const saved = existing.get(bin.timestamp);
        if (saved && JSON.stringify(saved.states) === JSON.stringify(bin.states) && ['runningSeconds', 'idleSeconds', 'energyConsumedKwh', 'energyAvailable', 'energyEstimated', 'counterReset', 'openingEnergy', 'closingEnergy'].every(key => saved[key] === bin[key])) continue;
        operations.push({ updateOne: {
            filter: { _id: `${meterId}:${bin.timestamp}` },
            update: { $set: { ...bin, timestamp: new Date(bin.timestamp), meterId } }, upsert: true
        } });
    }
    for (let index = 0; index < operations.length; index += 500) await db.collection('meter_usage_minutes').bulkWrite(operations.slice(index, index + 500), { ordered: false });
}

export async function archiveRecentUsage(db, meterId, timestamp) {
    const end = new Date(timestamp).getTime();
    const start = Math.floor((end - MAX_READING_GAP_MS) / MINUTE) * MINUTE;
    const readings = await loadReadings(db, meterId, start, end);
    await persistBins(db, meterId, readings, minuteUsage(readings, start, end));
    cache.clear();
}

async function calculateMeterUsage(db, params, now) {
    const meterId = params.meterId;
    if (!meterId || meterId === 'ALL') throw new Error('Select a meter');
    const range = usageRange(params, now);
    const cacheKey = JSON.stringify([meterId, range.start, range.end, range.granularity]);
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < 10000) return cached.data;
    const saved = await db.collection('meter_usage_minutes').find({ meterId, timestamp: { $gte: new Date(range.start), $lt: new Date(range.effectiveEnd) } }).toArray();
    const bins = new Map(saved.map(bin => [new Date(bin.timestamp).getTime(), { ...bin, timestamp: new Date(bin.timestamp).getTime() }]));
    const collection = db.collection('telemetry_history');
    const [firstRaw] = await collection.find({ meterId, timestamp: { $gte: new Date(range.start), $lte: new Date(range.effectiveEnd) } }, { projection: { timestamp: 1 } }).sort({ timestamp: 1 }).limit(1).toArray();
    const readings = [];
    // Complete archived minutes are authoritative; only missing ranges and the recent tail need raw readings.
    const rawStart = firstRaw ? Math.floor(new Date(firstRaw.timestamp).getTime() / MINUTE) * MINUTE : range.effectiveEnd;
    const gaps = [];
    let gap = null;
    for (let position = Math.max(range.start, rawStart); position < range.effectiveEnd; position += MINUTE) {
        const savedBin = bins.get(position);
        const needsStateOrder = savedBin && !Array.isArray(savedBin.states) && savedBin.runningSeconds + savedBin.idleSeconds > 0 && savedBin.runningSeconds !== 60 && savedBin.idleSeconds !== 60;
        if (!savedBin || needsStateOrder || position >= range.effectiveEnd - MAX_READING_GAP_MS) {
            if (!gap) { gap = { start: position, end: position + MINUTE }; gaps.push(gap); }
            else gap.end = position + MINUTE;
        } else gap = null;
    }
    const mergedGaps = [];
    for (const missing of gaps) {
        const previous = mergedGaps[mergedGaps.length - 1];
        if (previous && missing.start - previous.end <= MAX_READING_GAP_MS) previous.end = missing.end;
        else mergedGaps.push({ ...missing });
    }
    const rawWindows = [];
    for (const missing of mergedGaps) {
        for (let start = missing.start; start < missing.end; start += 6 * 3600000) rawWindows.push({ start, end: Math.min(missing.end, start + 6 * 3600000) });
    }
    for (const missing of rawWindows) {
        const start = Math.max(range.start, missing.start), end = Math.min(range.effectiveEnd, missing.end);
        const raw = await loadReadings(db, meterId, start, end);
        const rawBins = minuteUsage(raw, start, end);
        await persistBins(db, meterId, raw, rawBins, bins);
        const firstTime = raw[0] ? new Date(raw[0].timestamp).getTime() : Infinity;
        for (const [timestamp, bin] of rawBins) if (timestamp >= firstTime || !bins.has(timestamp)) bins.set(timestamp, bin);
        // Keep only counter edges and the latest sample after each bounded raw batch.
        const energyEdges = raw.filter(reading => new Date(reading.timestamp) >= range.start && new Date(reading.timestamp) <= range.effectiveEnd && numeric(reading.energy_active) !== null);
        readings.push(...[raw[0], raw[raw.length - 1], energyEdges[0], energyEdges[energyEdges.length - 1]].filter(Boolean));
    }
    // Include a nearby reading just before the selected window for live coverage at its start.
    if (!readings.length) {
        readings.push(...await loadReadings(db, meterId, range.start, range.effectiveEnd));
        const boundaryBins = minuteUsage(readings, range.start, range.effectiveEnd);
        await persistBins(db, meterId, readings, boundaryBins, bins);
        for (const [timestamp, bin] of boundaryBins) if (!bins.has(timestamp)) bins.set(timestamp, bin);
    }
    readings.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    // A recent live reading can cover the short time up to now, but is never archived as a measured interval.
    const last = readings[readings.length - 1];
    const lastTime = last ? new Date(last.timestamp).getTime() : 0;
    if (last && range.effectiveEnd >= lastTime && range.effectiveEnd - lastTime <= MAX_READING_GAP_MS && range.effectiveEnd === now.getTime()) {
        const tail = minuteUsage([last, { ...last, timestamp: new Date(range.effectiveEnd) }], Math.max(range.start, lastTime), range.effectiveEnd);
        for (const [timestamp, bin] of tail) {
            const existing = bins.get(timestamp);
            if (existing) {
                if (!Array.isArray(existing.states)) existing.states = statusTimeline(new Map([[timestamp, existing]]), timestamp, timestamp + MINUTE).segments;
                for (const segment of bin.states) appendStatus(existing.states, segment.start, segment.end, segment.state);
                existing.runningSeconds += bin.runningSeconds; existing.idleSeconds += bin.idleSeconds;
            }
            else bins.set(timestamp, bin);
        }
    }
    const energyReadings = readings.filter(reading => new Date(reading.timestamp) >= range.start && new Date(reading.timestamp) <= range.effectiveEnd && numeric(reading.energy_active) !== null);
    const orderedBins = [...bins.values()].sort((a, b) => a.timestamp - b.timestamp);
    const data = summarize(bins, range, orderedBins.find(bin => bin.openingEnergy != null)?.openingEnergy ?? energyReadings[0]?.energy_active ?? null,
        [...orderedBins].reverse().find(bin => bin.closingEnergy != null)?.closingEnergy ?? energyReadings[energyReadings.length - 1]?.energy_active ?? null);
    if (cache.size > 100) cache.clear();
    cache.set(cacheKey, { timestamp: Date.now(), data });
    return data;
}

export async function getMeterUsage(db, params, now = new Date()) {
    const range = usageRange(params, now);
    const key = JSON.stringify([params.meterId, range.start, range.end, range.granularity]);
    if (pendingUsage.has(key)) return pendingUsage.get(key);
    const work = calculateMeterUsage(db, params, now);
    pendingUsage.set(key, work);
    try { return await work; }
    finally { if (pendingUsage.get(key) === work) pendingUsage.delete(key); }
}

export function combineMeterUsage(meters, range) {
    const sum = (items, field) => items.some(item => item[field] != null) ? items.reduce((total, item) => total + (item[field] ?? 0), 0) : null;
    const grouped = new Map();
    for (const meter of meters) {
        for (const row of meter.rows) {
            const group = grouped.get(row.period) || [];
            group.push(row);
            grouped.set(row.period, group);
        }
    }
    return {
        period: range.period, date: range.date, granularity: range.granularity, timezone: 'Asia/Kolkata',
        from: new Date(range.start).toISOString(), to: new Date(range.end).toISOString(),
        hasData: meters.some(meter => meter.hasData),
        runningSeconds: sum(meters, 'runningSeconds'), idleSeconds: sum(meters, 'idleSeconds'),
        energyConsumedKwh: sum(meters, 'energyConsumedKwh'),
        unrecordedSeconds: meters.reduce((total, meter) => total + meter.unrecordedSeconds, 0),
        energyEstimated: meters.some(meter => meter.energyEstimated), counterReset: meters.some(meter => meter.counterReset),
        incompleteEnergy: meters.some(meter => meter.energyConsumedKwh == null),
        rows: [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([period, items]) => ({
            period, runningSeconds: sum(items, 'runningSeconds'), idleSeconds: sum(items, 'idleSeconds'), energyConsumedKwh: sum(items, 'energyConsumedKwh'),
            energyAvailable: items.some(item => item.energyAvailable), energyEstimated: items.some(item => item.energyEstimated),
            incomplete: items.length < meters.length || items.some(item => item.runningSeconds == null || item.energyConsumedKwh == null)
        }))
    };
}

export async function getUsageOverview(db, params, now = new Date()) {
    const range = usageRange(params, now);
    const latest = await getLatestTelemetry(db);
    const config = await db.collection('config').findOne({ id: 'global_config' });
    const archivedIds = await db.collection('meter_usage_minutes').distinct('meterId', { timestamp: { $gte: new Date(range.start), $lt: new Date(range.effectiveEnd) } });
    const ids = params.meterId && params.meterId !== 'ALL' ? [params.meterId]
        : [...new Set([...(config?.meters || []).map(meter => meter.id), ...latest.map(reading => reading.meterId), ...archivedIds].filter(Boolean))].sort();
    const byId = new Map(latest.map(reading => [reading.meterId, reading]));
    const meters = [];
    // Bound database work when many meters share an Overview query.
    for (let index = 0; index < ids.length; index += 4) {
        meters.push(...await Promise.all(ids.slice(index, index + 4).map(async meterId => ({
            ...await getMeterUsage(db, { ...params, meterId }, now), meterId,
            meterName: config?.meters?.find(meter => meter.id === meterId)?.name || byId.get(meterId)?.meterName || meterId
        }))));
    }
    return { ...combineMeterUsage(meters, range), meters: meters.map(({ rows, ...meter }) => ({ ...meter,
        trendRows: rows.map(({ period, runningSeconds, idleSeconds }) => ({ period, runningSeconds, idleSeconds }))
    })), latest: latest.filter(reading => ids.includes(reading.meterId)), meterCount: ids.length };
}

export function legacyUsageParams(params, now = new Date()) {
    if (params.granularity && !['hourly', 'daily', 'monthly', 'yearly'].includes(params.granularity)) throw new Error('Invalid breakdown');
    const localDate = timestamp => new Date(timestamp + INDIA_OFFSET).toISOString().slice(0, 10);
    const options = { period: 'range', fromDate: params.from || localDate(now.getTime() - 30 * 86400000), toDate: params.to || localDate(now.getTime()), meterId: params.meterId || 'ALL',
        granularity: { hourly: 'hour', daily: 'day', monthly: 'month', yearly: 'year' }[params.granularity || 'daily'] };
    usageRange(options, now);
    return options;
}

export function meterHoursReport(overview) {
    return overview.meters.map(meter => {
        const total = (meter.runningSeconds ?? 0) + (meter.idleSeconds ?? 0);
        return { meterId: meter.meterId, meterName: meter.meterName,
            activeHours: meter.runningSeconds == null ? null : meter.runningSeconds / 3600,
            idleHours: meter.idleSeconds == null ? null : meter.idleSeconds / 3600,
            totalHours: total ? total / 3600 : null, activePct: total ? 100 * meter.runningSeconds / total : null,
            unrecordedSeconds: meter.unrecordedSeconds, energyConsumed: meter.energyConsumedKwh };
    });
}

export function energyUsageReport(overview) {
    return overview.rows.map(row => {
        const total = (row.runningSeconds ?? 0) + (row.idleSeconds ?? 0);
        return { period: row.period, energyConsumed: row.energyConsumedKwh,
            activeHours: row.runningSeconds == null ? null : row.runningSeconds / 3600,
            idleHours: row.idleSeconds == null ? null : row.idleSeconds / 3600,
            activePct: total ? row.runningSeconds / total * 100 : null, energyEstimated: row.energyEstimated, incomplete: row.incomplete };
    });
}
