import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import mongodb from 'mongodb';
import { archiveRecentUsage, getMeterUsage, getUsageOverview, legacyUsageParams, meterHoursReport, energyUsageReport, usageRange } from '../frontend/lib/meter-usage.js';
import { normalizeTelemetry, getLatestTelemetry, saveLatestTelemetry } from '../frontend/lib/telemetry.js';

const { MongoClient } = mongodb;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 5000;

const MONGODB_URI = 'mongodb+srv://techwizapp_db_user:A6Cct9YvVqiqMRkQ@cluster0.zrug0lo.mongodb.net/energy_monitor?retryWrites=true&w=majority';
let client = null;
let db = null;
let mongoConnectError = null;

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
async function connectToMongo() {
  if (db && client) return db;
  if (connectionPromise) return connectionPromise;
  connectionPromise = (async () => {
    try {
      mongoConnectError = null;
      const connecting = new MongoClient(MONGODB_URI, {
        useNewUrlParser: true, useUnifiedTopology: true, poolSize: 10,
        serverSelectionTimeoutMS: 15000, connectTimeoutMS: 15000
      });
      await connecting.connect();
      const database = connecting.db('energy_monitor');
      await seedUsers(database);
      client = connecting;
      db = database;
      return db;
    } catch (error) {
      console.error('[MongoDB] Connection failed:', error.message.replace(/mongodb(?:\+srv)?:\/\/[^\s]+/g, '[redacted connection]'));
      mongoConnectError = 'Database connection failed';
      client = null; db = null;
      return null;
    }
  })();
  try { return await connectionPromise; } finally { connectionPromise = null; }
}

// Automatically try to connect on startup
connectToMongo();

app.use(cors());
app.use(express.json());

// ================= AUTHENTICATION ENDPOINTS =================
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }
  
  try {
    const db = await connectToMongo();
    if (!db) {
      return res.status(500).json({ error: 'Database connection failed' });
    }
    
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
    
    res.json({
      token,
      user: {
        username: user.username,
        role: user.role,
        access: user.access
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'Login failed: ' + err.message });
  }
});

app.get('/api/verify-token', (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }
  
  const token = authHeader.split(' ')[1];
  const payload = verifyJwt(token);
  if (!payload) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  
  res.json({ user: payload });
});

// In-memory store for ESP32 API Keys
let apiKeys = [
  {
    id: 'key-1',
    deviceName: 'ESP32 3-Phase Modbus Energy Meter - Main Feeder',
    deviceMac: '24:6F:28:AB:12:34',
    key: 'esp32_sec_e8b4a2f1c9d7e3a5b0c6f4d2a8e1b7c3',
    status: 'ACTIVE',
    created: '2026-09-05 13:10:00',
    lastActive: 'Just now'
  },
  {
    id: 'key-legacy',
    deviceName: 'Legacy ESP32 Key',
    deviceMac: '24:6F:28:AB:12:34',
    key: 'esp32_sec_7f9a8b6c5d4e3f2a1b0c9d8e7f6a5b4c',
    status: 'ACTIVE',
    created: '2026-08-14 10:30:00',
    lastActive: 'Just now'
  },
  {
    id: 'key-2',
    deviceName: 'ESP32 Telemetry Device',
    deviceMac: '00:00:00:00:00:00',
    key: 'esp32_sec_e8b4a2f1c9d7e3a5b0c6f4d2a8e1b7c3',
    status: 'ACTIVE',
    created: '2026-09-14 00:00:00',
    lastActive: 'Never'
  }
];

// Populated only after the first valid hardware packet is received.
let latestEsp32Telemetry = null;

// ================= API KEY MANAGEMENT ENDPOINTS =================
app.get('/api/keys', (req, res) => {
  res.json(apiKeys);
});

app.post('/api/keys', (req, res) => {
  const { deviceName, deviceMac } = req.body;
  if (!deviceName) return res.status(400).json({ error: 'Device name is required' });

  const randomSecret = crypto.randomBytes(16).toString('hex');
  const newKey = {
    id: `key-${Date.now()}`,
    deviceName,
    deviceMac: deviceMac || '00:00:00:00:00:00',
    key: `esp32_sec_${randomSecret}`,
    status: 'ACTIVE',
    created: new Date().toLocaleString(),
    lastActive: 'Never'
  };

  apiKeys.push(newKey);
  res.status(201).json(newKey);
});

