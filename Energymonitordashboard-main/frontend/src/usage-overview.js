import { renderStatusGraph } from './usage-status-graph.js';
import { escapeHtml, isTelemetryLive } from '../lib/telemetry.js';
import { usageChartPoints, usageDrillSelection } from '../lib/usage-chart.js';
const todayInIndia = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const duration = seconds => seconds == null ? '-' : `${Math.floor(Math.max(0, seconds) / 3600)}h ${String(Math.floor(Math.max(0, seconds) / 60) % 60).padStart(2, '0')}m`;

export function createUsageOverview({ convertEnergy, energyUnit, telemetry }) {
    const el = name => document.getElementById(`overview-${name}`);
    let data = null, chart = null, request = null, lastKey = '', lastFetch = 0, page = 0;
    let period = 'day', followToday = true;
    const history = [];
    const today = todayInIndia();
    el('date').value = today;
    el('month').value = today.slice(0, 7);
    el('year').value = today.slice(0, 4);
    el('from-date').value = today;
    el('to-date').value = today;
    const meterSelect = document.getElementById('overview-filter-meter');
    const fields = ['date', 'month', 'year', 'from-date', 'to-date', 'from-time', 'to-time', 'granularity'];

    function sync(granularity) {
        document.querySelectorAll('.overview-period-buttons button').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.period === period)));
        for (const name of ['date', 'month', 'year', 'from-date', 'to-date']) el(name).parentElement.hidden = period === 'range' ? !name.endsWith('-date') : name !== ({ day: 'date', month: 'month', year: 'year' }[period]);
        const options = period === 'day' ? [['hour', 'Hourly'], ['minute', 'By Minute']]
            : period === 'month' ? [['day', 'Daily']] : period === 'year' ? [['month', 'Monthly']] : [['day', 'Daily'], ['hour', 'Hourly'], ['month', 'Monthly'], ['year', 'Yearly']];
        el('granularity').replaceChildren(...options.map(([value, label]) => new Option(label, value)));
        if (granularity) el('granularity').value = granularity;
        el('time-toggle').hidden = period !== 'day';
        el('time-inputs').hidden = period !== 'day' || !el('time-range').checked;
        el('back').hidden = history.length === 0;
    }

    function params() {
        if (period === 'day' && followToday) el('date').value = todayInIndia();
        const query = new URLSearchParams({ period, meterId: meterSelect.value, granularity: el('granularity').value });
        if (period === 'range') { query.set('fromDate', el('from-date').value); query.set('toDate', el('to-date').value); }
        else query.set('date', el({ day: 'date', month: 'month', year: 'year' }[period]).value);
        if (period === 'day' && el('time-range').checked) { query.set('fromTime', el('from-time').value); query.set('toTime', el('to-time').value); }
        return query;
    }

    function caption() {
        if (!data) return '';
        const label = data.period === 'range' || data.period === 'year' ? data.date
            : new Date(`${data.date}${data.period === 'month' ? '-01' : ''}T00:00:00+05:30`).toLocaleDateString('en-GB', {
                timeZone: 'Asia/Kolkata', day: data.period === 'day' ? '2-digit' : undefined, month: 'short', year: 'numeric'
            });
        return data.period === 'day' && el('time-range').checked ? `${label} | ${el('from-time').value || '00:00'} - ${el('to-time').value || '24:00'}` : label;
    }

    async function refresh(force = false) {
        if (!force && document.getElementById('view-overview').style.display === 'none') return;
        const query = params(), key = query.toString();
        if (!force && key === lastKey && (request || Date.now() - lastFetch < 15000)) return;
        request?.abort();
        const active = new AbortController();
        request = active;
        if (key !== lastKey || force) { data = null; page = 0; el('status').textContent = 'Loading usage...'; render(); }
        lastKey = key; lastFetch = Date.now();
        try {
            const response = await fetch(`/api/usage-overview?${query}`, { cache: 'no-store', signal: active.signal });
            const result = response.headers.get('content-type')?.includes('application/json') ? await response.json() : { error: 'Check the backend connection' };
            if (!response.ok || result.error) throw new Error(result.error || 'Unable to load usage');
            if (request !== active) return;
            data = result;
            const notes = [];
            if (!data.hasData) notes.push('No readings for this period.');
            if (data.meterCount > 1) notes.push(`Hours are summed across ${data.meterCount} meters (meter-hours).`);
            if (data.unrecordedSeconds >= 60) notes.push(`Unrecorded time: ${duration(data.unrecordedSeconds)}.`);
            if (data.incompleteEnergy) notes.push('Energy total includes only meters with available readings.');
            if (data.energyEstimated) notes.push('Energy breakdown includes gaps between readings.');
            if (data.counterReset) notes.push('Energy counter reset detected; reset intervals excluded.');
            el('status').textContent = notes.join(' ');
            render();
        } catch (error) {
            if (error.name !== 'AbortError' && request === active) { data = null; el('status').textContent = error.message; render(); }
        } finally { if (request === active) request = null; }
    }

    function drill(index) {
        if (!data) return;
        const point = usageChartPoints(data)[index];
        if (!point || !['runningSeconds', 'idleSeconds', 'energyConsumedKwh'].some(field => point[field] != null)) return;
        const selection = usageDrillSelection(point, data.granularity);
        if (!selection) return;
        history.push({ period, followToday, meterId: meterSelect.value, timeRange: el('time-range').checked, values: Object.fromEntries(fields.map(name => [name, el(name).value])) });
        period = selection.period; followToday = false;
        el({ day: 'date', month: 'month', year: 'year' }[period]).value = selection.date;
        el('time-range').checked = selection.timeRange;
        if (selection.timeRange) { el('from-time').value = selection.fromTime; el('to-time').value = selection.toTime; }
        sync(selection.granularity);
        refresh(true);
    }

    function render() {
        const unit = energyUnit(), label = caption();
        const energy = value => value == null ? '-' : convertEnergy(value).toFixed(4);
        for (const id of ['meter-period', 'breakdown-period', 'graph-period']) el(id).textContent = label;
        document.querySelectorAll('.overview-energy-unit').forEach(node => { node.textContent = unit; });
        document.getElementById('kpi-active-hours').textContent = duration(data?.runningSeconds);
        document.getElementById('kpi-idle-hours').textContent = duration(data?.idleSeconds);
        document.getElementById('kpi-energy').innerHTML = `${energy(data?.energyConsumedKwh)} <span>${unit}</span>`;
        const recorded = (data?.runningSeconds ?? 0) + (data?.idleSeconds ?? 0);
        document.getElementById('kpi-active-pct').textContent = `${recorded ? Math.round(data.runningSeconds / recorded * 100) + '% of recorded time | ' : ''}${label}`;
        document.getElementById('kpi-idle-pct').textContent = `${recorded ? Math.round(data.idleSeconds / recorded * 100) + '% of recorded time | ' : ''}${label}`;
        document.getElementById('kpi-energy-cmp').textContent = label;
        const liveById = new Map((data?.latest || []).map(reading => [reading.meterId, reading]));
        for (const reading of telemetry()) liveById.set(reading.meterId, reading);
        const selected = (data?.meters || []).map(meter => liveById.get(meter.meterId)).filter(reading => reading && isTelemetryLive(reading));
        const withPower = selected.filter(reading => reading.total_power_kw != null);
        const withPf = selected.filter(reading => reading.avg_power_factor != null);
        document.getElementById('kpi-demand').textContent = withPower.length ? convertEnergy(withPower.reduce((total, reading) => total + Number(reading.total_power_kw), 0)).toFixed(2) : '-';
        document.getElementById('kpi-pf').textContent = withPf.length ? (withPf.reduce((total, reading) => total + Number(reading.avg_power_factor), 0) / withPf.length).toFixed(2) : '-';
        document.getElementById('kpi-meters').textContent = `${selected.length} / ${data?.meterCount ?? 0}`;
        el('meter-rows').innerHTML = data?.meters.length ? data.meters.map(meter => {
            const reading = liveById.get(meter.meterId), live = isTelemetryLive(reading);
            const number = value => value == null ? '-' : Number(value).toFixed(2);
            return `<tr><td><strong>${escapeHtml(meter.meterName)}</strong><br><span class="overview-meter-id">${escapeHtml(meter.meterId)}</span></td><td>${live ? 'LIVE' : 'OFFLINE'}</td><td>${duration(meter.runningSeconds)}</td><td>${duration(meter.idleSeconds)}</td><td>${energy(meter.energyConsumedKwh)}</td><td>${duration(meter.unrecordedSeconds)}</td><td>${live ? number(reading.total_power_kw == null ? null : convertEnergy(reading.total_power_kw)) : '-'}</td><td>${live ? number(reading.avg_power_factor) : '-'}</td></tr>`;
        }).join('') : '<tr><td colspan="8">No meter usage available</td></tr>';
        const rows = data?.rows || [], points = usageChartPoints(data);
        const count = Math.ceil(rows.length / 60);
        page = Math.max(0, Math.min(page, count - 1));
        el('usage-rows').innerHTML = rows.length ? rows.slice(page * 60, (page + 1) * 60).map(row => {
            const point = points.find(item => item.period === row.period);
            const rowLabel = point?.label || row.period;
            const periodCell = data.granularity === 'minute' ? escapeHtml(rowLabel) : `<button type="button" class="overview-period-link" data-period="${escapeHtml(row.period)}" title="View a more detailed period">${escapeHtml(rowLabel)}</button>`;
            return `<tr><td>${periodCell}</td><td>${duration(row.runningSeconds)}</td><td>${duration(row.idleSeconds)}</td><td>${energy(row.energyConsumedKwh)}</td></tr>`;
        }).join('') : '<tr><td colspan="4">No usage data</td></tr>';
        el('pagination').hidden = count <= 1;
        el('page').textContent = `${page + 1} / ${count}`;
        el('prev').disabled = page === 0; el('next').disabled = page >= count - 1;
        el('back').hidden = history.length === 0;
        renderGraph(points);
    }

    function renderGraph(points) {
        const meters = data?.meters || [];
        el('timeline-note').hidden = !meters.some(meter => meter.timeline?.incomplete);
        chart = renderStatusGraph({
            chart, canvas: el('chart'), empty: el('graph-empty'), data, points,
            unit: energyUnit(), convertEnergy,
            lanes: meters.map(meter => ({ name: meter.meterName || meter.meterId, segments: meter.timeline?.segments || [],
                points: meter.trendRows ? usageChartPoints({ ...data, rows: meter.trendRows }) : meters.length === 1 ? points : [] })),
            showRunning: el('running').checked, showIdle: el('idle').checked, showEnergy: el('energy').checked,
            loading: Boolean(request), caption: caption(), drill
        });
    }

    document.querySelectorAll('.overview-period-buttons button').forEach(button => button.addEventListener('click', () => {
        period = button.dataset.period; history.length = 0; sync(); refresh(true);
    }));
    for (const node of [meterSelect, ...fields.map(el), el('time-range')]) node.addEventListener('change', () => {
        history.length = 0;
        if (node === el('date')) followToday = node.value === todayInIndia();
        sync(el('granularity').value); refresh(true);
    });
    for (const id of ['running', 'idle', 'energy']) el(id).addEventListener('change', render);
    el('back').addEventListener('click', () => {
        const saved = history.pop(); if (!saved) return;
        period = saved.period; followToday = saved.followToday; meterSelect.value = saved.meterId;
        el('time-range').checked = saved.timeRange; sync(saved.values.granularity);
        for (const [name, value] of Object.entries(saved.values)) el(name).value = value;
        refresh(true);
    });
    el('usage-rows').addEventListener('click', event => {
        const button = event.target.closest('[data-period]');
        if (button) drill(usageChartPoints(data).findIndex(point => point.period === button.dataset.period));
    });
    for (const [id, change] of [['prev', -1], ['next', 1]]) el(id).addEventListener('click', () => { page += change; render(); });
    sync();
    return {
        refresh, render,
        destroyChart() { chart?.destroy(); chart = null; },
        reset() { request?.abort(); request = null; data = null; lastKey = ''; lastFetch = 0; history.length = 0; chart?.destroy(); chart = null; }
    };
}
