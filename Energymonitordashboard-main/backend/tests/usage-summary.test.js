import test from 'node:test';
import assert from 'node:assert/strict';
import { usageSummary, rankUsage } from '../../frontend/lib/usage-summary.js';

test('report totals retain missing data and sum meter-hours and consumption', () => {
    assert.equal(usageSummary([]).energyConsumedKwh, null);
    const summary = usageSummary([{ energyConsumedKwh: 7, runningSeconds: 21600, idleSeconds: 7200, unrecordedSeconds: 0 }, { energyConsumedKwh: null, runningSeconds: null, idleSeconds: null, unrecordedSeconds: 28800 }]);
    assert.equal(summary.energyConsumedKwh, 7);
    assert.equal(summary.runningSeconds, 21600);
    assert.equal(summary.idleSeconds, 7200);
    assert.equal(summary.unrecordedSeconds, 28800);
    assert.equal(summary.incompleteEnergy, true);
});

test('ranking preserves zero, puts missing values last and breaks ties by ID', () => {
    const meters = [{ meterId: 'missing', energyConsumedKwh: null }, { meterId: 'zero', energyConsumedKwh: 0 }, { meterId: 'b', energyConsumedKwh: 7 }, { meterId: 'a', energyConsumedKwh: 7 }];
    assert.deepEqual(rankUsage(meters, 'energyConsumedKwh').map(m => m.meterId), ['a', 'b', 'zero', 'missing']);
    assert.equal(meters[0].meterId, 'missing');
});