app.delete('/api/keys/:id', (req, res) => {
  const { id } = req.params;
  apiKeys = apiKeys.filter(k => k.id !== id);
  res.json({ message: 'API Key revoked successfully' });
});

// Ingest function for incoming hardware payloads (Strictly Dynamic, Zero Defaults)
const handleEsp32TelemetryPost = async (req, res) => {
  const apiKeyHeader = req.headers['x-api-key'] || req.query.api_key;
  
  // Validate API Key
  const validKey = apiKeys.find(k => k.key === apiKeyHeader && k.status === 'ACTIVE') || 
                   (apiKeyHeader === 'esp32_sec_e8b4a2f1c9d7e3a5b0c6f4d2a8e1b7c3') || 
                   (apiKeyHeader === 'esp32_sec_7f9a8b6c5d4e3f2a1b0c9d8e7f6a5b4c');
  if (!validKey) {
    return res.status(401).json({ error: 'Unauthorized: Invalid or revoked ESP32 API Key' });
  }

  if (typeof validKey === 'object') validKey.lastActive = 'Just now';

  let doc;
  try { doc = normalizeTelemetry(req.body); }
  catch (error) { return res.status(400).json({ error: error.message }); }
  const mId = doc.meterId;


  // Save to MongoDB synchronously before returning serverless response
  try {
    const db = await connectToMongo();
    if (db) {
      // Lookup building and floor from saved config if missing
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

      const col = db.collection('telemetry_history');
      delete doc._id;
      await col.insertOne(doc);
      await saveLatestTelemetry(db, doc);
      latestEsp32Telemetry = doc;
      col.createIndex({ meterId: 1, timestamp: -1 }).catch(() => {});
      db.collection('meter_usage_minutes').createIndex({ meterId: 1, timestamp: 1 }).catch(() => {});
      try {
        await archiveRecentUsage(db, mId, doc.timestamp);
      } catch (error) {
        console.error('[Meter Usage] Could not archive minute totals');
      }
      console.log(`[MongoDB] Ingested telemetry doc for ${mId}`);
    } else return res.status(503).json({ error: 'Database unavailable; telemetry was not saved' });
  } catch (e) {
    console.error('[MongoDB] Ingest failed:', e.message);
    return res.status(503).json({ error: 'Failed to save telemetry; retry the packet' });
  }

  console.log(`[Hardware Telemetry Ingest] Recorded payload for ${mId}`);

  res.status(200).json({
    status: 'SUCCESS',
    message: 'Raw hardware telemetry recorded cleanly without fallback defaults',
    receivedCount: 22,
    data: doc
  });
};

// Ingest Endpoints (Supports /api/telemetry/esp32, /telemetry/esp32, /api/telemetry, /telemetry POST)
app.post(['/api/telemetry/esp32', '/telemetry/esp32', '/api/telemetry', '/telemetry'], handleEsp32TelemetryPost);

