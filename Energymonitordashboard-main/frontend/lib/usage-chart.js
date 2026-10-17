export function usageChartPoints(data) {
    if (!data) return [];
    const { from, to, granularity, rows } = data;
    const offset = 330 * 60000;
    const start = Date.parse(from), end = Date.parse(to);
    const step = { minute: 60000, hour: 3600000, day: 86400000 }[granularity];
    const first = new Date(start + offset);
    if (granularity === 'month' || granularity === 'year') first.setUTCDate(1);
    if (granularity === 'year') first.setUTCMonth(0);
    let cursor = step ? Math.floor((start + offset) / step) * step - offset : first.getTime() - offset;
    const byPeriod = new Map(rows.map(row => [row.period, row]));
    const points = [];
    while (cursor < end) {
        const local = new Date(cursor + offset);
        const period = local.toISOString().slice(0, { minute: 16, hour: 13, day: 10, month: 7, year: 4 }[granularity]);
        if (granularity === 'month') local.setUTCMonth(local.getUTCMonth() + 1);
        if (granularity === 'year') local.setUTCFullYear(local.getUTCFullYear() + 1);
        const next = step ? cursor + step : local.getTime() - offset;
        const pointStart = Math.max(cursor, start), pointEnd = Math.min(next, end);
        const timeLabel = timestamp => new Date(timestamp).toLocaleTimeString('en-US', {
            timeZone: 'Asia/Kolkata', hour: 'numeric', minute: granularity === 'minute' || new Date(timestamp + offset).getUTCMinutes() !== 0 ? '2-digit' : undefined, hour12: true
        });
        let label = granularity === 'minute' || granularity === 'hour' ? `${timeLabel(pointStart)} - ${timeLabel(pointEnd)}`
            : granularity === 'year' ? period : new Date(cursor).toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata', month: 'short', day: granularity === 'day' ? '2-digit' : undefined });
        if (data.period === 'range' && granularity === 'hour') label = `${period.slice(0, 10)} ${label}`;
        points.push({ ...(byPeriod.get(period) || {}), period, label, start: pointStart, end: pointEnd });
        cursor = next;
    }
    return points;
}

export function usageDrillSelection(point, granularity) {
    if (!point || granularity === 'minute') return null;
    if (granularity === 'year') return { period: 'year', date: point.period, granularity: 'month', timeRange: false };
    if (granularity === 'month') return { period: 'month', date: point.period, granularity: 'day', timeRange: false };
    if (granularity === 'day') return { period: 'day', date: point.period, granularity: 'hour', timeRange: false };
    const localTime = timestamp => new Date(timestamp + 330 * 60000).toISOString().slice(11, 16);
    return { period: 'day', date: point.period.slice(0, 10), granularity: 'minute', timeRange: true, fromTime: localTime(point.start), toTime: localTime(point.end) === '00:00' ? '' : localTime(point.end) };
}
