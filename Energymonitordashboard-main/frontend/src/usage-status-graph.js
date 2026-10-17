import Chart from 'chart.js/auto';
import { STATUS_COLORS, statusTrendPieces, statusTrendMarkers } from '../lib/usage-status.js';

const clock = time => new Date(time).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const statusHit = (chart, event) => chart.$statusHits?.find(segment => {
    const fraction = Math.max(0, Math.min(1, (event.x - segment.x1) / (segment.x2 - segment.x1)));
    const y = segment.y1 + (segment.y2 - segment.y1) * fraction;
    return event.x >= segment.x1 - 2 && event.x <= segment.x2 + 2 && Math.abs(event.y - y) <= 6;
});
const duration = seconds => seconds == null ? '-' : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds / 60) % 60}m`;

const timelinePlugin = {
    id: 'usageStatusTimeline',
    beforeDatasetsDraw(chart) {
        const model = chart.$statusModel;
        if (!model) return;
        const { ctx, chartArea, scales } = chart;
        ctx.save();
        ctx.beginPath(); ctx.rect(chartArea.left, chartArea.top, chartArea.width, chartArea.height); ctx.clip();
        ctx.globalAlpha = 0.1;
        const baseline = scales.duration.getPixelForValue(0);
        for (const lane of model.lanes) {
            for (const segment of lane.pieces) {
                if (!model[segment.state === 'running' ? 'showRunning' : 'showIdle']) continue;
                const x1 = scales.x.getPixelForValue(segment.fromX), x2 = scales.x.getPixelForValue(segment.toX);
                ctx.fillStyle = STATUS_COLORS[segment.state];
                ctx.beginPath();
                ctx.moveTo(x1, baseline);
                ctx.lineTo(x1, scales.duration.getPixelForValue(segment.fromHours));
                ctx.lineTo(x2, scales.duration.getPixelForValue(segment.toHours));
                ctx.lineTo(x2, baseline);
                ctx.closePath(); ctx.fill();
            }
        }
        ctx.restore();
    },
    afterDatasetsDraw(chart) {
        const model = chart.$statusModel;
        if (!model) return;
        const { ctx, chartArea, scales } = chart;
        chart.$statusHits = [];
        ctx.save();
        ctx.font = '12px sans-serif';
        ctx.beginPath();
        ctx.rect(chartArea.left, chartArea.top, chartArea.width, chartArea.height);
        ctx.clip();
        ctx.lineWidth = 3;
        ctx.lineJoin = 'round';
        model.lanes.forEach(lane => {
            for (const segment of lane.pieces) {
                if (!model[segment.state === 'running' ? 'showRunning' : 'showIdle']) continue;
                const x1 = scales.x.getPixelForValue(segment.fromX);
                const x2 = scales.x.getPixelForValue(segment.toX);
                const y1 = scales.duration.getPixelForValue(segment.fromHours);
                const y2 = scales.duration.getPixelForValue(segment.toHours);
                ctx.strokeStyle = STATUS_COLORS[segment.state];
                ctx.beginPath();
                ctx.moveTo(x1, y1);
                ctx.lineTo(x2, y2);
                ctx.stroke();
                chart.$statusHits.push({ ...segment, name: lane.name, x1, x2, y1, y2, y: (y1 + y2) / 2 });
            }
            for (const marker of lane.markers) {
                if (!model[marker.state === 'running' ? 'showRunning' : 'showIdle']) continue;
                const x = scales.x.getPixelForValue(marker.x), y = scales.duration.getPixelForValue(marker.hours);
                const radius = lane.points.length > 72 ? 2 : 4;
                ctx.fillStyle = STATUS_COLORS[marker.state];
                ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5;
                ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
                ctx.lineWidth = 3;
                chart.$statusHits.push({ ...marker, name: lane.name, x1: x - radius, x2: x + radius, y1: y, y2: y, y });
            }
        });
        ctx.restore();
        ctx.save();
        ctx.font = '12px sans-serif';
        const hit = chart.$statusHover;
        if (hit) {
            const lines = [hit.name, hit.period, `Running: ${duration(hit.runningSeconds)} | Idle: ${duration(hit.idleSeconds)}`,
                `${hit.state === 'running' ? 'Running' : 'Idle'} interval`, `${clock(hit.start)} - ${clock(hit.end)} IST`];
            const width = Math.min(chart.width - 12, Math.max(...lines.map(line => ctx.measureText(line).width)) + 20);
            const left = Math.max(6, Math.min(chart.width - width - 6, hit.x1));
            const top = Math.max(6, Math.min(chart.height - 108, hit.y + 16));
            ctx.fillStyle = '#111827'; ctx.fillRect(left, top, width, 102);
            ctx.fillStyle = '#fff';
            lines.forEach((line, lineIndex) => ctx.fillText(line, left + 10, top + 17 + lineIndex * 18, width - 20));
        }
        ctx.restore();
    },
    afterEvent(chart, args) {
        const event = args.event, model = chart.$statusModel;
        const hit = event.type === 'mouseout' ? null : statusHit(chart, event);
        if (chart.$statusHover !== hit) { chart.$statusHover = hit; args.changed = true; }
        if (hit) {
            chart.tooltip?.setActiveElements([], { x: event.x, y: event.y });
            chart.canvas.style.cursor = model.canDrill ? 'pointer' : 'default';
            if (event.type === 'click' && model.canDrill) {
                const position = chart.scales.x.getValueForPixel(event.x);
                model.drill(Math.max(0, Math.min(model.points.length - 1, Math.round(position))));
            }
        }
    }
};

export function renderStatusGraph({ chart, canvas, empty, data, lanes, points, unit, convertEnergy, showRunning, showIdle, showEnergy, loading, caption, drill }) {
    const visibleLanes = showRunning || showIdle ? lanes.map(lane => ({ ...lane, points: lane.points || points,
        pieces: statusTrendPieces(lane.points || points, lane.segments), markers: statusTrendMarkers(lane.points || points, lane.segments) })) : [];
    const hasStatus = visibleLanes.some(lane => lane.pieces.some(segment => segment.state === 'running' ? showRunning : showIdle));
    const values = points.map(point => point.energyConsumedKwh == null || point.energyEstimated && point.runningSeconds == null && point.idleSeconds == null ? null : convertEnergy(point.energyConsumedKwh));
    const hasValues = hasStatus || showEnergy && values.some(value => value != null);
    empty.hidden = hasValues;
    empty.textContent = !showRunning && !showIdle && !showEnergy ? 'No measurements selected' : loading && !data ? 'Loading usage...' : 'No readings for this period';
    canvas.style.visibility = hasValues ? 'visible' : 'hidden';
    canvas.parentElement.style.height = '360px';
    canvas.setAttribute('aria-label', `Running hours per period for ${caption}. One shaded trend line per meter with period markers, coloured green during recorded running intervals and orange during idle intervals. Hover shows running and idle totals. Energy columns in ${unit}.`);
    const model = { lanes: visibleLanes, points, showRunning, showIdle, canDrill: data?.granularity !== 'minute', drill };
    const datasets = [{ type: 'bar', label: `Energy Consumed (${unit})`, yAxisID: 'energy', data: values, hidden: !showEnergy,
        backgroundColor: '#2563eb', borderColor: '#2563eb', borderWidth: 1, maxBarThickness: 36, barPercentage: 0.8, categoryPercentage: 0.8 }];
    const xTitle = { day: 'Day', month: 'Month', year: 'Year' }[data?.granularity] || 'Time (IST)';
    const maxHours = visibleLanes.reduce((maximum, lane) => lane.points.reduce((value, point) => Math.max(value, (point.runningSeconds ?? 0) / 3600), maximum), 0);
    const options = {
        responsive: true, maintainAspectRatio: false, animation: false,
        layout: { padding: { top: 12 } },
        interaction: { mode: 'index', intersect: false },
        onClick(event, _items, current) {
            if (statusHit(current, event)) return;
            const hit = current.getElementsAtEventForMode(event, 'nearest', { intersect: true }, false)[0];
            if (hit && current.$statusModel.canDrill) current.$statusModel.drill(hit.index);
        },
        onHover(event, _items, current) {
            current.canvas.style.cursor = current.$statusModel.canDrill && current.getElementsAtEventForMode(event, 'nearest', { intersect: true }, false).length ? 'pointer' : 'default';
        },
        onResize(current, size) { current.options.scales.x.ticks.maxTicksLimit = size.width < 600 ? 4 : 10; },
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: context => `Energy Consumed: ${context.parsed.y.toFixed(4)} ${unit}` } } },
        scales: {
            x: { offset: true, grid: { display: false }, title: { display: true, text: xTitle }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: canvas.parentElement.clientWidth < 600 ? 4 : 10,
                callback: function(value) { const label = this.getLabelForValue(value); return label.includes(' - ') ? label.split(' - ').map((part, index) => index ? `- ${part}` : part) : label; } } },
            duration: { type: 'linear', position: 'left', display: showRunning || showIdle,
                min: 0, suggestedMax: maxHours * 1.12 || 1,
                title: { display: true, text: 'Running Hours / Period' }, grid: { color: '#eaf0f4' } },
            energy: { type: 'linear', position: 'right', display: showEnergy, beginAtZero: true, title: { display: true, text: `Energy (${unit})` }, grid: { drawOnChartArea: false } }
        }
    };
    if (!chart) {
        chart = new Chart(canvas, { type: 'bar', data: { labels: points.map(point => point.label), datasets }, options, plugins: [timelinePlugin] });
        chart.$statusModel = model;
    } else {
        chart.$statusModel = model; chart.$statusHover = null;
        chart.data = { labels: points.map(point => point.label), datasets };
        chart.options = options;
    }
    chart.update('none');
    return chart;
}
