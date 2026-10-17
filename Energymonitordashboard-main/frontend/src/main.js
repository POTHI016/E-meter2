import Chart from 'chart.js/auto';
import { calculateElectricalReadings, numericReading, isTelemetryLive, escapeHtml, telemetryMeterId } from '../lib/telemetry.js';
import { usageChartPoints } from '../lib/usage-chart.js';
import { createUsageOverview } from './usage-overview.js';
import { createUsageReports } from './usage-reports.js';
import { renderStatusGraph } from './usage-status-graph.js';

// main.js - Ibots Energy Monitor Engine

const GRID_SUPPLY_KW = 500;

let currentUser = null;
let simulationInterval = null;
let powerUnit = 'kW';
let currentMonthUsage = 0;
let floorThresholds = {}; // { floorName: { v: 240, p: 5 } }
let dynamicAlerts = []; // array of alerts

// =============================================
// DATA MODEL
// =============================================
const BUILDINGS = {};

const ALL_METERS = [];

function rebuildMeters() {
    ALL_METERS.length = 0;
}
rebuildMeters();

let overviewUsageView = null;
let usageReportsView = null;
let historyData = [];

// =============================================
// LOGIN
// =============================================
function initLogin() {
    const form = document.getElementById('login-form');
    const togglePw = document.getElementById('toggle-password');
    const logoutBtn = document.getElementById('btn-logout');

    form.addEventListener('submit', (e) => {
        e.preventDefault();
        const username = document.getElementById('login-username').value.trim().toLowerCase();
        const password = document.getElementById('login-password').value;
        const errorBox = document.getElementById('login-error');
        
        fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        })
        .then(res => {
            if (!res.ok) throw new Error('Invalid username or password.');
            return res.json();
        })
        .then(data => {
            localStorage.setItem('jwt_token', data.token);
            currentUser = data.user;
            errorBox.style.display = 'none';
            document.getElementById('login-screen').style.display = 'none';
            document.getElementById('dashboard-layout').style.display = 'flex';
            document.getElementById('sidebar-user-label').textContent = `USER: ${currentUser.role.toUpperCase()}`;
            if (currentUser.access === 'readonly') {
                const s = document.querySelector('[data-target="view-settings"]');
                if (s) s.style.display = 'none';
            }
            initCharts();
            initSimulation();
            populateHistoryTable();
            populateAlerts();
        })
        .catch(err => {
            errorBox.textContent = err.message;
            errorBox.style.display = 'block';
        });
    });

    togglePw.addEventListener('click', () => {
        const pw = document.getElementById('login-password');
        const icon = togglePw.querySelector('i');
        if (pw.type === 'password') { pw.type = 'text'; icon.classList.replace('fa-eye', 'fa-eye-slash'); }
        else { pw.type = 'password'; icon.classList.replace('fa-eye-slash', 'fa-eye'); }
    });

    logoutBtn.addEventListener('click', () => {
        localStorage.removeItem('jwt_token');
        currentUser = null;
        if (simulationInterval) clearInterval(simulationInterval);
        simulationInterval = null;
        destroyCharts();
        liveUsageRequest?.abort();
        liveUsageRequest = null;
        liveUsageData = null;
        liveUsageKey = '';
        liveUsageDrillHistory = [];
        liveTelemetryByMeter.clear();
        latestTelemetry = null;
        overviewUsageView?.reset();
        usageReportsView?.reset();
        window._liveSelectedMeterId = null;
        document.getElementById('live-sub-detail').style.display = 'none';
        document.getElementById('live-sub-selection').style.display = 'block';
        document.getElementById('dashboard-layout').style.display = 'none';
        document.getElementById('login-screen').style.display = 'flex';
        document.getElementById('login-form').reset();
        const s = document.querySelector('[data-target="view-settings"]');
        if (s) s.style.display = '';
    });
}

function checkSession() {
    const token = localStorage.getItem('jwt_token');
    if (!token) {
        document.getElementById('login-screen').style.display = 'flex';
        return;
    }
    
    // Hide login screen instantly if we have a token (prevents flash of login screen)
    document.getElementById('login-screen').style.display = 'none';

    fetch('/api/verify-token', {
        headers: { 'Authorization': 'Bearer ' + token }
    })
    .then(res => {
        if (!res.ok) throw new Error('Token verification failed');
        return res.json();
    })
    .then(data => {
        currentUser = data.user;
        document.getElementById('dashboard-layout').style.display = 'flex';
        document.getElementById('sidebar-user-label').textContent = `USER: ${currentUser.role.toUpperCase()}`;
        if (currentUser.access === 'readonly') {
            const s = document.querySelector('[data-target="view-settings"]');
            if (s) s.style.display = 'none';
        }
        initCharts();
        initSimulation();
        populateHistoryTable();
        populateAlerts();
    })
    .catch(() => {
        localStorage.removeItem('jwt_token');
        document.getElementById('login-screen').style.display = 'flex';
    });
}

function convertPower(valKw) {
    return powerUnit === 'W' ? valKw * 1000 : valKw;
}

function getUnitLabel() {
    return powerUnit;
}

function getEnergyUnitLabel() {
    return powerUnit === 'W' ? 'Wh' : 'kWh';
}

// =============================================
// NAVIGATION
// =============================================
function initNavigation() {
    const navItems = document.querySelectorAll('.nav-item');
    const views = document.querySelectorAll('.page-view');
    navItems.forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            navItems.forEach(n => n.classList.remove('active'));
            item.classList.add('active');
            const target = item.getAttribute('data-target');
            views.forEach(v => {
                v.style.display = v.id === target ? 'flex' : 'none';
                v.classList.toggle('active', v.id === target);
            });

            // Live meter usage has its own period filters.
            const dateContainer = document.getElementById('header-date-filter-container');
            if (dateContainer) {
                if (target === 'view-history') {
                    dateContainer.style.display = 'flex';
                } else {
                    dateContainer.style.display = 'none';
                }
            }

            // Auto-resume live simulation when returning to live data tab
            if (target === 'view-live') {
                initSimulation();
            }
        });
    });
}

// =============================================
// DYNAMIC FILTERS
// =============================================
function populateFilters() {
    // Filters have been moved to time-based.
}

function populateSettingsDropdowns() {
    const floorBldg = document.getElementById('settings-floor-building');
    const meterBldg = document.getElementById('settings-meter-building');
    const meterFloor = document.getElementById('settings-meter-floor');
    const alarmBldg = document.getElementById('settings-alarm-building');
    const alarmFloor = document.getElementById('settings-alarm-floor');
    if (!floorBldg) return;
    [floorBldg, meterBldg].forEach(sel => {
        sel.innerHTML = '';
        Object.entries(BUILDINGS).forEach(([key, b]) => {
            sel.innerHTML += `<option value="${key}">${b.name}</option>`;
        });
    });

    if (alarmBldg && alarmFloor) {
        alarmBldg.innerHTML = '';
        Object.entries(BUILDINGS).forEach(([key, b]) => {
            alarmBldg.innerHTML += `<option value="${key}">${b.name}</option>`;
        });

        const triggerAlarmFloorChange = () => {
            const b = alarmBldg.value;
            const f = alarmFloor.value;
            const key = `${b}_${f}`;
            const t = floorThresholds[key] || { v: 240, p: 5 };
            document.getElementById('settings-alarm-voltage').value = t.v;
            document.getElementById('settings-alarm-power').value = t.p;
        };

        const updateAlarmFloors = () => {
            const bKey = alarmBldg.value;
            alarmFloor.innerHTML = '';
            if (BUILDINGS[bKey]) {
                BUILDINGS[bKey].floors.forEach(f => {
                    alarmFloor.innerHTML += `<option value="${f}">${f}</option>`;
                });
            }
            triggerAlarmFloorChange();
        };

        alarmBldg.addEventListener('change', updateAlarmFloors);
        alarmFloor.addEventListener('change', triggerAlarmFloorChange);
        updateAlarmFloors();
    }

    const updateMeterFloors = () => {
        const bKey = meterBldg.value;
        meterFloor.innerHTML = '';
        if (BUILDINGS[bKey]) {
            BUILDINGS[bKey].floors.forEach(f => {
                meterFloor.innerHTML += `<option value="${f}">${f}</option>`;
            });
        }
    };
    meterBldg.addEventListener('change', updateMeterFloors);
    updateMeterFloors();
    populateLiveFilters();
    populateOverviewMeterDropdown();
    populateReportFilters();
}

window.deleteBuilding = function(bKey) {
    if (!BUILDINGS[bKey]) return;
    const bName = BUILDINGS[bKey].name;
    if (confirm(`Are you sure you want to delete building "${bName}" and all its meters?`)) {
        delete BUILDINGS[bKey];
        for (let i = ALL_METERS.length - 1; i >= 0; i--) {
            if (ALL_METERS[i].building === bKey || ALL_METERS[i].buildingName === bName) {
                ALL_METERS.splice(i, 1);
            }
        }
        saveConfig();
        populateLiveFilters();
        populateSettingsDropdowns();
        updateConfigTable();
        updateSimulation();
        showToast(`Building "${bName}" deleted successfully`);
    }
};