// Strictly Dynamic Telemetry GET Endpoint
// Strictly Dynamic Telemetry GET Endpoint (with optional from/to date filtering)
app.get(['/api/telemetry', '/telemetry'], async (req, res) => {
  const { from, to, meterId } = req.query;
  if (req.query.all === 'true') {
    try {
      const db = await connectToMongo();
      if (!db) return res.status(503).json({ error: 'Database connection failed' });
      return res.json(await getLatestTelemetry(db));
    } catch (error) {
      console.error('[Meter Telemetry]', error.message.replace(/mongodb(?:\+srv)?:\/\/[^\s]+/g, '[redacted connection]'));
      return res.status(500).json({ error: 'Failed to load meter telemetry' });
    }
  }
  if (from && to) {
    try {
      const db = await connectToMongo();
      if (!db) {
        return res.status(500).json({ error: 'Database connection failed' });
      }
      const fromDate = new Date(from);
      const toDate = new Date(to);
      toDate.setHours(23, 59, 59, 999);

      const query = {
        timestamp: { $gte: fromDate, $lte: toDate }
      };
      if (meterId) query.meterId = meterId;

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
        const voltages = [doc.v_r, doc.v_y, doc.v_b].filter(value => value !== null && value !== undefined);
        const currents = [doc.i_r, doc.i_y, doc.i_b].filter(value => value !== null && value !== undefined);
        return {
          id: doc.meterId,
          meterId: doc.meterId,
          name: doc.meterName || null,
          building: doc.building ? doc.building.toLowerCase().replace(/[^a-z0-9]/g, '') : null,
          buildingName: doc.building || null,
          floor: doc.floor || null,
          panel: doc.panel || null,
          status: doc.status || null,
          v: voltages.length ? voltages.reduce((sum, value) => sum + Number(value), 0) / voltages.length : null,
          i: currents.length ? currents.reduce((sum, value) => sum + Number(value), 0) / currents.length : null,
          p: doc.total_power_kw === null || doc.total_power_kw === undefined ? null : Number(doc.total_power_kw),
          pf: doc.avg_power_factor === null || doc.avg_power_factor === undefined ? null : Number(doc.avg_power_factor),
          energy_active: doc.energy_active,
          on_hours: doc.on_hours,
          modbus: doc
        };
      });
      return res.json(results);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // Read persisted telemetry too: hardware may post to the hosted API, or this process may have restarted.
  let telemetry = !meterId || latestEsp32Telemetry?.meterId === meterId ? latestEsp32Telemetry : null;
  try {
    const db = await connectToMongo();
    if (db) {
      const docs = await getLatestTelemetry(db, meterId);
      const stored = docs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0];
      if (stored && (!telemetry || new Date(stored.timestamp) >= new Date(telemetry.timestamp))) {
        telemetry = stored;
      }
    } else if (!telemetry) {
      return res.status(503).json({ error: 'Database connection failed' });
    }
  } catch (error) {
    if (!telemetry) return res.status(500).json({ error: 'Failed to load telemetry' });
  }

  if (!telemetry) {
    return res.status(404).json({ error: 'No telemetry data available' });
  }

  res.json({
    meter_id: telemetry.meterId,
    meterId: telemetry.meterId,
    meterName: telemetry.meterName,
    building: telemetry.building,
    floor: telemetry.floor,
    status: telemetry.status,
    timestamp: telemetry.timestamp,
    totalEnergy: telemetry.energy_active,
    peakDemand: telemetry.total_power_kw,
    avgPf: telemetry.avg_power_factor,
    activeMeters: telemetry.meterId ? '1/1' : '0/0',
    modbus: telemetry
  });
});

