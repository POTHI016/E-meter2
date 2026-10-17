import { MongoClient } from 'mongodb';
import crypto from 'crypto';
import { archiveRecentUsage, getMeterUsage, getUsageOverview, legacyUsageParams, meterHoursReport, energyUsageReport, usageRange } from '../lib/meter-usage.js';
import { normalizeTelemetry, getLatestTelemetry, saveLatestTelemetry } from '../lib/telemetry.js';

const MONGODB_URI = 'mongodb+srv://techwizapp_db_user:A6Cct9YvVqiqMRkQ@cluster0.zrug0lo.mongodb.net/energy_monitor?retryWrites=true&w=majority&ssl=true';
let cachedClient = null;
let cachedDb = null;

const JWT_SECRET = 'super_secure_energy_monitor_secret_key_2026';

function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

function base64url(source) {
  return Buffer.from(source).toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function signJwt(payload) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const encodedHeader = base64url(JSON.stringify(header));
  
  const expPayload = {
    ...payload,
    exp: Math.floor(Date.now() / 1000) + (24 * 60 * 60)
  };
  const encodedPayload = base64url(JSON.stringify(expPayload));
  
  const signatureInput = `${encodedHeader}.${encodedPayload}`;
  const signature = crypto.createHmac('sha256', JWT_SECRET)
    .update(signatureInput)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
    
  return `${signatureInput}.${signature}`;
}

function verifyJwt(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    
    const [encodedHeader, encodedPayload, signature] = parts;
    const signatureInput = `${encodedHeader}.${encodedPayload}`;
    const expectedSignature = crypto.createHmac('sha256', JWT_SECRET)
      .update(signatureInput)
      .digest('base64')
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
      
    if (signature !== expectedSignature) return null;
    
    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64').toString('utf8'));
    if (payload.exp && Date.now() / 1000 > payload.exp) return null;
    
    return payload;
  } catch (e) {
    return null;
  }
}

async function seedUsers(db) {
  try {
    const col = db.collection('users');
    const count = await col.countDocuments();
    if (count === 0) {
      await col.insertMany([
        { username: 'superadmin', passwordHash: hashPassword('ssb@2025'), role: 'Super Admin', access: 'full' },
        { username: 'admin', passwordHash: hashPassword('admin123'), role: 'Admin', access: 'full' },
        { username: 'engineer', passwordHash: hashPassword('eng123'), role: 'Engineer', access: 'limited' },
        { username: 'viewer', passwordHash: hashPassword('view123'), role: 'Viewer', access: 'readonly' }
      ]);
      console.log('[MongoDB] Seeded default users');
    }
  } catch (e) {
    console.error('[MongoDB] Failed to seed users:', e.message);
  }
}

let connectionPromise = null;
async function getDb() {
  if (cachedClient && cachedDb) return cachedDb;
  if (connectionPromise) return connectionPromise;
  connectionPromise = (async () => {
    const connecting = new MongoClient(MONGODB_URI, {
      maxPoolSize: 10, minPoolSize: 1, maxIdleTimeMS: 15000,
      serverSelectionTimeoutMS: 15000, connectTimeoutMS: 15000
    });
    await connecting.connect();
    const database = connecting.db('energy_monitor');
    await seedUsers(database);
    cachedClient = connecting;
    cachedDb = database;
    return cachedDb;
  })();
  try { return await connectionPromise; } finally { connectionPromise = null; }
}