window.deleteMeter = function(meterId) {
    const meter = ALL_METERS.find(m => m.id === meterId);
    if (!meter) return;
    if (confirm(`Are you sure you want to delete meter "${meterId}"?`)) {
        const idx = ALL_METERS.findIndex(m => m.id === meterId);
        if (idx !== -1) {
            const bKey = ALL_METERS[idx].building;
            if (BUILDINGS[bKey] && BUILDINGS[bKey].meterCount > 0) {
                BUILDINGS[bKey].meterCount--;
            }
            ALL_METERS.splice(idx, 1);
        }
        saveConfig();
        updateConfigTable();
        updateSimulation();
        showToast(`Meter "${meterId}" deleted successfully`);
    }
};

function updateConfigTable() {
    const tbody = document.getElementById('config-summary-tbody');
    if (tbody) {
        let html = '';
        Object.entries(BUILDINGS).forEach(([key, b]) => {
            const mCount = ALL_METERS.filter(m => m.building === key || m.buildingName === b.name).length;
            html += `<tr>
                <td><strong>${b.name}</strong></td>
                <td>${b.floors.join(', ')}</td>
                <td>${mCount}</td>
                <td>${b.gridSupply} kW</td>
                <td>
                    <button type="button" class="action-btn red-btn" style="padding:0.25rem 0.6rem; font-size:0.75rem;" onclick="deleteBuilding('${key}')">
                        <i class="fa-solid fa-trash"></i> Delete
                    </button>
                </td>
            </tr>`;
        });
        tbody.innerHTML = html;
    }

    const metersTbody = document.getElementById('configured-meters-tbody');
    if (metersTbody) {
        let html = '';
        if (ALL_METERS.length === 0) {
            html = `<tr><td colspan="6" style="text-align:center; color:var(--text-muted);">No meters configured</td></tr>`;
        } else {
            ALL_METERS.forEach(m => {
                html += `<tr>
                    <td><strong>${m.id}</strong></td>
                    <td>${m.name}</td>
                    <td>${m.buildingName || m.building}</td>
                    <td>${m.floor}</td>
                    <td>${m.panel}</td>
                    <td>
                        <button type="button" class="action-btn red-btn" style="padding:0.25rem 0.6rem; font-size:0.75rem;" onclick="deleteMeter('${m.id}')">
                            <i class="fa-solid fa-trash"></i> Delete
                        </button>
                    </td>
                </tr>`;
            });
        }
        metersTbody.innerHTML = html;
    }
}

function matchFloor(mFloor, filterFloor) {
    if (filterFloor === 'ALL') return true;
    if (!mFloor) return false;
    const normM = mFloor.toString().trim().toLowerCase().replace(/[^a-z0-9]/g, '');
    const normF = filterFloor.toString().trim().toLowerCase().replace(/[^a-z0-9]/g, '');
    return normM === normF || normM.includes(normF) || normF.includes(normM);
}

function matchBuilding(mBldgKey, mBldgName, filterBldgKey) {
    if (filterBldgKey === 'ALL') return true;
    if (!mBldgKey && !mBldgName) return false;
    const fStr = filterBldgKey.toString().trim().toLowerCase().replace(/[^a-z0-9]/g, '');
    const mKeyStr = (mBldgKey || '').toString().trim().toLowerCase().replace(/[^a-z0-9]/g, '');
    const mNameStr = (mBldgName || '').toString().trim().toLowerCase().replace(/[^a-z0-9]/g, '');
    const bObjNameStr = (BUILDINGS[filterBldgKey] ? BUILDINGS[filterBldgKey].name : '').toLowerCase().replace(/[^a-z0-9]/g, '');

    return fStr === mKeyStr || fStr === mNameStr || (bObjNameStr && (mKeyStr === bObjNameStr || mNameStr === bObjNameStr));
}

function getFilteredMeters() {
    const bSel = document.getElementById('live-filter-bldg')?.value || 'ALL';
    const fSel = document.getElementById('live-filter-floor')?.value || 'ALL';
    const mSel = document.getElementById('live-filter-meter')?.value || 'ALL';

    return ALL_METERS.filter(m => {
        const bMatch = matchBuilding(m.building, m.buildingName, bSel);
        const fMatch = matchFloor(m.floor, fSel);
        const mMatch = (mSel === 'ALL' || m.id === mSel || m.name === mSel);
        return bMatch && fMatch && mMatch;
    });
}

function updateLiveFloors() {
    const liveBldg = document.getElementById('live-filter-bldg');
    const liveFloor = document.getElementById('live-filter-floor');
    if (!liveBldg || !liveFloor) return;

    const bKey = liveBldg.value;
    const prevFloor = liveFloor.value || 'ALL';
    liveFloor.innerHTML = '<option value="ALL">All Floors</option>';
    if (bKey === 'ALL') {
        const allFloorsSet = new Set();
        Object.values(BUILDINGS).forEach(b => b.floors.forEach(f => allFloorsSet.add(f)));
        allFloorsSet.forEach(f => {
            liveFloor.innerHTML += `<option value="${f}">${f}</option>`;
        });
    } else if (BUILDINGS[bKey]) {
        BUILDINGS[bKey].floors.forEach(f => {
            liveFloor.innerHTML += `<option value="${f}">${f}</option>`;
        });
    }
    if (Array.from(liveFloor.options).some(o => o.value === prevFloor)) {
        liveFloor.value = prevFloor;
    } else {
        liveFloor.value = 'ALL';
    }
    updateLiveMeters();
}

function updateLiveMeters() {
    const liveBldg = document.getElementById('live-filter-bldg');
    const liveFloor = document.getElementById('live-filter-floor');
    const liveMeter = document.getElementById('live-filter-meter');
    if (!liveBldg || !liveFloor || !liveMeter) return;

    const bKey = liveBldg.value;
    const fKey = liveFloor.value;
    const prevMeter = liveMeter.value || 'ALL';

    liveMeter.innerHTML = '<option value="ALL">All Meters</option>';
    const matchingMeters = ALL_METERS.filter(m => {
        const bMatch = matchBuilding(m.building, m.buildingName, bKey);
        const fMatch = matchFloor(m.floor, fKey);
        return bMatch && fMatch;
    });

    matchingMeters.forEach(m => {
        liveMeter.innerHTML += `<option value="${m.id}">${m.id} (${m.buildingName || m.building})</option>`;
    });

    if (Array.from(liveMeter.options).some(o => o.value === prevMeter)) {
        liveMeter.value = prevMeter;
    } else {
        liveMeter.value = 'ALL';
    }
}

function populateLiveFilters() {
    const liveBldg = document.getElementById('live-filter-bldg');
    if (!liveBldg) return;

    const currentBldg = liveBldg.value || 'ALL';

    liveBldg.innerHTML = '<option value="ALL">All Buildings</option>';
    Object.entries(BUILDINGS).forEach(([key, b]) => {
        liveBldg.innerHTML += `<option value="${key}">${b.name}</option>`;
    });
    if (Array.from(liveBldg.options).some(o => o.value === currentBldg)) {
        liveBldg.value = currentBldg;
    } else {
        liveBldg.value = 'ALL';
    }

    updateLiveFloors();
}

function populateReportFilters() {
    const reportBldg = document.getElementById('report-building-select');
    if (!reportBldg) return;

    const currentBldg = reportBldg.value || 'ALL';

    reportBldg.innerHTML = '<option value="ALL">All Buildings</option>';
    Object.entries(BUILDINGS).forEach(([key, b]) => {
        reportBldg.innerHTML += `<option value="${key}">${b.name}</option>`;
    });
    if (Array.from(reportBldg.options).some(o => o.value === currentBldg)) {
        reportBldg.value = currentBldg;
    } else {
        reportBldg.value = 'ALL';
    }

    updateReportFloors();
}

function updateReportFloors() {
    const reportBldg = document.getElementById('report-building-select');
    const reportFloor = document.getElementById('report-floor-select');
    if (!reportBldg || !reportFloor) return;

    const bKey = reportBldg.value;
    const prevFloor = reportFloor.value || 'ALL';
    reportFloor.innerHTML = '<option value="ALL">All Floors</option>';
    
    if (bKey === 'ALL') {
        const allFloorsSet = new Set();
        Object.values(BUILDINGS).forEach(b => b.floors.forEach(f => allFloorsSet.add(f)));
        allFloorsSet.forEach(f => {
            reportFloor.innerHTML += `<option value="${f}">${f}</option>`;
        });
    } else if (BUILDINGS[bKey]) {
        BUILDINGS[bKey].floors.forEach(f => {
            reportFloor.innerHTML += `<option value="${f}">${f}</option>`;
        });
    }
    
    if (Array.from(reportFloor.options).some(o => o.value === prevFloor)) {
        reportFloor.value = prevFloor;
    } else {
        reportFloor.value = 'ALL';
    }
    updateReportMeters();
}

function updateReportMeters() {
    const reportBldg = document.getElementById('report-building-select');
    const reportFloor = document.getElementById('report-floor-select');
    const reportMeter = document.getElementById('report-meter-select');
    if (!reportBldg || !reportFloor || !reportMeter) return;

    const bKey = reportBldg.value;
    const fKey = reportFloor.value;
    const prevMeter = reportMeter.value || 'ALL';

    reportMeter.innerHTML = '<option value="ALL">All Meters</option>';
    const matchingMeters = ALL_METERS.filter(m => {
        const bMatch = matchBuilding(m.building, m.buildingName, bKey);
        const fMatch = matchFloor(m.floor, fKey);
        return bMatch && fMatch;
    });

    matchingMeters.forEach(m => {
        reportMeter.innerHTML += `<option value="${m.id}">${m.id} (${m.buildingName || m.building})</option>`;
    });

    if (Array.from(reportMeter.options).some(o => o.value === prevMeter)) {
        reportMeter.value = prevMeter;
    } else {
        reportMeter.value = 'ALL';
    }
}

