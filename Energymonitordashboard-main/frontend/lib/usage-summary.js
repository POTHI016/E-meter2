export function usageSummary(meters) {
    const sum = field => meters.some(m => m[field] != null)
        ? meters.reduce((total, m) => total + (m[field] ?? 0), 0) : null;
    return {
        runningSeconds: sum('runningSeconds'), idleSeconds: sum('idleSeconds'),
        energyConsumedKwh: sum('energyConsumedKwh'), unrecordedSeconds: sum('unrecordedSeconds'),
        incompleteEnergy: meters.some(m => m.energyConsumedKwh == null),
        energyEstimated: meters.some(m => m.energyEstimated), counterReset: meters.some(m => m.counterReset)
    };
}

export function rankUsage(meters, field) {
    return [...meters].sort((a, b) => {
        if (a[field] == null && b[field] != null) return 1;
        if (b[field] == null && a[field] != null) return -1;
        return (b[field] ?? 0) - (a[field] ?? 0) || a.meterId.localeCompare(b.meterId);
    });
}
