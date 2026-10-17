export const LIVE_TIMEOUT_MS = 5 * 60 * 1000;
const numericFields = ['v_r', 'v_y', 'v_b', 'v_ry', 'v_yb', 'v_br', 'i_r', 'i_y', 'i_b', 'power_r', 'power_y', 'power_b', 'apparent_r', 'apparent_y', 'apparent_b', 'pf_r', 'pf_y', 'pf_b', 'frequency', 'total_power_kw', 'total_apparent_kva', 'avg_power_factor', 'energy_active', 'energy_reactive'];
const indexTasks = new WeakMap();

export const numericReading = value => !['number', 'string'].includes(typeof value) || typeof value === 'string' && !value.trim() || !Number.isFinite(Number(value)) ? null : Number(value);
export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

export function telemetryMeterId(body) {
    const ids = [body?.meterId, body?.meter_id].filter(value => value != null).map(value => typeof value === 'string' ? value.trim() : '');
    if (!ids.length || ids.some(id => !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(id)) || ids.includes('ALL')) throw new Error('A unique meterId or meter_id is required (letters, numbers, _, -, ., : only)');
    if (new Set(ids).size !== 1) throw new Error('meterId and meter_id must identify the same meter');
    return ids[0];
}

export function calculateElectricalReadings(input) {
    const result = { ...input };
    const sum = fields => fields.every(field => numericReading(result[field]) !== null)
        ? fields.reduce((total, field) => total + numericReading(result[field]), 0) : null;
    for (const phase of ['r', 'y', 'b']) {
        const voltage = numericReading(input[`v_${phase}`]);
        const current = numericReading(input[`i_${phase}`]);
        let apparent = numericReading(input[`apparent_${phase}`]);
        let active = numericReading(input[`power_${phase}`]);
        let pf = numericReading(input[`pf_${phase}`]);
        if (pf !== null && Math.abs(pf) > 1) pf = null;
        if (apparent === null && voltage !== null && current !== null && voltage >= 0 && current >= 0) apparent = voltage * current / 1000;
        if (active === null && apparent !== null && pf !== null) active = apparent * pf;
        if (pf === null && active !== null && apparent > 0 && Math.abs(active / apparent) <= 1) pf = active / apparent;
        result[`apparent_${phase}`] = apparent;
        result[`power_${phase}`] = active;
        result[`pf_${phase}`] = pf;
    }
    result.total_power_kw = numericReading(input.total_power_kw) ?? sum(['power_r', 'power_y', 'power_b']);
    result.total_apparent_kva = numericReading(input.total_apparent_kva) ?? sum(['apparent_r', 'apparent_y', 'apparent_b']);
    const suppliedPf = numericReading(input.avg_power_factor);
    const phasePf = sum(['pf_r', 'pf_y', 'pf_b']);
    const ratio = result.total_apparent_kva > 0 && result.total_power_kw !== null ? result.total_power_kw / result.total_apparent_kva : null;
    result.avg_power_factor = suppliedPf !== null && Math.abs(suppliedPf) <= 1 ? suppliedPf
        : ratio !== null && Math.abs(ratio) <= 1 ? ratio : phasePf === null ? null : phasePf / 3;
    return result;
}

export function normalizeTelemetry(body, now = new Date()) {
    const meterId = telemetryMeterId(body);
    const timestamp = new Date(body.timestamp ?? now);
    if (!Number.isFinite(timestamp.getTime()) || timestamp.getTime() > now.getTime() + 60000) throw new Error('Invalid telemetry timestamp; send an ISO timestamp with timezone, or omit it');
    const doc = { meterId, meter_id: meterId, timestamp };
    const aliases = { meterName: 'meter_name', building: 'buildingName', floor: 'floorName' };
    for (const field of ['meterName', 'building', 'floor', 'panel', 'status']) doc[field] = body[field] ?? (aliases[field] ? body[aliases[field]] : null) ?? null;
    for (const field of numericFields) doc[field] = numericReading(body[field]);
    doc.on_hours = numericReading(body.on_hours ?? body.onHours ?? body.running_hours);
    doc.idle_hours = numericReading(body.idle_hours ?? body.idleHours);
    const currents = [doc.i_r, doc.i_y, doc.i_b];
    doc.meter_status = currents.some(value => value !== null && value > 0) ? 'active' : currents.every(value => value === 0) ? 'idle' : 'unknown';
    return calculateElectricalReadings(doc);
}

export function isTelemetryLive(reading, now = Date.now()) {
    const timestamp = new Date(reading?.timestamp).getTime();
    return Number.isFinite(timestamp) && timestamp <= now + 60000 && now - timestamp <= LIVE_TIMEOUT_MS;
}

export async function saveLatestTelemetry(db, doc) {
    // Conditional replacement prevents delayed packets from replacing a newer reading.
    await db.collection('telemetry_latest').updateOne({ _id: doc.meterId }, [{ $set: { reading: {
        $cond: [{ $gte: [{ $literal: doc.timestamp }, { $ifNull: ['$reading.timestamp', new Date(0)] }] }, { $literal: doc }, '$reading']
    } } }], { upsert: true });
}

export async function getLatestTelemetry(db, meterId) {
    if (!indexTasks.has(db) && typeof db.collection('telemetry_history').createIndex === 'function') {
        indexTasks.set(db, Promise.all([
            db.collection('telemetry_history').createIndex({ meterId: 1, timestamp: -1, _id: -1 }),
            db.collection('meter_usage_minutes').createIndex({ meterId: 1, timestamp: 1 })
        ]).catch(error => { indexTasks.delete(db); throw error; }));
    }
    if (indexTasks.has(db)) await indexTasks.get(db);
    const projection = Object.fromEntries([...numericFields, 'meterId', 'meter_id', 'meterName', 'building', 'floor', 'panel', 'status', 'meter_status', 'timestamp', 'on_hours', 'idle_hours'].map(field => [field, 1]));
    const saved = await db.collection('telemetry_latest').find(meterId ? { _id: meterId } : {}).toArray();
    const collection = db.collection('telemetry_history');
    const ids = meterId ? [meterId] : await collection.distinct('meterId');
    const recent = [];
    // Indexed per-ID lookups avoid scanning or sorting every historical packet on each live poll.
    for (let index = 0; index < ids.length; index += 4) {
        recent.push(...(await Promise.all(ids.slice(index, index + 4).filter(id => typeof id === 'string' && id).map(async id => {
            const [reading] = await collection.find({ meterId: id }, { projection }).sort({ timestamp: -1, _id: -1 }).limit(1).toArray();
            return { reading };
        }))));
    }
    const byId = new Map();
    for (const { reading } of [...saved, ...recent]) {
        if (!reading?.meterId) continue;
        const previous = byId.get(reading.meterId);
        if (!previous || new Date(reading.timestamp) >= new Date(previous.timestamp)) byId.set(reading.meterId, calculateElectricalReadings(reading));
    }
    return [...byId.values()].sort((a, b) => a.meterId.localeCompare(b.meterId));
}