function saveConfig() {
    const configData = {
        buildings: BUILDINGS,
        meters: ALL_METERS,
        floorThresholds: floorThresholds
    };
    try {
        localStorage.setItem('energy_monitor_config', JSON.stringify(configData));
    } catch (e) {}

    fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(configData)
    }).catch(err => console.log('Config API sync note:', err.message));
}

function loadConfig() {
    try {
        const local = localStorage.getItem('energy_monitor_config');
        if (local) {
            const parsed = JSON.parse(local);
            if (parsed.buildings && typeof parsed.buildings === 'object') {
                Object.keys(BUILDINGS).forEach(k => delete BUILDINGS[k]);
                Object.assign(BUILDINGS, parsed.buildings);
            }
            if (parsed.meters && Array.isArray(parsed.meters)) {
                ALL_METERS.length = 0;
                parsed.meters.forEach(m => ALL_METERS.push(m));
            }
            if (parsed.floorThresholds) {
                floorThresholds = parsed.floorThresholds;
            }
        }
    } catch (e) {}

    fetch('/api/config')
        .then(res => res.json())
        .then(data => {
            if (data && (data.buildings || data.meters || data.floorThresholds)) {
                if (data.buildings && typeof data.buildings === 'object') {
                    Object.keys(BUILDINGS).forEach(k => delete BUILDINGS[k]);
                    Object.assign(BUILDINGS, data.buildings);
                }
                if (data.meters && Array.isArray(data.meters)) {
                    ALL_METERS.length = 0;
                    data.meters.forEach(m => ALL_METERS.push(m));
                }
                if (data.floorThresholds) {
                    floorThresholds = data.floorThresholds;
                }
                try {
                    localStorage.setItem('energy_monitor_config', JSON.stringify({ buildings: BUILDINGS, meters: ALL_METERS, floorThresholds: floorThresholds }));
                } catch (e) {}
                populateLiveFilters();
                populateSettingsDropdowns();
                updateConfigTable();
                updateSimulation();
            }
        })
        .catch(err => console.log('Backend config fetch note:', err.message));
}

function initFilters() {
    // Handle unit toggle
    const ut = document.getElementById('unit-toggle');
    if (ut) {
        ut.addEventListener('change', (e) => {
            powerUnit = e.target.checked ? 'W' : 'kW';
            document.querySelectorAll('[data-unit-toggle]').forEach(toggle => { toggle.checked = e.target.checked; });
            // update all unit labels
            document.querySelectorAll('.unit-label').forEach(el => el.textContent = powerUnit);
            updateSimulation(); // force refresh
            renderLiveUsageTable();
            overviewUsageView?.render();
            usageReportsView?.render();
            populateSettingsDropdowns(); // update alarm power threshold unit
        });
    }

    // Populate Ranking building select
    const rankBldg = document.getElementById('ranking-building-select');
    if (rankBldg) {
        rankBldg.innerHTML = '<option value="ALL">All Buildings</option>';
        Object.entries(BUILDINGS).forEach(([key, b]) => {
            rankBldg.innerHTML += `<option value="${key}">${b.name}</option>`;
        });
        rankBldg.addEventListener('change', updateRankingTable);
    }

    // Alerts View Filters
    const alertsBldg = document.getElementById('alerts-filter-building');
    const alertsFloor = document.getElementById('alerts-filter-floor');

    if (alertsBldg && alertsFloor) {
        Object.entries(BUILDINGS).forEach(([key, b]) => {
            alertsBldg.innerHTML += `<option value="${key}">${b.name}</option>`;
        });

        alertsBldg.addEventListener('change', () => {
            const bKey = alertsBldg.value;
            alertsFloor.innerHTML = '<option value="ALL">All Floors</option>';
            if (BUILDINGS[bKey]) {
                BUILDINGS[bKey].floors.forEach(f => {
                    alertsFloor.innerHTML += `<option value="${f}">${f}</option>`;
                });
            }
            updateAlertsToggleState();
            populateAlerts();
        });

        alertsFloor.addEventListener('change', () => {
            updateAlertsToggleState();
            populateAlerts();
        });

        const toggleSwitch = document.getElementById('alerts-toggle-switch');
        if (toggleSwitch) toggleSwitch.addEventListener('change', onAlertsToggleChange);
    }

    // Live Data Filters
    const liveBldg = document.getElementById('live-filter-bldg');
    const liveFloor = document.getElementById('live-filter-floor');
    const liveMeter = document.getElementById('live-filter-meter');
    if (liveBldg && liveFloor && liveMeter) {
        liveBldg.addEventListener('change', () => {
            updateLiveFloors();
            updateSimulation();
        });
        liveFloor.addEventListener('change', () => {
            updateLiveMeters();
            updateSimulation();
        });
        liveMeter.addEventListener('change', () => {
            updateSimulation();
        });
    }

    // Report Filters
    const reportBldg = document.getElementById('report-building-select');
    const reportFloor = document.getElementById('report-floor-select');
    const reportMeter = document.getElementById('report-meter-select');
    if (reportBldg && reportFloor && reportMeter) {
        reportBldg.addEventListener('change', () => {
            updateReportFloors();
        });
        reportFloor.addEventListener('change', () => {
            updateReportMeters();
        });
    }
}

// =============================================
// CHARTS
// =============================================
let forecastChart = null, floorChart = null, panelChart = null, trendChart = null, usageEstimateChart = null, activeAppliancesAllChart = null, activeAppliancesBldgChart = null, liveUsageChart = null;

function destroyCharts() {
    overviewUsageView?.destroyChart();
    [forecastChart, floorChart, panelChart, trendChart, usageEstimateChart, activeAppliancesAllChart, activeAppliancesBldgChart, liveUsageChart].forEach(chart => chart?.destroy());
    forecastChart = floorChart = panelChart = trendChart = usageEstimateChart = activeAppliancesAllChart = activeAppliancesBldgChart = liveUsageChart = null;
}

function initCharts() {
    if (typeof Chart === 'undefined') {
        console.warn('Chart.js is unavailable; live telemetry will continue without charts.');
        return;
    }
    destroyCharts();
    Chart.defaults.color = '#64748b';
    Chart.defaults.font.family = "'Roboto Mono', monospace";


    const ctxT = document.getElementById('trendChart');
    if (ctxT) {
        const labels = [];
        const data = [];
        for (let i = 29; i >= 0; i--) {
            const d = new Date(); d.setDate(d.getDate() - i);
            labels.push(d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }));
            data.push(0);
        }
        trendChart = new Chart(ctxT, {
            type: 'bar',
            data: { labels, datasets: [{ label: 'Energy (kWh)', data, backgroundColor: 'rgba(14,165,233,0.6)', borderRadius: 4 }] },
            options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, grid: { color: '#e2e8f0' } }, x: { grid: { display: false } } } }
        });
    }

    const chartOpts = { indexAxis: 'y', responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true, grid: { color: '#e2e8f0' } }, y: { grid: { display: false } } } };

    const ctxA1 = document.getElementById('activeAppliancesAllChart');
    if (ctxA1) {
        activeAppliancesAllChart = new Chart(ctxA1, {
            type: 'bar',
            data: { labels: [], datasets: [{ label: 'Power', data: [], backgroundColor: '#8b5cf6', borderRadius: 4 }] },
            options: chartOpts
        });
    }

    const ctxA2 = document.getElementById('activeAppliancesBldgChart');
    if (ctxA2) {
        activeAppliancesBldgChart = new Chart(ctxA2, {
            type: 'bar',
            data: { labels: [], datasets: [{ label: 'Power', data: [], backgroundColor: '#ec4899', borderRadius: 4 }] },
            options: chartOpts
        });
    }
}

// =============================================
// SIMULATION
// =============================================
let latestTelemetry = null;
const liveTelemetryByMeter = new Map();
let liveUsageData = null;
let liveUsageKey = '';
let liveUsageLastFetched = 0;
let liveUsageRequest = null;
let liveUsagePage = 0;
let liveUsagePeriod = 'day';
let liveUsageFollowToday = true;
let liveUsageDrillHistory = [];
let liveDetailSlide = 0;

let liveTelemetryRequest = null;

async function fetchLiveTelemetry() {
    if (liveTelemetryRequest) return liveTelemetryRequest;
    const pending = (async () => {
        try {
            const response = await fetch('/api/telemetry?all=true', { cache: 'no-store' });
            if (!response.ok) throw new Error('Unable to load meter telemetry');
            const readings = await response.json();
            if (!Array.isArray(readings)) throw new Error('Expected per-meter telemetry');
            if (!currentUser) return;
            liveTelemetryByMeter.clear();
            for (const reading of readings) {
                if (reading.meterId) liveTelemetryByMeter.set(reading.meterId, calculateElectricalReadings(reading));
            }
            latestTelemetry = [...liveTelemetryByMeter.values()].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0] || null;
        } catch (error) { console.error('Failed to fetch live telemetry:', error.message); }
    })();
    liveTelemetryRequest = pending;
    try { await pending; } finally { if (liveTelemetryRequest === pending) liveTelemetryRequest = null; }
}