let memoryConfigCache = null;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, x-api-key');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const url = req.url || '';
  const method = req.method || 'GET';
  const parsedUrl = new URL(url, 'http://localhost');

  // 0. AUTHENTICATION ENDPOINTS
  if (url.includes('/login') && method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch(e) {}
    }
    const { username, password } = body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }
    
    try {
      const db = await getDb();
      const user = await db.collection('users').findOne({ username: username.toLowerCase().trim() });
      if (!user) {
        return res.status(401).json({ error: 'Invalid username or password' });
      }
      
      const inputHash = hashPassword(password);
      if (user.passwordHash !== inputHash) {
        return res.status(401).json({ error: 'Invalid username or password' });
      }
      
      const token = signJwt({
        username: user.username,
        role: user.role,
        access: user.access
      });
      
      return res.status(200).json({
        token,
        user: {
          username: user.username,
          role: user.role,
          access: user.access
        }
      });
    } catch (err) {
      return res.status(500).json({ error: 'Login failed: ' + err.message });
    }
  }

  if (url.includes('/verify-token') && method === 'GET') {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }
    
    const token = authHeader.split(' ')[1];
    const payload = verifyJwt(token);
    if (!payload) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    
    return res.status(200).json({ user: payload });
  }

  // 1. CONFIG ENDPOINTS
  if (url.includes('/config')) {
    if (method === 'GET') {
      try {
        const db = await getDb();
        const doc = await db.collection('config').findOne({ id: 'global_config' });
        if (doc) return res.status(200).json(doc);
      } catch (e) {}
      return res.status(200).json(memoryConfigCache || {});
    }

    if (method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch(e) {}
      }
      body = body || {};

      const docToSave = {
        id: 'global_config',
        buildings: body.buildings || {},
        meters: body.meters || [],
        floorThresholds: body.floorThresholds || {},
        updatedAt: new Date()
      };
      memoryConfigCache = docToSave;

      try {
        const db = await getDb();
        const result = await db.collection('config').replaceOne(
          { id: 'global_config' },
          docToSave,
          { upsert: true }
        );
        console.log('[MongoDB Config] Successfully saved global_config to Atlas:', result.upsertedCount || result.modifiedCount);
        return res.status(200).json({ status: 'SUCCESS', config: memoryConfigCache, upsertedCount: result.upsertedCount || result.modifiedCount });
      } catch (e) {
        console.error('[MongoDB Config Save Error]', e.message);
        return res.status(500).json({ status: 'ERROR', error: e.message });
      }
    }
  }

  // 2. TELEMETRY ENDPOINTS
  if (url.includes('/telemetry')) {
    if (method === 'POST') {
      const apiKeyHeader = req.headers['x-api-key'] || parsedUrl.searchParams.get('api_key');
      const validKeys = [
        'esp32_sec_e8b4a2f1c9d7e3a5b0c6f4d2a8e1b7c3',
        'esp32_sec_7f9a8b6c5d4e3f2a1b0c9d8e7f6a5b4c'
      ];
      if (!apiKeyHeader || !validKeys.includes(apiKeyHeader)) {
        return res.status(401).json({ error: 'Unauthorized: Invalid API Key' });
      }

      let body = req.body;
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch(e) {}
      }
      body = body || {};

      let doc;
      try { doc = normalizeTelemetry(body); }
      catch (error) { return res.status(400).json({ error: error.message }); }
      const mId = doc.meterId;


      try {
        const db = await getDb();
        
        // Lookup building, floor, and panel from saved config if missing
        try {
          const configDoc = await db.collection('config').findOne({ id: 'global_config' });
          if (configDoc && configDoc.meters) {
            const matchedMeter = configDoc.meters.find(m => m.id === mId);
            if (matchedMeter) {
              doc.building = matchedMeter.buildingName || matchedMeter.building || doc.building;
              doc.floor = matchedMeter.floor || doc.floor;
              doc.panel = matchedMeter.panel || doc.panel;
              doc.meterName = matchedMeter.name || doc.meterName;
            }
          }
        } catch (cfgErr) {}

        delete doc._id;
        await db.collection('telemetry_history').insertOne(doc);
        await saveLatestTelemetry(db, doc);
        db.collection('telemetry_history').createIndex({ meterId: 1, timestamp: -1 }).catch(() => {});
        db.collection('meter_usage_minutes').createIndex({ meterId: 1, timestamp: 1 }).catch(() => {});
        try {
          await archiveRecentUsage(db, mId, doc.timestamp);
        } catch (error) {
          console.error('[Meter Usage] Could not archive minute totals');
        }

        // Auto-create 30-Day TTL Index on raw telemetry history
        db.collection('telemetry_history').createIndex({ timestamp: 1 }, { expireAfterSeconds: 2592000 }).catch(() => {});


      } catch (e) {
        console.error('[MongoDB Telemetry Save Error]', e.message);
        return res.status(503).json({ error: 'Failed to save telemetry; retry the packet' });
      }

      return res.status(200).json({ status: 'SUCCESS', data: doc });
    }

    if (method === 'GET') {
      if (parsedUrl.searchParams.get('all') === 'true') {
        try { return res.status(200).json(await getLatestTelemetry(await getDb())); }
        catch (error) { return res.status(500).json({ error: 'Failed to load meter telemetry' }); }
      }
      const from = parsedUrl.searchParams.get('from');
      const to = parsedUrl.searchParams.get('to');
      
      if (from && to) {
        try {
          const db = await getDb();
          const fromDate = new Date(from);
          const toDate = new Date(to);
          toDate.setHours(23, 59, 59, 999);

          const query = {
            timestamp: { $gte: fromDate, $lte: toDate }
          };
          const selectedMeter = parsedUrl.searchParams.get('meterId');
          if (selectedMeter) query.meterId = selectedMeter;

          const docs = await db.collection('telemetry_history').aggregate([
            { $match: query },
            { $sort: { timestamp: -1 } },
            { $group: {
                _id: "$meterId",
                latestDoc: { $first: "$$ROOT" }
            } }
          ]).toArray();

          const results = docs.map(d => {
            const doc = d.latestDoc;
            return {
              id: doc.meterId,
              meterId: doc.meterId,
              name: doc.meterName || doc.meterId,
              building: doc.building ? doc.building.toLowerCase().replace(/[^a-z0-9]/g, '') : '',
              buildingName: doc.building || '-',
              floor: doc.floor || '-',
              panel: doc.panel || '-',
              status: 'ONLINE',
              v: [doc.v_r, doc.v_y, doc.v_b].filter(value => value !== null && value !== undefined).length ? [doc.v_r, doc.v_y, doc.v_b].filter(value => value !== null && value !== undefined).reduce((sum, value) => sum + Number(value), 0) / [doc.v_r, doc.v_y, doc.v_b].filter(value => value !== null && value !== undefined).length : null,
              i: [doc.i_r, doc.i_y, doc.i_b].filter(value => value !== null && value !== undefined).length ? [doc.i_r, doc.i_y, doc.i_b].filter(value => value !== null && value !== undefined).reduce((sum, value) => sum + Number(value), 0) / [doc.i_r, doc.i_y, doc.i_b].filter(value => value !== null && value !== undefined).length : null,
              p: doc.total_power_kw === null || doc.total_power_kw === undefined ? null : Number(doc.total_power_kw),
              pf: doc.avg_power_factor === null || doc.avg_power_factor === undefined ? null : Number(doc.avg_power_factor),
              energy_active: doc.energy_active,
              on_hours: doc.on_hours,
              modbus: doc
            };
          });
          return res.status(200).json(results);
        } catch (e) {
          return res.status(500).json({ error: e.message });
        }
      }

      try {
        const db = await getDb();
        const meterId = parsedUrl.searchParams.get('meterId');
        const latest = (await getLatestTelemetry(db, meterId)).sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        if (latest && latest.length > 0) {
          return res.status(200).json(latest[0]);
        }
      } catch (e) {}
      return res.status(404).json({ error: 'No telemetry data available' });
    }
  }

  if (url.includes('/meter-usage') && method === 'GET') {
    const params = Object.fromEntries(parsedUrl.searchParams);
    try {
      usageRange(params);
      if (!params.meterId || params.meterId === 'ALL') throw new Error('Select a meter');
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
    try {
      return res.status(200).json(await getMeterUsage(await getDb(), params));
    } catch (error) {
      return res.status(500).json({ error: 'Failed to load meter usage' });
    }
  }

  if (url.includes('/usage-overview') && method === 'GET') {
    const params = Object.fromEntries(parsedUrl.searchParams);
    try { usageRange(params); } catch (error) { return res.status(400).json({ error: error.message }); }
    try { return res.status(200).json(await getUsageOverview(await getDb(), params)); }
    catch (error) { return res.status(500).json({ error: 'Failed to load usage overview' }); }
  }

  if ((url.includes('/meter-hours') || url.includes('/energy-report')) && method === 'GET') {
    let params;
    try { params = legacyUsageParams(Object.fromEntries(parsedUrl.searchParams)); }
    catch (error) { return res.status(400).json({ error: error.message }); }
    try {
      const overview = await getUsageOverview(await getDb(), params);
      return res.status(200).json(url.includes('/meter-hours') ? meterHoursReport(overview) : energyUsageReport(overview));
    } catch (error) { return res.status(500).json({ error: 'Failed to load usage report' }); }
  }


  // 3. HISTORY ENDPOINT
  if (url.includes('/history') && method === 'GET') {
    try {
      const db = await getDb();
      const from = parsedUrl.searchParams.get('from');
      const to = parsedUrl.searchParams.get('to');
      let fromDate = from ? new Date(from) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      let toDate = to ? new Date(to) : new Date();
      toDate.setHours(23, 59, 59, 999);

      const col = db.collection('telemetry_history');
      const query = {
        timestamp: { $gte: fromDate, $lte: toDate }
      };

      const docs = await col.find(query).sort({ timestamp: 1 }).toArray();
      const groups = {};
      docs.forEach(doc => {
        const t = new Date(doc.timestamp);
        const dateStr = t.toLocaleDateString('en-GB');
        const building = doc.building || '-';
        const floor = doc.floor || '-';
        const meterId = doc.meterId || doc.meter_id || '-';
        const meterName = doc.meterName || doc.meter_name || doc.meterId || '-';
        const key = `${dateStr}_${building}_${floor}_${meterId}`;

        if (!groups[key]) {
          groups[key] = {
            date: dateStr, building, floor, meterId, meterName,
            minEnergy: doc.energy_active || 0, maxEnergy: doc.energy_active || 0,
            peak: 0, pfSum: 0, pfCount: 0
          };
        }

        const energy = doc.energy_active || 0;
        if (energy < groups[key].minEnergy) groups[key].minEnergy = energy;
        if (energy > groups[key].maxEnergy) groups[key].maxEnergy = energy;

        const power = Number(doc.total_power_kw || 0);
        if (power > groups[key].peak) groups[key].peak = power;

        const pf = Number(doc.avg_power_factor || 0);
        if (pf > 0) {
          groups[key].pfSum += pf;
          groups[key].pfCount++;
        }
      });

      const historyList = Object.values(groups).map(g => {
        const diffEnergy = g.maxEnergy - g.minEnergy;
        return {
          date: g.date, building: g.building, floor: g.floor,
          meterId: g.meterId, meterName: g.meterName,
          energy: (diffEnergy > 0 ? diffEnergy : g.maxEnergy).toFixed(4),
          peak: g.peak.toFixed(2),
          pf: (g.pfCount > 0 ? g.pfSum / g.pfCount : 0).toFixed(2)
        };
      });

      return res.status(200).json(historyList);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(200).json({ status: 'OK', service: 'IoT Energy Monitor Vercel API' });
}
