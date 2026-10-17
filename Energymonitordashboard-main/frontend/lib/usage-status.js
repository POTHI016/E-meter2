export const STATUS_COLORS = { running: '#16a34a', idle: '#d97706' };

export function appendStatus(segments, start, end, state) {
    if (!(state in STATUS_COLORS) || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
    const previous = segments[segments.length - 1];
    if (previous?.state === state && previous.end === start) previous.end = end;
    else segments.push({ start, end, state });
}

export function statusTimeline(bins, start, end) {
    const segments = [];
    let incomplete = false;
    for (const bin of [...bins.values()].sort((a, b) => a.timestamp - b.timestamp)) {
        const knownSeconds = bin.runningSeconds + bin.idleSeconds;
        let states = bin.states;
        // Older archives locate a state precisely only when it fills the entire minute.
        if (!Array.isArray(states)) {
            states = [];
            if (knownSeconds === 60 && (bin.runningSeconds === 60 || bin.idleSeconds === 60)) {
                states.push({ start: bin.timestamp, end: bin.timestamp + 60000, state: bin.runningSeconds === 60 ? 'running' : 'idle' });
            } else if (knownSeconds > 0) incomplete = true;
        }
        for (const segment of states) appendStatus(segments, Math.max(start, segment.start), Math.min(end, segment.end), segment.state);
    }
    return { segments, incomplete };
}

export function statusPosition(points, time) {
    if (!points.length) return null;
    let low = 0, high = points.length - 1;
    while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (points[middle].end < time) low = middle + 1;
        else high = middle;
    }
    const point = points[low];
    return low - 0.5 + Math.max(0, Math.min(1, (time - point.start) / (point.end - point.start)));
}

export function statusTrendPieces(points, segments) {
    const edges = [];
    const hours = point => point?.runningSeconds == null ? null : point.runningSeconds / 3600;
    for (let index = 0; index < points.length; index++) {
        const value = hours(points[index]);
        if (value === null) continue;
        if (hours(points[index - 1]) === null) edges.push({ left: index - 0.5, right: index, opening: value, closing: value });
        const next = hours(points[index + 1]);
        edges.push({ left: index, right: index + (next === null ? 0.5 : 1), opening: value, closing: next ?? value });
    }
    const pieces = [];
    let firstEdge = 0;
    for (const segment of segments) {
        const start = statusPosition(points, segment.start), end = statusPosition(points, segment.end);
        if (start === null || end <= start) continue;
        while (firstEdge < edges.length && edges[firstEdge].right <= start) firstEdge++;
        for (let index = firstEdge; index < edges.length && edges[index].left < end; index++) {
            const edge = edges[index], left = Math.max(start, edge.left), right = Math.min(end, edge.right);
            if (right <= left) continue;
            const interpolate = position => edge.opening + (edge.closing - edge.opening) * (position - edge.left) / (edge.right - edge.left);
            const point = points[Math.max(0, Math.min(points.length - 1, Math.round((left + right) / 2)))];
            pieces.push({ ...segment, fromX: left, toX: right, fromHours: interpolate(left), toHours: interpolate(right),
                period: point.label, runningSeconds: point.runningSeconds, idleSeconds: point.idleSeconds });
        }
    }
    return pieces;
}

export function statusTrendMarkers(points, segments) {
    const markers = [];
    let segmentIndex = 0;
    points.forEach((point, index) => {
        if (point.runningSeconds == null) return;
        const timestamp = (point.start + point.end) / 2;
        while (segmentIndex < segments.length && segments[segmentIndex].end <= timestamp) segmentIndex++;
        const segment = segments[segmentIndex];
        if (!segment || timestamp < segment.start) return;
        markers.push({ ...segment, x: index, hours: point.runningSeconds / 3600, period: point.label,
            runningSeconds: point.runningSeconds, idleSeconds: point.idleSeconds });
    });
    return markers;
}