function updateSimulation() {
    let added = false;
    for (const [meterId, tel] of liveTelemetryByMeter) {
        let meter = ALL_METERS.find(item => item.id === meterId);
        if (!meter) {
            meter = { id: meterId, name: tel.meterName || meterId, building: '', buildingName: '-', floor: null, panel: null };
            ALL_METERS.push(meter);
            added = true;
        }
        meter.name = tel.meterName || meter.name || meterId;
        if (tel.building) {
            meter.buildingName = tel.building;
            const key = Object.keys(BUILDINGS).find(key => BUILDINGS[key].name === tel.building);
            meter.building = key || tel.building.toLowerCase().replace(/[^a-z0-9]/g, '');
        }
        if (tel.floor) meter.floor = tel.floor;
        if (tel.panel) meter.panel = tel.panel;
        const average = fields => {
            const values = fields.map(field => numericReading(tel[field])).filter(value => value !== null);
            return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
        };
        meter.v = average(['v_r', 'v_y', 'v_b']);
        meter.i = average(['i_r', 'i_y', 'i_b']);
        meter.p = numericReading(tel.total_power_kw);
        meter.pf = numericReading(tel.avg_power_factor);
        meter.energy_active = numericReading(tel.energy_active);
        meter.on_hours = numericReading(tel.on_hours);
        meter.modbus = tel;
        meter.status = isTelemetryLive(tel) ? 'ONLINE' : 'OFFLINE';
    }
    if (added) {
        populateOverviewMeterDropdown();
        populateLiveFilters();
        populateReportFilters();
    }
    const filtered = getFilteredMeters();

    ALL_METERS.forEach(m => {
        const limits = floorThresholds[`${m.building}_${m.floor}`] || { v: 240, p: 5 };

        let alarmsEnabledForMeter = alarmsMasterEnabled
            && !disabledBuildings.has(m.building)
            && !disabledFloors.has(`${m.building}_${m.floor}`)
            && !disabledMeters.has(m.name);

        if (alarmsEnabledForMeter) {
            const numericV = typeof m.v === 'number' ? m.v : parseFloat(m.v) || 0;
            const numericP = typeof m.p === 'number' ? m.p : parseFloat(m.p) || 0;
            if (numericV > limits.v) {
                addDynamicAlert('Critical', m, `High Voltage Alarm (${numericV.toFixed(1)}V > ${limits.v}V)`);
            }
            if (numericP > limits.p) {
                addDynamicAlert('Warning', m, `High Power Alarm (${numericP.toFixed(2)}kW > ${limits.p}kW)`);
            }
        }
    });

    updateDOM();
    overviewUsageView?.refresh();
    updateLiveTable(filtered);
    // If detail view is open, refresh the cards too
    if (window._liveSelectedMeterId && document.getElementById('live-sub-detail')?.style.display !== 'none') {
        renderLiveMeterDetailCards();
        fetchLiveMeterUsage();
    }
    updateRankingTable();
    populateAlerts();
}

function updateDOM() {
    const timeEl = document.getElementById('live-time');
    if (timeEl) timeEl.innerText = new Date().toLocaleTimeString('en-US', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
    overviewUsageView?.render();
}

function updateLiveTable(filtered) {
    // Render meter selection button grid
    renderLiveMeterButtons(filtered);
}

function renderLiveMeterButtons(filtered) {
    const container = document.getElementById('live-meter-buttons');
    if (!container) return;

    const bldgVal = document.getElementById('live-filter-bldg')?.value || 'ALL';
    const floorVal = document.getElementById('live-filter-floor')?.value || 'ALL';

    const metersToShow = filtered.filter(m => {
        if (bldgVal !== 'ALL' && m.building !== bldgVal) return false;
        if (floorVal !== 'ALL' && m.floor !== floorVal) return false;
        return true;
    });

    if (metersToShow.length === 0) {
        container.innerHTML = `<div style="grid-column:1/-1; text-align:center; padding:3rem; color:#94a3b8;">
            <i class="fa-solid fa-meter" style="font-size:2rem; margin-bottom:0.75rem; display:block;"></i>
            No meters found. Please check your Building / Floor filter or add meters in Settings.
        </div>`;
        return;
    }

    container.innerHTML = metersToShow.map(m => {
        const isLive = isTelemetryLive(liveTelemetryByMeter.get(m.id));
        const statusColor = isLive ? '#22c55e' : '#94a3b8';
        const statusDot = `<span style="width:8px;height:8px;border-radius:50%;background:${statusColor};display:inline-block;margin-right:6px;"></span>`;
        const statusText = isLive ? 'LIVE' : 'OFFLINE';
        return `<button class="live-meter-btn" data-meter-id="${escapeHtml(m.id)}" style="
            background:#fff; border:1.5px solid #e2e8f0; border-radius:8px;
            padding:1.25rem 1rem; cursor:pointer; text-align:left;
            transition:box-shadow 0.15s, border-color 0.15s;
            box-shadow:0 1px 4px rgba(0,0,0,0.06);">
            <div style="font-weight:700; font-size:0.95rem; color:#1e293b; margin-bottom:0.5rem;">
                <i class="fa-solid fa-bolt" style="color:#f59e0b; margin-right:6px;"></i>${escapeHtml(m.name || m.id)}
            </div>
            <div style="font-size:0.78rem; color:#64748b; margin-bottom:0.35rem;">
                <i class="fa-solid fa-building" style="margin-right:4px;"></i>${escapeHtml(m.buildingName || m.building || '-')}
            </div>
            <div style="font-size:0.78rem; color:#64748b; margin-bottom:0.6rem;">
                <i class="fa-solid fa-layer-group" style="margin-right:4px;"></i>${escapeHtml(m.floor || '-')}
            </div>
            <div style="font-size:0.75rem; font-weight:600;">${statusDot}${statusText}</div>
        </button>`;
    }).join('');

    // Attach click listeners
    container.querySelectorAll('.live-meter-btn').forEach(btn => {
        btn.addEventListener('mouseenter', () => {
            btn.style.boxShadow = '0 4px 16px rgba(0,0,0,0.12)';
            btn.style.borderColor = '#94a3b8';
        });
        btn.addEventListener('mouseleave', () => {
            btn.style.boxShadow = '0 1px 4px rgba(0,0,0,0.06)';
            btn.style.borderColor = '#e2e8f0';
        });
        btn.addEventListener('click', () => {
            const meterId = btn.getAttribute('data-meter-id');
            openLiveMeterDetail(meterId, filtered);
        });
    });
}

function openLiveMeterDetail(meterId, filtered) {
    const meter = filtered.find(m => m.id === meterId);
    if (!meter) return;

    document.getElementById('live-sub-selection').style.display = 'none';
    document.getElementById('live-sub-detail').style.display = 'block';

    document.getElementById('live-detail-title').innerHTML =
        `<i class="fa-solid fa-bolt" style="color:#f59e0b;"></i> ${escapeHtml(meter.name || meterId)}`;

    const locEl = document.getElementById('live-detail-location');
    if (locEl) {
        locEl.innerHTML = [
            { icon: 'fa-building', label: 'Building', val: meter.buildingName || meter.building || '-' },
            { icon: 'fa-layer-group', label: 'Floor', val: meter.floor || '-' },
            { icon: 'fa-server', label: 'Panel', val: meter.panel || '-' },
            { icon: 'fa-id-badge', label: 'Meter ID', val: meter.id || '-' }
        ].map(tag => `
            <span style="background:#f1f5f9; border-radius:8px; padding:0.4rem 0.8rem; font-size:0.8rem; color:#334155;">
                <i class="fa-solid ${tag.icon}" style="margin-right:4px; color:#64748b;"></i>
                <strong>${tag.label}:</strong> ${escapeHtml(tag.val)}
            </span>`).join('');
    }

    // Store selected meter id for live refresh
    window._liveSelectedMeterId = meterId;
    liveUsageDrillHistory = [];
    liveDetailSlide = 0;
    renderLiveMeterDetailCards();
    fetchLiveMeterUsage(true);
    fetchLiveTelemetry().then(() => {
        if (window._liveSelectedMeterId === meterId) renderLiveMeterDetailCards();
    });
}

function liveUsageParams() {
    if (liveUsageFollowToday) document.getElementById('live-usage-date').value = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
    const params = new URLSearchParams({ meterId: window._liveSelectedMeterId, period: liveUsagePeriod });
    const dateId = liveUsagePeriod === 'day' ? 'live-usage-date' : liveUsagePeriod === 'month' ? 'live-usage-month' : 'live-usage-year';
    params.set('date', document.getElementById(dateId).value);
    params.set('granularity', document.getElementById('live-usage-granularity').value);
    if (liveUsagePeriod === 'day' && document.getElementById('live-time-range').checked) {
        params.set('fromTime', document.getElementById('live-usage-from').value);
        params.set('toTime', document.getElementById('live-usage-to').value);
    }
    return params;
}

async function fetchLiveMeterUsage(force = false) {
    if (!window._liveSelectedMeterId) return;
    const params = liveUsageParams();
    const key = params.toString();
    if (!force && key === liveUsageKey && (liveUsageRequest || Date.now() - liveUsageLastFetched < 15000)) return;
    liveUsageRequest?.abort();
    const request = new AbortController();
    liveUsageRequest = request;
    if (key !== liveUsageKey || force) {
        liveUsageData = null;
        liveUsagePage = 0;
        document.getElementById('live-usage-status').textContent = 'Loading usage...';
        renderLiveMeterDetailCards();
        renderLiveUsageTable();
    }
    liveUsageKey = key;
    liveUsageLastFetched = Date.now();
    try {
        const response = await fetch(`/api/meter-usage?${params}`, { cache: 'no-store', signal: request.signal });
        const data = response.headers.get('content-type')?.includes('application/json')
            ? await response.json() : { error: 'Unable to load usage. Check the backend connection.' };
        if (!response.ok || data.error) throw new Error(data.error || 'Unable to load usage');
        if (liveUsageRequest !== request) return;
        liveUsageData = data;
        const notes = [];
        if (!data.hasData) notes.push('No readings for this period.');
        else if (data.unrecordedSeconds >= 60) notes.push(`Unrecorded time: ${formatUsageDuration(data.unrecordedSeconds)}`);
        if (data.energyEstimated) notes.push('Energy breakdown includes gaps between readings.');
        if (data.counterReset) notes.push('Energy counter reset detected; the reset interval is excluded.');
        document.getElementById('live-usage-status').textContent = notes.join(' ');
        renderLiveMeterDetailCards();
        renderLiveUsageTable();
    } catch (error) {
        if (error.name !== 'AbortError' && liveUsageRequest === request) {
            liveUsageData = null;
            document.getElementById('live-usage-status').textContent = error.message;
            renderLiveMeterDetailCards();
            renderLiveUsageTable();
        }
    } finally {
        if (liveUsageRequest === request) liveUsageRequest = null;
    }
}

function formatUsageDuration(seconds) {
    if (seconds == null) return '-';
    const minutes = Math.floor(Math.max(0, seconds) / 60);
    return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

function liveUsagePeriodLabel() {
    if (!liveUsageData) return '';
    const { period, date } = liveUsageData;
    let label = period === 'year' ? date : new Date(`${date}${period === 'month' ? '-01' : ''}T00:00:00+05:30`).toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata', day: period === 'day' ? '2-digit' : undefined, month: 'short', year: 'numeric' });
    if (period === 'day' && document.getElementById('live-time-range').checked) label += ` | ${document.getElementById('live-usage-from').value || '00:00'} - ${document.getElementById('live-usage-to').value || '24:00'}`;
    return label;
}

function syncLiveUsageControls(granularity) {
    document.querySelectorAll('.live-period-buttons button').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.period === liveUsagePeriod)));
    ['date', 'month', 'year'].forEach((name, index) => {
        document.getElementById(`live-usage-${name}`).parentElement.hidden = liveUsagePeriod !== ['day', 'month', 'year'][index];
    });
    const daily = liveUsagePeriod === 'day';
    document.querySelector('.live-time-toggle').hidden = !daily;
    document.getElementById('live-time-inputs').hidden = !daily || !document.getElementById('live-time-range').checked;
    const select = document.getElementById('live-usage-granularity');
    select.innerHTML = daily ? '<option value="hour">Hourly</option><option value="minute">By Minute</option>'
        : liveUsagePeriod === 'month' ? '<option value="day">Daily</option>' : '<option value="month">Monthly</option>';
    if (granularity) select.value = granularity;
    document.getElementById('live-graph-back').hidden = liveUsageDrillHistory.length === 0;
}

