import Chart from 'chart.js/auto';
import { escapeHtml } from '../lib/telemetry.js';
import { usageSummary, rankUsage } from '../lib/usage-summary.js';

const duration = seconds => seconds == null ? '-' : `${Math.floor(seconds / 3600)}h ${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}m`;
const today = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);

export function createUsageReports({ meters, buildings, convertEnergy, energyUnit }) {
    const states = new Map();
    for (const kind of ['ranking', 'report']) {
        const el = name => document.getElementById(`${kind}-${name}`);
        const state = { data: null, controller: null, chart: null, key: '', fetched: 0, generated: null };
        states.set(kind, state);
        el('date').value = today(); el('month').value = today().slice(0, 7); el('year').value = today().slice(0, 4);
        el('date-from').value = today(); el('date-to').value = today();
        const sync = () => {
            const period = el('period').value;
            for (const field of ['date', 'month', 'year', 'date-from', 'date-to']) {
                el(field).parentElement.hidden = period === 'range' ? !field.startsWith('date-') : field !== period.replace('day', 'date');
            }
        };
        sync();
        document.querySelectorAll(`#view-${kind === 'report' ? 'reports' : 'ranking'} .usage-report-filters select, #view-${kind === 'report' ? 'reports' : 'ranking'} .usage-report-filters input`).forEach(input => {
            input.addEventListener('change', () => {
                sync();
                if (kind === 'report') { state.data = null; state.controller?.abort(); state.controller = null; render(kind); el('status').textContent = 'Generate a report for the selected filters.'; }
                else refresh(kind, true);
            });
        });
    }
    document.getElementById('btn-generate-report').addEventListener('click', () => refresh('report', true));
    document.getElementById('btn-print-report').addEventListener('click', () => {
        if (!states.get('report').data) return;
        document.body.classList.add('printing-usage-report');
        window.print();
        document.body.classList.remove('printing-usage-report');
    });
    window.addEventListener('afterprint', () => document.body.classList.remove('printing-usage-report'));
    document.querySelector('[data-target="view-ranking"]').addEventListener('click', () => refresh('ranking'));

    function query(kind) {
        const el = name => document.getElementById(`${kind}-${name}`), period = el('period').value;
        const params = new URLSearchParams({ period, meterId: kind === 'report' ? document.getElementById('report-meter-select').value : 'ALL', granularity: period === 'year' ? 'month' : period === 'day' ? 'hour' : 'day' });
        if (period === 'range') { params.set('fromDate', el('date-from').value); params.set('toDate', el('date-to').value); }
        else params.set('date', el(period === 'day' ? 'date' : period).value);
        return params;
    }

    async function refresh(kind, force = false) {
        const state = states.get(kind), params = query(kind), key = params.toString();
        if (!force && key === state.key && (state.controller || Date.now() - state.fetched < 15000)) { render(kind); return; }
        state.controller?.abort();
        const controller = new AbortController(); state.controller = controller;
        state.key = key; state.fetched = Date.now(); state.data = null;
        render(kind); document.getElementById(`${kind}-status`).textContent = 'Loading usage...';
        try {
            const response = await fetch(`/api/usage-overview?${params}`, { signal: controller.signal, cache: 'no-store' });
            if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('Check the backend connection');
            const data = await response.json();
            if (!response.ok || data.error) throw new Error(data.error || 'Unable to load usage');
            if (state.controller !== controller) return;
            state.data = data; state.generated = new Date(); render(kind);
        } catch (error) {
            if (error.name !== 'AbortError' && state.controller === controller) document.getElementById(`${kind}-status`).textContent = error.message;
        } finally { if (state.controller === controller) state.controller = null; }
    }

    function selected(kind) {
        const data = states.get(kind).data;
        const b = document.getElementById(`${kind}-building-select`).value;
        const f = kind === 'report' ? document.getElementById('report-floor-select').value : 'ALL';
        return (data?.meters || []).map(usage => {
            const config = meters().find(m => m.id === usage.meterId) || {};
            const reading = data.latest.find(m => m.meterId === usage.meterId) || {};
            return { ...usage, building: config.building || reading.building || '', buildingName: config.buildingName || reading.buildingName || reading.building || '', floor: config.floor || reading.floor || '-' };
        }).filter(m => (b === 'ALL' || m.building === b || m.buildingName === buildings()[b]?.name) && (f === 'ALL' || m.floor === f));
    }

    function render(kind) {
        const state = states.get(kind), data = state.data, unit = energyUnit();
        const field = kind === 'ranking' ? document.getElementById('ranking-metric').value : 'energyConsumedKwh';
        const list = rankUsage(selected(kind), field), total = usageSummary(list);
        const energy = value => value == null ? '-' : convertEnergy(value).toFixed(4);
        document.querySelectorAll(`.${kind}-energy-unit`).forEach(node => { node.textContent = unit; });
        const notes = [];
        if (data) {
            if (!list.length) notes.push('No meters match the selected filters.');
            else if (!list.some(m => m.hasData)) notes.push('No readings for this period.');
            if (list.length > 1) notes.push('Hours are summed as meter-hours.');
            if (total.incompleteEnergy) notes.push('Energy totals include only meters with available readings.');
            if (total.energyEstimated) notes.push('Energy includes changes across gaps between readings.');
            if (total.counterReset) notes.push('Counter reset intervals excluded.');
            document.getElementById(`${kind}-status`).textContent = notes.join(' ');
        }
        document.getElementById(`${kind}-tbody`).innerHTML = list.length ? list.map((m, index) => `<tr>${kind === 'ranking' ? `<td>${m[field] == null ? '-' : index + 1}</td>` : ''}<td><strong>${escapeHtml(m.meterName)}</strong><br>${escapeHtml(m.meterId)}</td><td>${escapeHtml(m.buildingName || m.building || '-')}</td><td>${escapeHtml(m.floor)}</td><td>${duration(m.runningSeconds)}</td><td>${duration(m.idleSeconds)}</td><td>${energy(m.energyConsumedKwh)}</td><td>${duration(m.unrecordedSeconds)}</td><td>${[m.energyConsumedKwh == null ? 'No energy readings' : '', m.energyEstimated ? 'Gap estimate' : '', m.counterReset ? 'Counter reset' : ''].filter(Boolean).join('; ') || '-'}</td></tr>`).join('') : `<tr><td colspan="${kind === 'ranking' ? 9 : 8}">No usage data</td></tr>`;
        if (kind === 'report') {
            document.getElementById('btn-print-report').disabled = !data;
            document.getElementById('report-kpi-energy').textContent = `${energy(total.energyConsumedKwh)} ${unit}`;
            for (const [id, value] of [['hours', total.runningSeconds], ['idle', total.idleSeconds], ['unrecorded', total.unrecordedSeconds]]) document.getElementById(`report-kpi-${id}`).textContent = duration(value);
            document.getElementById('report-subtitle').textContent = 'No report generated';
            if (data) document.getElementById('report-subtitle').textContent = `${query(kind).get('date') || `${query(kind).get('fromDate')} to ${query(kind).get('toDate')}`} (IST) | ${document.getElementById('report-building-select').selectedOptions[0].text} | ${document.getElementById('report-floor-select').selectedOptions[0].text} | ${list.length} ${list.length === 1 ? 'meter' : 'meters'}`;
            document.getElementById('report-generated-date').textContent = data ? `Generated: ${state.generated.toLocaleString('en-GB', { timeZone: 'Asia/Kolkata' })} IST` : '';
        }
        const chartList = kind === 'ranking' ? list.filter(m => m[field] != null).slice(0, 10) : list.filter(m => m.energyConsumedKwh != null);
        const label = field === 'energyConsumedKwh' ? `Energy Consumed (${unit})` : field === 'runningSeconds' ? 'Running Hours' : 'Idle Hours';
        const canvas = document.getElementById(`${kind}-usage-chart`);
        const chartData = { labels: chartList.map(m => m.meterName || m.meterId), datasets: [{ label, data: chartList.map(m => field === 'energyConsumedKwh' ? convertEnergy(m[field]) : m[field] / 3600), backgroundColor: field === 'energyConsumedKwh' ? '#2563eb' : field === 'runningSeconds' ? '#16a34a' : '#d97706', maxBarThickness: 42 }] };
        if (!state.chart) state.chart = new Chart(canvas, { type: 'bar', data: chartData, options: { responsive: true, maintainAspectRatio: false, animation: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, title: { display: true, text: label } }, x: { ticks: { maxRotation: 45 } } } } });
        else { state.chart.data = chartData; state.chart.options.scales.y.title.text = label; state.chart.update(); }
        document.getElementById(`${kind}-chart-empty`).hidden = chartList.length > 0;
        canvas.style.visibility = chartList.length ? 'visible' : 'hidden';
    }

    return {
        tick() {
            const select = document.getElementById('ranking-building-select');
            const entries = Object.entries(buildings());
            if (select.options.length !== entries.length + 1 || entries.some(([id, building]) => !Array.from(select.options).some(option => option.value === id && option.text === building.name))) {
                const previous = select.value;
                select.replaceChildren(new Option('All Buildings', 'ALL'), ...entries.map(([id, building]) => new Option(building.name, id)));
                select.value = Array.from(select.options).some(option => option.value === previous) ? previous : 'ALL';
            }
            if (document.getElementById('view-ranking').style.display !== 'none') refresh('ranking');
        },
        render() { for (const kind of states.keys()) render(kind); },
        reset() { for (const [kind, state] of states) { state.controller?.abort(); state.controller = null; state.data = null; state.key = ''; state.chart?.destroy(); state.chart = null; render(kind); } }
    };
}