app.get('/api/meter-usage', async (req, res) => {
  try {
    usageRange(req.query);
    if (typeof req.query.meterId !== 'string' || !req.query.meterId || req.query.meterId === 'ALL') throw new Error('Select a meter');
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
  try {
    const db = await connectToMongo();
    if (!db) return res.status(503).json({ error: 'Database connection failed' });
    res.json(await getMeterUsage(db, req.query));
  } catch (error) {
    res.status(500).json({ error: 'Failed to load meter usage' });
  }
});

app.get('/api/usage-overview', async (req, res) => {
  try { usageRange(req.query); } catch (error) { return res.status(400).json({ error: error.message }); }
  try {
    const db = await connectToMongo();
    if (!db) return res.status(503).json({ error: 'Database connection failed' });
    res.json(await getUsageOverview(db, req.query));
  } catch (error) {
    console.error('[Usage Overview]', error.message.replace(/mongodb(?:\+srv)?:\/\/[^\s]+/g, '[redacted connection]'));
    res.status(500).json({ error: 'Failed to load usage overview' });
  }
});

for (const [path, report] of [['/api/meter-hours', meterHoursReport], ['/api/energy-report', energyUsageReport]]) {
  app.get(path, async (req, res) => {
    let params;
    try { params = legacyUsageParams(req.query); }
    catch (error) { return res.status(400).json({ error: error.message }); }
    try {
      const db = await connectToMongo();
      if (!db) return res.status(503).json({ error: 'Database connection failed' });
      res.json(report(await getUsageOverview(db, params)));
    } catch (error) { res.status(500).json({ error: 'Failed to load usage report' }); }
  });
}


// History GET Endpoint - Queries MongoDB and groups by Date, Building, Floor
app.get(['/api/history', '/history'], async (req, res) => {
  let fromDate = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  let toDate = req.query.to ? new Date(req.query.to) : new Date();
  
  // Set toDate to the end of that day
  toDate.setHours(23, 59, 59, 999);
  
  const db = await connectToMongo();
  if (!db) {
    return res.json([]);
  }
  
  try {
    const col = db.collection('telemetry_history');
    const query = {
      timestamp: { $gte: fromDate, $lte: toDate }
    };
    
    const docs = await col.find(query).sort({ timestamp: 1 }).toArray();
    
    // Group by Date, Building, Floor, Meter
    const groups = {};
    docs.forEach(doc => {
      const t = new Date(doc.timestamp);
      const dateStr = t.toLocaleDateString('en-GB'); // "DD/MM/YYYY" format
      const building = doc.building || '-';
      const floor = doc.floor || '-';
      const meterId = doc.meterId || doc.meter_id || '-';
      const meterName = doc.meterName || doc.meter_name || doc.meterId || '-';
      const key = `${dateStr}_${building}_${floor}_${meterId}`;
      
      if (!groups[key]) {
        groups[key] = {
          date: dateStr,
          building,
          floor,
          meterId,
          meterName,
          minEnergy: doc.energy_active || 0,
          maxEnergy: doc.energy_active || 0,
          peak: 0,
          pfSum: 0,
          pfCount: 0
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
        date: g.date,
        building: g.building,
        floor: g.floor,
        meterId: g.meterId,
        meterName: g.meterName,
        energy: (diffEnergy > 0 ? diffEnergy : g.maxEnergy).toFixed(4),
        peak: g.peak.toFixed(2),
        pf: (g.pfCount > 0 ? g.pfSum / g.pfCount : 0).toFixed(2)
      };
    });
    
    res.json(historyList);
  } catch (err) {
    console.error('[MongoDB] Fetch history failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch history from MongoDB' });
  }
});

let memoryConfigCache = null;

app.get(['/api/config', '/config'], async (req, res) => {
  try {
    const db = await connectToMongo();
    if (db) {
      const doc = await db.collection('config').findOne({ id: 'global_config' });
      if (doc) return res.json(doc);
    }
  } catch (e) {
    console.error('[MongoDB Config Fetch Error]', e.message);
  }
  res.json(memoryConfigCache || {});
});

app.post(['/api/config', '/config'], async (req, res) => {
  const { buildings, meters } = req.body || {};
  const docToSave = { id: 'global_config', buildings: buildings || {}, meters: meters || [], updatedAt: new Date() };
  memoryConfigCache = docToSave;
  try {
    const db = await connectToMongo();
    if (!db) {
      return res.status(500).json({ status: 'ERROR', message: mongoConnectError || 'Could not connect to MongoDB Atlas' });
    }
    const result = await db.collection('config').replaceOne(
      { id: 'global_config' },
      docToSave,
      { upsert: true }
    );
    console.log('[MongoDB Config] Successfully saved global_config to Atlas:', result.upsertedCount || result.modifiedCount);
    return res.json({ status: 'SUCCESS', config: memoryConfigCache, upsertedCount: result.upsertedCount || result.modifiedCount });
  } catch (e) {
    console.error('[MongoDB Config Save Error]', e.message);
    return res.status(500).json({ status: 'ERROR', error: e.message });
  }
});

// Serve static frontend build files from dist directory
app.use(express.static(path.join(__dirname, 'dist')));

app.get(/.*/, (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`[IoT Energy Monitor Server] Running on http://localhost:${PORT}`);
  console.log(`[ESP32 Hardware Ingest URL] POST http://localhost:${PORT}/api/telemetry/esp32`);
});

export default app;