function captureLiveUsageFilters() {
    return {
        period: liveUsagePeriod, followToday: liveUsageFollowToday,
        values: Object.fromEntries(['date', 'month', 'year', 'granularity', 'from', 'to'].map(name => [name, document.getElementById(`live-usage-${name}`).value])),
        timeRange: document.getElementById('live-time-range').checked
    };
}

function drillIntoLiveUsage(index) {
    if (!liveUsageData || liveUsageData.granularity === 'minute') return;
    const point = liveUsageGraphRows()[index];
    if (!point || !['runningSeconds', 'idleSeconds', 'energyConsumedKwh'].some(field => point[field] != null)) return;
    liveUsageDrillHistory.push(captureLiveUsageFilters());
    liveUsageFollowToday = false;
    document.getElementById('live-time-range').checked = false;
    let granularity;
    if (liveUsageData.granularity === 'month') {
        liveUsagePeriod = 'month';
        document.getElementById('live-usage-month').value = point.period;
        granularity = 'day';
    } else {
        liveUsagePeriod = 'day';
        document.getElementById('live-usage-date').value = point.period.slice(0, 10);
        granularity = liveUsageData.granularity === 'day' ? 'hour' : 'minute';
        if (granularity === 'minute') {
            document.getElementById('live-time-range').checked = true;
            const localTime = timestamp => new Date(timestamp + 330 * 60000).toISOString().slice(11, 16);
            document.getElementById('live-usage-from').value = localTime(point.start);
            const end = localTime(point.end);
            // An empty end time means the end of the selected day, not its beginning.
            document.getElementById('live-usage-to').value = end === '00:00' ? '' : end;
        }
    }
    syncLiveUsageControls(granularity);
    fetchLiveMeterUsage(true);
}

function backFromLiveUsageDrill() {
    const filters = liveUsageDrillHistory.pop();
    if (!filters) return;
    liveUsagePeriod = filters.period;
    liveUsageFollowToday = filters.followToday;
    document.getElementById('live-time-range').checked = filters.timeRange;
    syncLiveUsageControls(filters.values.granularity);
    Object.entries(filters.values).forEach(([name, value]) => { document.getElementById(`live-usage-${name}`).value = value; });
    fetchLiveMeterUsage(true);
}

function renderLiveUsageTable() {
    const body = document.getElementById('live-usage-rows');
    if (!body) return;
    document.getElementById('live-usage-energy-unit').textContent = getEnergyUnitLabel();
    document.getElementById('live-usage-period-label').textContent = liveUsagePeriodLabel();
    const rows = liveUsageData?.rows || [];
    const pageCount = Math.ceil(rows.length / 60);
    liveUsagePage = Math.max(0, Math.min(liveUsagePage, pageCount - 1));
    body.innerHTML = rows.length ? rows.slice(liveUsagePage * 60, (liveUsagePage + 1) * 60).map(row => {
        const label = row.period.includes('T') ? `${row.period.split('T')[1]}${liveUsageData.granularity === 'hour' ? ':00' : ''}` : row.period;
        return `<tr><td>${label}</td><td>${formatUsageDuration(row.runningSeconds)}</td><td>${formatUsageDuration(row.idleSeconds)}</td><td>${row.energyConsumedKwh == null ? '-' : convertPower(row.energyConsumedKwh).toFixed(4)}</td></tr>`;
    }).join('') : '<tr><td colspan="4" style="text-align:center;">No usage data</td></tr>';
    document.getElementById('live-usage-pagination').hidden = pageCount <= 1;
    document.getElementById('live-usage-page').textContent = `${liveUsagePage + 1} / ${pageCount}`;
    document.getElementById('live-usage-prev').disabled = liveUsagePage === 0;
    document.getElementById('live-usage-next').disabled = liveUsagePage >= pageCount - 1;
    renderLiveUsageGraph();
}

function liveUsageGraphRows() {
    return usageChartPoints(liveUsageData);
}

function renderLiveUsageGraph() {
    const canvas = document.getElementById('live-usage-chart');
    if (!canvas || !window._liveSelectedMeterId) return;
    document.getElementById('live-graph-energy-unit').textContent = getEnergyUnitLabel();
    document.getElementById('live-graph-period-label').textContent = liveUsagePeriodLabel();
    document.getElementById('live-graph-back').hidden = liveUsageDrillHistory.length === 0;
    document.getElementById('live-timeline-note').hidden = !liveUsageData?.timeline?.incomplete;
    liveUsageChart = renderStatusGraph({
        chart: liveUsageChart, canvas, empty: document.getElementById('live-graph-empty'),
        data: liveUsageData, points: liveUsageGraphRows(), unit: getEnergyUnitLabel(), convertEnergy: convertPower,
        lanes: [{ name: window._liveSelectedMeterId, segments: liveUsageData?.timeline?.segments || [] }],
        showRunning: document.getElementById('live-graph-running').checked,
        showIdle: document.getElementById('live-graph-idle').checked,
        showEnergy: document.getElementById('live-graph-energy').checked,
        loading: Boolean(liveUsageRequest), caption: liveUsagePeriodLabel(), drill: drillIntoLiveUsage
    });
}

function setLiveDetailSlide(index) {
    liveDetailSlide = Math.max(0, Math.min(2, index));
    document.querySelectorAll('.live-detail-slide').forEach((slide, i) => {
        slide.hidden = i !== liveDetailSlide;
    });
    document.querySelectorAll('.live-carousel-dot').forEach((dot, i) => {
        dot.setAttribute('aria-pressed', String(i === liveDetailSlide));
    });
}

function renderLiveMeterDetailCards() {
    const container = document.getElementById('live-detail-cards');
    if (!container) return;

    const meterId = window._liveSelectedMeterId;
    const meter = ALL_METERS.find(item => item.id === meterId) || {};
    const latestMeterId = latestTelemetry?.meterId || latestTelemetry?.meter_id
        || latestTelemetry?.modbus?.meterId || latestTelemetry?.modbus?.meter_id;
    const t = calculateElectricalReadings((!simulationInterval && meter.modbus ? meter.modbus : liveTelemetryByMeter.get(meterId))
        || (latestMeterId === meterId ? { ...latestTelemetry, ...latestTelemetry?.modbus } : meter.modbus || meter));
    const badge = document.getElementById('live-detail-status-badge');
    if (badge) {
        const isLive = isTelemetryLive(t);
        badge.textContent = isLive ? 'LIVE' : 'OFFLINE';
        badge.style.background = isLive ? '#dcfce7' : '#f1f5f9';
        badge.style.color = isLive ? '#16a34a' : '#64748b';
    }
    const fv = (val, dec = 2) => {
        if (val === null || val === undefined || val === '') return '-';
        const n = Number(val);
        return Number.isFinite(n) ? n.toFixed(dec) : '-';
    };

    const avgVln = (t.v_r != null && t.v_y != null && t.v_b != null)
        ? fv((Number(t.v_r) + Number(t.v_y) + Number(t.v_b)) / 3) : '-';
    const avgVll = (t.v_ry != null && t.v_yb != null && t.v_br != null)
        ? fv((Number(t.v_ry) + Number(t.v_yb) + Number(t.v_br)) / 3) : '-';
    const sum = fields => fields.every(field => t[field] != null && t[field] !== '')
        ? fields.reduce((total, field) => total + Number(t[field]), 0) : null;
    const average = fields => {
        const total = sum(fields);
        return total === null ? null : total / fields.length;
    };
    const avgI = fv(average(['i_r', 'i_y', 'i_b']));
    const powerValue = value => value == null ? '-' : fv(convertPower(Number(value)));
    const totKW = powerValue(t.total_power_kw ?? sum(['power_r', 'power_y', 'power_b']));
    const totKVA = powerValue(t.total_apparent_kva ?? sum(['apparent_r', 'apparent_y', 'apparent_b']));
    const avgPF = t.avg_power_factor != null ? fv(t.avg_power_factor)
        : fv(average(['pf_r', 'pf_y', 'pf_b']));

    const sections = [
        {
            title: 'Voltage - Phase to Neutral (L-N)', icon: 'fa-wave-square', color: '#3b82f6',
            rows: [
                ['R Phase (V_R)', fv(t.v_r)],
                ['Y Phase (V_Y)', fv(t.v_y)],
                ['B Phase (V_B)', fv(t.v_b)],
                ['Average L-N', avgVln, true]
            ]
        },
        {
            title: 'Voltage - Line to Line (L-L)', icon: 'fa-bolt', color: '#8b5cf6',
            rows: [
                ['RY (V_RY)', fv(t.v_ry)],
                ['YB (V_YB)', fv(t.v_yb)],
                ['BR (V_BR)', fv(t.v_br)],
                ['Average L-L', avgVll, true]
            ]
        },
        {
            title: 'Current (A)', icon: 'fa-plug', color: '#f59e0b',
            rows: [
                ['R Phase (I_R)', fv(t.i_r)],
                ['Y Phase (I_Y)', fv(t.i_y)],
                ['B Phase (I_B)', fv(t.i_b)],
                ['Average', avgI, true]
            ]
        },
        {
            title: `Active Power (${getUnitLabel()})`, icon: 'fa-fire-flame-curved', color: '#ef4444',
            rows: [
                ['R Phase', powerValue(t.power_r)],
                ['Y Phase', powerValue(t.power_y)],
                ['B Phase', powerValue(t.power_b)],
                ['Total Active Power', totKW, true]
            ]
        },
        {
            title: `Apparent Power (${powerUnit === 'W' ? 'VA' : 'kVA'})`, icon: 'fa-circle-half-stroke', color: '#06b6d4',
            rows: [
                ['R Phase', powerValue(t.apparent_r)],
                ['Y Phase', powerValue(t.apparent_y)],
                ['B Phase', powerValue(t.apparent_b)],
                ['Total Apparent', totKVA, true]
            ]
        },
        {
            title: 'Power Factor', icon: 'fa-gauge-high', color: '#22c55e',
            rows: [
                ['PF - R Phase', fv(t.pf_r, 3)],
                ['PF - Y Phase', fv(t.pf_y, 3)],
                ['PF - B Phase', fv(t.pf_b, 3)],
                ['Average PF', avgPF, true]
            ]
        },
        {
            title: 'Other Parameters', icon: 'fa-sliders', color: '#64748b',
            rows: [
                ['Frequency (Hz)', fv(t.frequency)],
                [`Reactive Energy (${powerUnit === 'W' ? 'VArh' : 'kVArh'})`, powerValue(t.energy_reactive)]
            ]
        }
    ];

    const renderSection = sec => `
        <div class="live-parameter-card" style="background:#fff; border-radius:8px; border:1.5px solid #e2e8f0;
            box-shadow:0 1px 4px rgba(0,0,0,0.06); overflow:hidden;">
            <div style="background:${sec.color}15; border-bottom:1px solid #e2e8f0;
                padding:0.75rem 1rem; display:flex; align-items:center; gap:0.5rem;">
                <i class="fa-solid ${sec.icon}" style="color:${sec.color};"></i>
                <span style="font-weight:700; font-size:0.85rem; color:#1e293b;">${sec.title}</span>
            </div>
            <div style="padding:0.5rem 0;">
                ${sec.rows.map(([label, val, bold]) => `
                <div class="live-parameter-row" style="display:flex; justify-content:space-between; align-items:center;
                    padding:0.5rem 1rem; border-bottom:1px solid #f1f5f9;">
                    <span style="font-size:0.82rem; color:#64748b;">${label}</span>
                    <span style="font-size:${bold ? '1rem' : '0.88rem'}; font-weight:${bold ? '700' : '500'};
                        color:${bold ? sec.color : '#1e293b'};">${val}</span>
                </div>`).join('')}
            </div>
        </div>`;
    const usage = liveUsageData?.hasData ? liveUsageData : null;
    const energyUnit = getEnergyUnitLabel();
    const opening = liveUsageData?.openingEnergy;
    const closing = liveUsageData?.closingEnergy;
    const summary = [
        { title: 'Running Hours', icon: 'fa-clock', color: '#16a34a', value: formatUsageDuration(usage?.runningSeconds), unit: '', period: liveUsagePeriodLabel() },
        { title: 'Idle Hours', icon: 'fa-hourglass-half', color: '#d97706', value: formatUsageDuration(usage?.idleSeconds), unit: '', period: liveUsagePeriodLabel() },
        { title: 'Total Energy Consumed', icon: 'fa-bolt', color: '#2563eb', value: usage?.energyConsumedKwh == null ? '-' : fv(convertPower(usage.energyConsumedKwh), 4), unit: energyUnit,
          period: opening != null && closing != null ? `Opening: ${fv(convertPower(opening), 3)} | Latest: ${fv(convertPower(closing), 3)} ${energyUnit}` : liveUsagePeriodLabel() }
    ];
    const pageNames = ['Energy and hours', 'Voltage and current', 'Power and other parameters'];
    const pages = [
        summary.map(item => `<div class="live-summary-card" style="--metric-color:${item.color};">
            <div class="live-summary-label"><i class="fa-solid ${item.icon}" aria-hidden="true"></i><span>${item.title}</span></div>
            <div class="live-summary-value">${item.value}<span>${item.unit}</span></div>
            <div class="live-summary-period">${item.period || ''}</div>
        </div>`).join(''),
        sections.slice(0, 3).map(renderSection).join(''),
        sections.slice(3).map(renderSection).join('')
    ];
    container.innerHTML = pages.map((content, index) => `<div id="live-detail-slide-${index}" class="live-detail-slide ${index === 0 ? 'live-summary-slide' : ''}"
        role="group" aria-roledescription="slide" aria-label="${index + 1} of 3: ${pageNames[index]}">${content}</div>`).join('');
    setLiveDetailSlide(liveDetailSlide);
}

// Back button wiring (called once)
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('live-graph-back').addEventListener('click', backFromLiveUsageDrill);
    ['live-graph-running', 'live-graph-idle', 'live-graph-energy'].forEach(id => document.getElementById(id).addEventListener('change', renderLiveUsageGraph));
    const today = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
    document.getElementById('live-usage-date').value = today;
    document.getElementById('live-usage-month').value = today.slice(0, 7);
    document.getElementById('live-usage-year').value = today.slice(0, 4);
    document.querySelectorAll('.live-period-buttons button').forEach(button => button.addEventListener('click', () => {
        liveUsagePeriod = button.dataset.period;
        liveUsageDrillHistory = [];
        syncLiveUsageControls();
        fetchLiveMeterUsage(true);
    }));
    ['live-usage-date', 'live-usage-month', 'live-usage-year', 'live-usage-granularity', 'live-usage-from', 'live-usage-to', 'live-time-range'].forEach(id => {
        document.getElementById(id).addEventListener('change', () => {
            liveUsageDrillHistory = [];
            document.getElementById('live-graph-back').hidden = true;
            if (id === 'live-usage-date') liveUsageFollowToday = document.getElementById(id).value === new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
            document.getElementById('live-time-inputs').hidden = liveUsagePeriod !== 'day' || !document.getElementById('live-time-range').checked;
            fetchLiveMeterUsage(true);
        });
    });
    document.querySelectorAll('[data-unit-toggle]').forEach(control => control.addEventListener('change', event => {
        const toggle = document.getElementById('unit-toggle');
        toggle.checked = event.target.checked;
        toggle.dispatchEvent(new Event('change'));
    }));
    [['live-usage-prev', -1], ['live-usage-next', 1]].forEach(([id, direction]) => document.getElementById(id).addEventListener('click', () => {
        liveUsagePage += direction;
        renderLiveUsageTable();
    }));
    document.querySelectorAll('.live-carousel-dot').forEach(dot => {
        dot.addEventListener('click', () => setLiveDetailSlide(Number(dot.dataset.slide)));
        dot.addEventListener('keydown', event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const index = event.key === 'Home' ? 0 : event.key === 'End' ? 2
                : (liveDetailSlide + (event.key === 'ArrowRight' ? 1 : 2)) % 3;
            setLiveDetailSlide(index);
            document.querySelector(`.live-carousel-dot[data-slide="${index}"]`)?.focus();
        });
    });
    document.getElementById('live-back-btn')?.addEventListener('click', () => {
        document.getElementById('live-sub-detail').style.display = 'none';
        document.getElementById('live-sub-selection').style.display = 'block';
        window._liveSelectedMeterId = null;
        liveUsageDrillHistory = [];
        liveUsageRequest?.abort();
    });
});

function updateRankingTable() {
    usageReportsView?.tick();
}

function populateHistoryTable() {
    const tbody = document.getElementById('history-tbody');
    if (!tbody) return;
    let html = '';
    historyData.slice(-60).forEach(r => {
        html += `<tr><td>${r.date}</td><td>${r.building}</td><td>${r.floor}</td><td>${r.energy}</td><td>${r.peak}</td><td>${r.pf}</td></tr>`;
    });
    tbody.innerHTML = html;
}

let alarmsMasterEnabled = true;
const disabledBuildings = new Set();
const disabledFloors = new Set();
const disabledMeters = new Set();

function updateAlertsToggleState() {
    const b = document.getElementById('alerts-filter-building')?.value || 'ALL';
    const f = document.getElementById('alerts-filter-floor')?.value || 'ALL';
    const toggle = document.getElementById('alerts-toggle-switch');
    const txt = document.getElementById('alerts-status-text');
    if (!toggle || !txt) return;

    let isEnabled = true;
    if (b === 'ALL') {
        isEnabled = alarmsMasterEnabled;
    } else if (f === 'ALL') {
        isEnabled = !disabledBuildings.has(b);
    } else {
        isEnabled = !disabledFloors.has(`${b}_${f}`);
    }

    toggle.checked = isEnabled;
    txt.textContent = isEnabled ? 'ENABLED' : 'DISABLED';
    txt.style.color = isEnabled ? 'var(--accent-green)' : 'var(--text-muted)';
}

function onAlertsToggleChange(e) {
    const b = document.getElementById('alerts-filter-building').value;
    const f = document.getElementById('alerts-filter-floor').value;
    const isEnabled = e.target.checked;

    if (b === 'ALL') {
        alarmsMasterEnabled = isEnabled;
    } else if (f === 'ALL') {
        if (isEnabled) disabledBuildings.delete(b);
        else disabledBuildings.add(b);
    } else {
        const key = `${b}_${f}`;
        if (isEnabled) disabledFloors.delete(key);
        else disabledFloors.add(key);
    }
    updateAlertsToggleState();
}

window.toggleMeterAlarm = function(meterName, isEnabled) {
    if (isEnabled) {
        disabledMeters.delete(meterName);
    } else {
        disabledMeters.add(meterName);
    }
};

function addDynamicAlert(severity, meter, msg) {
    const now = new Date();
    const alertId = `${meter.id}-${msg}`;
    // prevent spamming same alert
    if (!dynamicAlerts.find(a => a.id === alertId && (now - a.timestamp < 30000))) {
        dynamicAlerts.unshift({
            id: alertId,
            time: now.toLocaleString(),
            timestamp: now,
            sev: severity,
            meter: meter.name,
            building: meter.building,
            floor: meter.floor,
            msg: msg
        });
        if (dynamicAlerts.length > 20) dynamicAlerts.pop();
    }
}

function populateAlerts() {
    const tbody = document.getElementById('alerts-tbody');
    if (!tbody) return;

    const bFilter = document.getElementById('alerts-filter-building')?.value || 'ALL';
    const fFilter = document.getElementById('alerts-filter-floor')?.value || 'ALL';

    let filteredAlerts = dynamicAlerts;
    if (bFilter !== 'ALL') filteredAlerts = filteredAlerts.filter(a => a.building === bFilter);
    if (fFilter !== 'ALL') filteredAlerts = filteredAlerts.filter(a => a.floor === fFilter);

    let html = '';
    filteredAlerts.forEach(a => {
        const cls = a.sev.toLowerCase() === 'critical' ? 'red' : (a.sev.toLowerCase() === 'warning' ? 'orange' : 'neutral');
        const isMeterEnabled = !disabledMeters.has(a.meter);
        html += `<tr>
            <td>${a.time}</td>
            <td>${a.meter}</td>
            <td>${a.msg}</td>
            <td><span class="severity-badge severity-${cls}">${a.sev}</span></td>
            <td>Active<br><span style="font-size:0.7rem;color:var(--text-muted)"></span></td>
            <td>
              <label class="switch" style="margin-bottom:0; transform: scale(0.8);">
                <input type="checkbox" onchange="toggleMeterAlarm('${a.meter}', this.checked)" ${isMeterEnabled ? 'checked' : ''}>
                <span class="slider round"></span>
              </label>
            </td>
        </tr>`;
    });
    tbody.innerHTML = html;
}

function initSimulation() {
    if (simulationInterval) clearInterval(simulationInterval);
    fetchLiveTelemetry().then(() => {
        if (simulationInterval) updateSimulation();
    });
    simulationInterval = setInterval(() => {
        fetchLiveTelemetry().then(() => {
            if (simulationInterval) updateSimulation();
        });
    }, 5000);
}

// =============================================
// SETTINGS - ADD BUILDING / FLOOR / METER
// =============================================
function showToast(msg, type = 'success') {
    const t = document.createElement('div');
    t.className = `toast ${type}`;
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3000);
}

function initSettings() {
    loadConfig();
    populateSettingsDropdowns();
    updateConfigTable();

    document.getElementById('btn-add-building')?.addEventListener('click', () => {
        const name = document.getElementById('settings-building-name').value.trim();
        const grid = parseInt(document.getElementById('settings-building-grid').value) || 500;
        if (!name) { showToast('Enter a building name', 'error'); return; }
        const key = name.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (BUILDINGS[key]) { showToast('Building already exists', 'error'); return; }
        BUILDINGS[key] = { name, floors: ['Ground'], meterCount: 0, gridSupply: grid };
        document.getElementById('settings-building-name').value = '';
        saveConfig();
        populateLiveFilters();
        populateSettingsDropdowns();
        updateConfigTable();
        updateSimulation();
        showToast(`Building "${name}" added`);
    });

    document.getElementById('btn-add-floor')?.addEventListener('click', () => {
        const bKey = document.getElementById('settings-floor-building').value;
        const floorName = document.getElementById('settings-floor-name').value.trim();
        if (!floorName) { showToast('Enter a floor name', 'error'); return; }
        if (!BUILDINGS[bKey]) { showToast('Select a building', 'error'); return; }
        if (BUILDINGS[bKey].floors.includes(floorName)) { showToast('Floor already exists', 'error'); return; }
        BUILDINGS[bKey].floors.push(floorName);
        document.getElementById('settings-floor-name').value = '';
        saveConfig();
        populateLiveFilters();
        populateSettingsDropdowns();
        updateConfigTable();
        updateSimulation();
        showToast(`Floor "${floorName}" added to ${BUILDINGS[bKey].name}`);
    });

    document.getElementById('btn-add-meter')?.addEventListener('click', () => {
        const bKey = document.getElementById('settings-meter-building').value;
        const floor = document.getElementById('settings-meter-floor').value;
        const meterId = document.getElementById('settings-meter-id').value.trim();
        const panel = document.getElementById('settings-meter-panel').value.trim();
        if (!meterId || !panel) { showToast('Fill in Meter ID and Panel', 'error'); return; }
        try { telemetryMeterId({ meterId }); }
        catch (error) { showToast(error.message, 'error'); return; }
        if (!BUILDINGS[bKey] || !floor) { showToast('Select a building and floor', 'error'); return; }
        
        const existingMeter = ALL_METERS.find(m => m.id === meterId);
        if (existingMeter) {
            existingMeter.building = bKey;
            existingMeter.buildingName = BUILDINGS[bKey].name;
            existingMeter.floor = floor;
            existingMeter.panel = panel;
            saveConfig();
            populateLiveFilters();
            populateOverviewMeterDropdown();
            updateConfigTable();
            updateSimulation();
            showToast(`Meter "${meterId}" re-assigned to ${BUILDINGS[bKey].name} - ${floor}`);
            return;
        }

        ALL_METERS.push({
            id: meterId, name: `${BUILDINGS[bKey].name} ${meterId}`,
            building: bKey, buildingName: BUILDINGS[bKey].name,
            floor, panel, status: null, v: null, i: null, p: null, pf: null
        });
        if (BUILDINGS[bKey]) BUILDINGS[bKey].meterCount++;
        document.getElementById('settings-meter-id').value = '';
        document.getElementById('settings-meter-panel').value = '';
        saveConfig();
        populateLiveFilters();
        updateConfigTable();
        updateSimulation();
        showToast(`Meter "${meterId}" added to ${BUILDINGS[bKey].name}`);
        populateOverviewMeterDropdown();
        overviewUsageView?.refresh(true);
    });

    const btnSaveAlarms = document.getElementById('btn-save-alarms');
    if (btnSaveAlarms) {
        btnSaveAlarms.addEventListener('click', () => {
            const b = document.getElementById('settings-alarm-building').value;
            const f = document.getElementById('settings-alarm-floor').value;
            const v = parseFloat(document.getElementById('settings-alarm-voltage').value) || 240;
            const pStr = parseFloat(document.getElementById('settings-alarm-power').value) || 5;
            // Convert to kW for internal threshold check
            const pKw = powerUnit === 'W' ? pStr / 1000 : pStr;

            const key = `${b}_${f}`;
            floorThresholds[key] = { v, p: pKw };
            saveConfig();
            showToast(`Thresholds updated for ${BUILDINGS[b]?.name} - ${f}`);
        });
    }
}

// =============================================
// EXPORT
// =============================================
function exportToExcel() {
    const filtered = getFilteredMeters();
    const bSel = document.getElementById('filter-building');
    const fSel = document.getElementById('filter-floor');
    let csv = '\uFEFF';
    csv += 'Ibots Energy Monitor - Live Data Export\r\n';
    csv += `Generated: ${new Date().toLocaleString()}\r\n`;
    csv += `Building: ${bSel.options[bSel.selectedIndex].text}, Floor: ${fSel.options[fSel.selectedIndex].text}\r\n\r\n`;
    csv += 'Meter ID,Meter Name,Building,Panel,Floor,Voltage (V),Current (A),Power (kW),Power Factor,Status\r\n';
    filtered.forEach(m => {
        csv += `${m.id},${m.name},${m.buildingName},${m.panel},${m.floor},${m.v.toFixed(1)},${m.i.toFixed(1)},${m.p.toFixed(2)},${m.pf.toFixed(2)},${m.status}\r\n`;
    });
    csv += '\r\nSUMMARY\r\n';
    const tp = filtered.reduce((s, m) => s + m.p, 0);
    const ap = filtered.reduce((s, m) => s + m.pf, 0) / (filtered.length || 1);
    csv += `Total Power (kW),${tp.toFixed(2)}\r\nAvg PF,${ap.toFixed(3)}\r\nActive Meters,${filtered.length}\r\nGrid (kW),${GRID_SUPPLY_KW}\r\nDG Req (kW),${Math.max(0, tp - GRID_SUPPLY_KW).toFixed(2)}\r\n`;
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `Ibots_Energy_Report_${new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-')}.csv`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
}

// =============================================
// BOOT
// =============================================
let gatewayOnline = true;
window.toggleGateway = function() {
    if (gatewayOnline) {
        document.getElementById('gateway-modal').style.display = 'flex';
        return;
    }
    
    executeGatewayToggle();
};

function executeGatewayToggle() {
    gatewayOnline = !gatewayOnline;
    const dot = document.getElementById('gateway-dot');
    const txt = document.getElementById('gateway-text');
    const refreshBtn = document.getElementById('gateway-refresh-btn');
    
    if (gatewayOnline) {
        if (dot) dot.style.backgroundColor = 'var(--accent-green)';
        if (txt) {
            txt.textContent = 'GATEWAY ONLINE';
            txt.style.color = 'var(--accent-green)';
        }
        if (refreshBtn) refreshBtn.style.display = 'none';
        
        // Re-enable all meter statuses to ONLINE
        ALL_METERS.forEach(m => m.status = 'ONLINE');
        showToast('Gateway connection restored', 'success');
    } else {
        if (dot) dot.style.backgroundColor = 'var(--accent-red)';
        if (txt) {
            txt.textContent = 'GATEWAY OFFLINE';
            txt.style.color = 'var(--accent-red)';
        }
        if (refreshBtn) refreshBtn.style.display = 'block';
        
        // Disable all meters
        ALL_METERS.forEach(m => m.status = 'OFFLINE');
        showToast('Gateway disconnected', 'error');
    }
    
    // Immediately trigger a UI update to reflect the change
    updateSimulation();
}

document.addEventListener('DOMContentLoaded', () => {
    initLogin();
    initNavigation();
    initFilters();
    initSettings();
    initHistoryFilters();
    initOverviewFilters();
    checkSession();
    
    document.getElementById('btn-export-excel')?.addEventListener('click', exportToExcel);
    document.getElementById('btn-export-history')?.addEventListener('click', () => {
        let csv = '\uFEFFIbots Energy Monitor - History Export\r\nDate,Building,Floor,Energy (kWh),Peak (kW),Avg PF\r\n';
        historyData.slice(-60).forEach(r => { csv += `${r.date},${r.building},${r.floor},${r.energy},${r.peak},${r.pf}\r\n`; });
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `Ibots_History_${new Date().toISOString().slice(0, 10)}.csv`;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
    });

    document.getElementById('btn-cancel-disconnect')?.addEventListener('click', () => {
        document.getElementById('gateway-modal').style.display = 'none';
    });
    
    document.getElementById('btn-confirm-disconnect')?.addEventListener('click', () => {
        document.getElementById('gateway-modal').style.display = 'none';
        executeGatewayToggle();
    });
});

function initOverviewFilters() {
    overviewUsageView = createUsageOverview({
        convertEnergy: convertPower, energyUnit: getEnergyUnitLabel,
        telemetry: () => [...liveTelemetryByMeter.values()]
    });
}

function populateOverviewMeterDropdown() {
    const select = document.getElementById('overview-filter-meter');
    if (!select) return;
    const previous = select.value;
    const options = [new Option('All Meters', 'ALL')];
    const seen = new Set();
    for (const meter of ALL_METERS) {
        if (meter.id && !seen.has(meter.id)) {
            seen.add(meter.id);
            options.push(new Option(meter.name || meter.id, meter.id));
        }
    }
    select.replaceChildren(...options);
    if (seen.has(previous)) select.value = previous;
}

function initHistoryFilters() {
    const fromInput = document.getElementById('filter-date-from');
    const toInput = document.getElementById('filter-date-to');
    
    if (fromInput && toInput) {
        // Default to last 30 days
        const today = new Date();
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(today.getDate() - 30);
        
        fromInput.value = thirtyDaysAgo.toISOString().split('T')[0];
        toInput.value = today.toISOString().split('T')[0];
        
        const fetchHistoryData = async () => {
            try {
                const fromVal = fromInput.value;
                const toVal = toInput.value;
                const res = await fetch(`/api/history?from=${fromVal}&to=${toVal}`);
                if (res.ok) {
                    historyData = await res.json();
                    
                    populateHistoryTable();
                    
                    if (trendChart) {
                        const dailySummary = {};
                        historyData.forEach(r => {
                            const dateKey = r.date;
                            if (!dailySummary[dateKey]) dailySummary[dateKey] = 0;
                            dailySummary[dateKey] += Number(r.energy || 0.005);
                        });
                        
                        trendChart.data.labels = Object.keys(dailySummary);
                        trendChart.data.datasets[0].data = Object.values(dailySummary);
                        trendChart.update();
                    }
                }
            } catch (e) {
                console.error("Failed to fetch history data:", e);
            }
        };
        
        const queryBtn = document.getElementById('btn-query-history');
        if (queryBtn) {
            queryBtn.addEventListener('click', async () => {
                const activeView = document.querySelector('.page-view.active')?.id;
                const fromVal = fromInput.value;
                const toVal = toInput.value;
                if (!fromVal || !toVal) return;

                if (activeView === 'view-live') {
                    try {
                        const token = localStorage.getItem('jwt_token');
                        const headers = token ? { 'Authorization': 'Bearer ' + token } : {};
                        const res = await fetch(`/api/telemetry?from=${fromVal}&to=${toVal}`, { headers });
                        if (res.ok) {
                            const historicalMeters = await res.json();
                            if (simulationInterval) {
                                clearInterval(simulationInterval);
                                simulationInterval = null;
                            }
                            ALL_METERS.length = 0;
                            historicalMeters.forEach(m => {
                                ALL_METERS.push(m);
                            });
                            updateLiveTable(getFilteredMeters());
                            showToast(`Loaded historical data for ${fromVal} to ${toVal}`);
                        }
                    } catch (e) {
                        console.error("Failed to fetch historical telemetry:", e);
                    }
                } else {
                    await fetchHistoryData();
                }
            });
        }
        
        fetchHistoryData();
    }

    usageReportsView = createUsageReports({ meters: () => ALL_METERS, buildings: () => BUILDINGS, convertEnergy: convertPower, energyUnit: getEnergyUnitLabel });
}
