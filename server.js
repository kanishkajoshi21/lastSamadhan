require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const { promisify } = require('util');

const app = express();
const PORT = process.env.PORT || 5000;
const AUTH_DATA_DIRECTORY = process.env.SAMADHAN_AUTH_DIRECTORY || path.join(__dirname, '.samadhan-auth');
const LEGACY_USERS_FILE = path.join(AUTH_DATA_DIRECTORY, 'users.json');
const DATABASE_FILE = process.env.SAMADHAN_DATABASE_PATH || path.join(AUTH_DATA_DIRECTORY, 'samadhan.sqlite');
const SESSION_COOKIE = 'samadhan_session';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const DEMO_DEPARTMENT_EMAIL = process.env.SAMADHAN_DEPARTMENT_EMAIL || process.env.SAMADHAN_DEMO_DEPARTMENT_EMAIL || 'department@samadhanai.com';
const DEMO_DEPARTMENT_PASSWORD = process.env.SAMADHAN_DEPARTMENT_PASSWORD || process.env.SAMADHAN_DEMO_DEPARTMENT_PASSWORD || 'Dept@123';
const scrypt = promisify(crypto.scrypt);
const sessions = new Map();
const isProduction = process.env.NODE_ENV === 'production';

app.disable('x-powered-by');
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '8mb' }));

fs.mkdirSync(path.dirname(DATABASE_FILE), { recursive: true, mode: 0o700 });
const database = new Database(DATABASE_FILE);
database.pragma('journal_mode = WAL');
database.pragma('foreign_keys = ON');
database.exec(`
  CREATE TABLE IF NOT EXISTS users (
    email TEXT PRIMARY KEY COLLATE NOCASE,
    name TEXT NOT NULL,
    phone TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL CHECK (role IN ('citizen', 'department')),
    department TEXT NOT NULL DEFAULT '',
    salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    email_verified INTEGER NOT NULL DEFAULT 0,
    phone_verified INTEGER NOT NULL DEFAULT 0,
    account_status TEXT NOT NULL DEFAULT 'active',
    account_status_reason TEXT NOT NULL DEFAULT '',
    account_status_updated_at TEXT
  );
  CREATE TABLE IF NOT EXISTS complaints (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    owner_email TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    location TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    photo TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL,
    department TEXT NOT NULL,
    priority TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT,
    updated_by_role TEXT,
    verification_status TEXT NOT NULL DEFAULT 'under_verification',
    verification_summary TEXT NOT NULL DEFAULT '',
    verification_data TEXT NOT NULL DEFAULT '{}',
    latitude REAL,
    longitude REAL
  );
  CREATE TABLE IF NOT EXISTS complaint_status_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    complaint_id TEXT NOT NULL,
    old_status TEXT,
    new_status TEXT NOT NULL,
    changed_by TEXT NOT NULL,
    changed_by_role TEXT NOT NULL CHECK (changed_by_role IN ('citizen', 'department')),
    timestamp TEXT NOT NULL,
    remarks TEXT NOT NULL DEFAULT '',
    FOREIGN KEY (complaint_id) REFERENCES complaints(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS complaint_verification_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    complaint_id TEXT NOT NULL,
    actor_email TEXT NOT NULL,
    actor_role TEXT NOT NULL,
    action TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    timestamp TEXT NOT NULL,
    result_json TEXT NOT NULL DEFAULT '{}',
    FOREIGN KEY (complaint_id) REFERENCES complaints(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS complaint_verification_history_idx ON complaint_verification_history(complaint_id, timestamp);
  CREATE TABLE IF NOT EXISTS complaint_evidence (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    complaint_id TEXT NOT NULL,
    submitted_by TEXT NOT NULL,
    evidence_text TEXT NOT NULL DEFAULT '',
    photo TEXT NOT NULL DEFAULT '',
    timestamp TEXT NOT NULL,
    FOREIGN KEY (complaint_id) REFERENCES complaints(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS complaint_evidence_idx ON complaint_evidence(complaint_id, timestamp);
  CREATE TABLE IF NOT EXISTS user_restriction_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_email TEXT NOT NULL COLLATE NOCASE,
    actor_email TEXT NOT NULL,
    actor_role TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('warn', 'restrict', 'block', 'unrestrict', 'unblock')),
    reason TEXT NOT NULL,
    timestamp TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS user_restriction_history_idx ON user_restriction_history(user_email, timestamp);
  CREATE INDEX IF NOT EXISTS complaints_owner_email_idx ON complaints(owner_email);
  CREATE INDEX IF NOT EXISTS complaints_department_idx ON complaints(department);
  CREATE INDEX IF NOT EXISTS complaint_status_history_complaint_idx ON complaint_status_history(complaint_id, timestamp);
`);

function ensureColumn(tableName, columnName, definition) {
  const columns = database.prepare(`PRAGMA table_info(${tableName})`).all();
  if (!columns.some((column) => column.name === columnName)) {
    database.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

ensureColumn('users', 'email_verified', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('users', 'phone_verified', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('users', 'account_status', "TEXT NOT NULL DEFAULT 'active'");
ensureColumn('users', 'account_status_reason', "TEXT NOT NULL DEFAULT ''");
ensureColumn('users', 'account_status_updated_at', 'TEXT');
ensureColumn('complaints', 'verification_status', "TEXT NOT NULL DEFAULT 'under_verification'");
ensureColumn('complaints', 'verification_summary', "TEXT NOT NULL DEFAULT ''");
ensureColumn('complaints', 'verification_data', "TEXT NOT NULL DEFAULT '{}'");
ensureColumn('complaints', 'latitude', 'REAL');
ensureColumn('complaints', 'longitude', 'REAL');

const insertUser = database.prepare(`
  INSERT OR IGNORE INTO users (
    email, name, phone, role, department, salt, password_hash,
    email_verified, phone_verified, account_status
  ) VALUES (
    @email, @name, @phone, @role, @department, @salt, @passwordHash,
    @emailVerified, @phoneVerified, @accountStatus
  )
`);

function userFromRow(row) {
  if (!row) return null;
  return {
    name: row.name,
    email: row.email,
    phone: row.phone || '',
    role: row.role,
    department: row.department || '',
    emailVerified: Boolean(row.email_verified),
    phoneVerified: Boolean(row.phone_verified),
    accountStatus: row.account_status || 'active',
    accountStatusReason: row.account_status_reason || '',
    salt: row.salt,
    passwordHash: row.password_hash,
  };
}

function findUserByEmail(email) {
  return userFromRow(database.prepare('SELECT * FROM users WHERE email = ?').get(email));
}

function saveUser(user) {
  insertUser.run({
    ...user,
    phone: user.phone || '',
    department: user.department || '',
    emailVerified: user.emailVerified ? 1 : 0,
    phoneVerified: user.phoneVerified ? 1 : 0,
    accountStatus: user.accountStatus || 'active',
  });
}

function migrateLegacyUsers() {
  if (!fs.existsSync(LEGACY_USERS_FILE)) return;

  const legacyUsers = JSON.parse(fs.readFileSync(LEGACY_USERS_FILE, 'utf8'));
  if (!Array.isArray(legacyUsers)) {
    throw new Error('Authentication user store must contain a JSON array.');
  }
  const importUsers = database.transaction((records) => {
    records.forEach((user) => saveUser(user));
  });
  importUsers(legacyUsers);
}

const insertComplaint = database.prepare(`
  INSERT INTO complaints (
    id, name, email, owner_email, phone, location, title, description, photo,
    category, department, priority, status, created_at, updated_at, updated_by_role,
    verification_status, verification_summary, verification_data, latitude, longitude
  ) VALUES (
    @id, @name, @email, @ownerEmail, @phone, @location, @title, @description, @photo,
    @category, @department, @priority, @status, @createdAt, @updatedAt, @updatedByRole,
    @verificationStatus, @verificationSummary, @verificationData, @latitude, @longitude
  )
`);

function saveComplaint(complaint) {
  insertComplaint.run({
    ...complaint,
    ownerEmail: complaint.ownerEmail || '',
    phone: complaint.phone || '',
    photo: complaint.photo || '',
    updatedAt: complaint.updatedAt || null,
    updatedByRole: complaint.updatedByRole || null,
    verificationStatus: complaint.verificationStatus || 'under_verification',
    verificationSummary: complaint.verificationSummary || '',
    verificationData: JSON.stringify(complaint.verificationData || {}),
    latitude: complaint.latitude ?? null,
    longitude: complaint.longitude ?? null,
  });

  const complaintStatus = normalizeComplaintStatus(complaint.status || 'Submitted');
  recordComplaintStatusChange(
    complaint.id,
    null,
    complaintStatus,
    complaint.ownerEmail || complaint.email || 'system',
    'citizen',
    complaintStatus === 'Submitted' ? 'Complaint submitted by citizen.' : 'Complaint record created.'
  );
}

function complaintFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    ownerEmail: row.owner_email,
    phone: row.phone,
    location: row.location,
    title: row.title,
    description: row.description,
    photo: row.photo,
    category: row.category,
    department: row.department,
    priority: row.priority,
    status: row.status,
    createdAt: row.created_at,
    ...(row.updated_at ? { updatedAt: row.updated_at } : {}),
    ...(row.updated_by_role ? { updatedByRole: row.updated_by_role } : {}),
    verificationStatus: row.verification_status || 'under_verification',
    verificationSummary: row.verification_summary || '',
    verification: (() => {
      try { return JSON.parse(row.verification_data || '{}'); } catch { return {}; }
    })(),
    ...(Number.isFinite(row.latitude) ? { latitude: row.latitude } : {}),
    ...(Number.isFinite(row.longitude) ? { longitude: row.longitude } : {}),
  };
}

function findComplaintById(id) {
  return complaintFromRow(database.prepare('SELECT * FROM complaints WHERE id = ?').get(id));
}

function listComplaints() {
  return database.prepare('SELECT * FROM complaints ORDER BY created_at DESC, rowid DESC')
    .all().map(complaintFromRow);
}

async function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const derivedKey = await scrypt(password, salt, 64);
  return { salt, passwordHash: derivedKey.toString('hex') };
}

async function verifyPassword(password, user) {
  const derivedKey = await scrypt(password, user.salt, 64);
  const expected = Buffer.from(user.passwordHash, 'hex');
  return expected.length === derivedKey.length && crypto.timingSafeEqual(expected, derivedKey);
}

function publicUser(user) {
  return {
    name: user.name,
    email: user.email,
    phone: user.phone || '',
    role: user.role,
    department: user.department || '',
    accountStatus: user.accountStatus || 'active',
  };
}

function isValidGmail(email) {
  return /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@gmail\.com$/i.test(email);
}

function isValidPhone(phone) {
  return /^\+[1-9]\d{7,14}$/.test(phone);
}

function verificationAudit(complaintId, actor, action, reason = '', result = {}) {
  database.prepare(`
    INSERT INTO complaint_verification_history (
      complaint_id, actor_email, actor_role, action, reason, timestamp, result_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    complaintId,
    actor.email,
    actor.role,
    action,
    String(reason || '').trim(),
    new Date().toISOString(),
    JSON.stringify(result || {})
  );
}

async function ensureDepartmentAccount() {
  if (process.env.SAMADHAN_DEPARTMENT_ACCOUNTS) {
    let configuredAccounts;
    try {
      configuredAccounts = JSON.parse(process.env.SAMADHAN_DEPARTMENT_ACCOUNTS);
    } catch {
      throw new Error('SAMADHAN_DEPARTMENT_ACCOUNTS must be a valid JSON array.');
    }
    if (!Array.isArray(configuredAccounts) || !configuredAccounts.length) {
      throw new Error('SAMADHAN_DEPARTMENT_ACCOUNTS must contain at least one department account.');
    }
    for (const configured of configuredAccounts) {
      const email = String(configured.email || '').trim().toLowerCase();
      const password = String(configured.password || '');
      const department = String(configured.department || '').trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 12 || !departmentNames.includes(department)) {
        throw new Error('Each configured department account needs a valid email, a 12-character password, and a supported department.');
      }
      const credentials = await hashPassword(password);
      const existing = findUserByEmail(email);
      if (existing) {
        database.prepare(`
          UPDATE users SET name = ?, role = 'department', department = ?, salt = ?, password_hash = ?
          WHERE LOWER(email) = LOWER(?)
        `).run(String(configured.name || 'Department Officer'), department, credentials.salt, credentials.passwordHash, email);
      } else {
        saveUser({
          email,
          name: String(configured.name || 'Department Officer'),
          role: 'department',
          department,
          ...credentials,
        });
      }
    }
    return;
  }

  const email = (process.env.SAMADHAN_DEPARTMENT_EMAIL || process.env.SAMADHAN_DEMO_DEPARTMENT_EMAIL || 'department@samadhanai.com').trim().toLowerCase();
  const department = process.env.SAMADHAN_DEPARTMENT_NAME || 'Municipal Corporation';
  const departmentAccounts = database.prepare('SELECT * FROM users WHERE role = ? ORDER BY email').all('department');
  let account = departmentAccounts.find((entry) => entry.email.toLowerCase() === email) || departmentAccounts[0] || null;
  const configuredPassword = process.env.SAMADHAN_DEPARTMENT_PASSWORD || process.env.SAMADHAN_DEMO_DEPARTMENT_PASSWORD;

  if (isProduction && !configuredPassword) {
    throw new Error('SAMADHAN_DEPARTMENT_PASSWORD must be configured in production.');
  }

  if (!account) {
    const password = configuredPassword || crypto.randomBytes(18).toString('base64url');
    account = {
      name: process.env.SAMADHAN_DEPARTMENT_DISPLAY_NAME || 'Department Officer',
      email,
      role: 'department',
      department,
      ...(await hashPassword(password)),
    };
    saveUser(account);

    if (!configuredPassword) {
      console.log(`Local demo department login: ${email} / ${password}`);
      console.log('Set SAMADHAN_DEPARTMENT_PASSWORD to use a stable department password.');
    }
    return;
  }

  const originalEmail = account.email;
  let changed = false;
  if (configuredPassword) {
    Object.assign(account, await hashPassword(configuredPassword));
    changed = true;
  }
  if (account.email !== email) {
    account.email = email;
    changed = true;
  }
  if (account.department !== department) {
    account.department = department;
    changed = true;
  }
  if (changed) {
    database.prepare(`
      UPDATE users SET email = ?, department = ?, salt = ?, password_hash = ?
      WHERE email = ?
    `).run(account.email, account.department, account.salt, account.passwordHash, originalEmail);
  }
}

function readCookie(req, cookieName) {
  const cookieHeader = req.headers.cookie || '';
  const cookie = cookieHeader.split(';').map((part) => part.trim())
    .find((part) => part.startsWith(`${cookieName}=`));
  return cookie ? decodeURIComponent(cookie.slice(cookieName.length + 1)) : '';
}

function sessionUser(req) {
  const token = readCookie(req, SESSION_COOKIE);
  const session = sessions.get(token);
  if (!session) {
    return null;
  }
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  return findUserByEmail(session.email);
}

function requireRole(...roles) {
  return (req, res, next) => {
    const user = sessionUser(req);
    if (!user) {
      return res.status(401).json({ success: false, message: 'Please sign in to continue.' });
    }
    if (!roles.includes(user.role)) {
      return res.status(403).json({ success: false, message: 'Your account is not permitted to access this resource.' });
    }
    if (user.accountStatus === 'blocked') {
      return res.status(403).json({ success: false, message: 'This account is blocked. Contact an administrator.' });
    }
    req.user = user;
    next();
  };
}

function setSessionCookie(res, token) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: isProduction,
    path: '/',
    maxAge: SESSION_TTL_MS,
  });
}

function canAccessComplaint(user, complaint) {
  if (user.role === 'department') {
    return complaint.department === user.department;
  }
  return complaint.ownerEmail === user.email;
}

const seedComplaint = {
  id: 'CMP-1001',
  name: 'Aarav Sharma',
  email: 'aarav@example.com',
  ownerEmail: '',
  phone: '9876543210',
  location: 'Sector 15, Noida',
  title: 'Street light not working',
  description: 'Street light near the main market is broken and causing darkness at night.',
  category: 'Infrastructure',
  department: 'Municipal Corporation',
  priority: 'Medium',
  status: 'Submitted',
  createdAt: new Date().toISOString(),
};
let complaintSequence = 1001;

function initializeComplaints() {
  const count = database.prepare('SELECT COUNT(*) AS count FROM complaints').get().count;
  if (count === 0) saveComplaint(seedComplaint);
  const latestSequence = database.prepare(`
    SELECT MAX(CAST(SUBSTR(id, 5) AS INTEGER)) AS sequence
    FROM complaints WHERE id GLOB 'CMP-[0-9]*'
  `).get().sequence;
  complaintSequence = Math.max(1001, Number(latestSequence) || 0);
}

const VALID_COMPLAINT_STATUSES = [
  'Submitted',
  'Under Verification',
  'Verified',
  'Assigned',
  'In Progress',
  'Resolved',
  'Closed',
  'More Evidence Required',
  'Rejected',
];

const STATUS_TRANSITIONS = {
  Submitted: ['Under Verification'],
  'Under Verification': ['Verified', 'More Evidence Required', 'Rejected'],
  Verified: ['Assigned'],
  'More Evidence Required': ['Under Verification', 'Rejected'],
  Assigned: ['In Progress'],
  'In Progress': ['Resolved'],
  Resolved: ['Closed'],
  Closed: [],
  Rejected: [],
};

const departmentRules = [
  { category: 'Street Light', department: 'Municipal Corporation', keywords: ['street light', 'streetlight', 'lamp post', 'road light'] },
  { category: 'Garbage', department: 'Sanitation Department', keywords: ['garbage', 'waste', 'trash', 'rubbish', 'dump'] },
  { category: 'Water Supply', department: 'Water Department', keywords: ['water supply', 'tap', 'pipeline', 'leak', 'water', 'drainage', 'pipe'] },
  { category: 'Road Damage', department: 'Public Works Department', keywords: ['road', 'pothole', 'bridge', 'pavement'] },
  { category: 'Electricity', department: 'Electricity Department', keywords: ['electricity', 'power', 'transformer', 'wire', 'breaker', 'power cut'] },
  { category: 'Traffic', department: 'Traffic Police', keywords: ['traffic', 'signal', 'accident', 'parking', 'roadblock', 'junction', 'crossing'] },
  { category: 'Public Health', department: 'Health Department', keywords: ['hospital', 'clinic', 'medicine', 'sanitation', 'health', 'mosquito', 'medical'] },
];

const departmentNames = [
  'Municipal Corporation',
  'Sanitation Department',
  'Water Department',
  'Public Works Department',
  'Electricity Department',
  'Traffic Police',
  'Health Department',
];

function normalizeComplaintStatus(status) {
  const nextStatus = String(status || '').trim();
  if (!nextStatus) return 'Submitted';
  const plain = nextStatus.replace(/\s+/g, ' ');
  const aliases = {
    Pending: 'Under Verification',
    'Under Review': 'Under Verification',
    'In progress': 'In Progress',
  };
  const normalized = aliases[plain] || plain;
  return VALID_COMPLAINT_STATUSES.includes(normalized) ? normalized : 'Submitted';
}

function isValidStatusTransition(currentStatus, nextStatus) {
  const current = normalizeComplaintStatus(currentStatus);
  const next = normalizeComplaintStatus(nextStatus);
  if (current === next) {
    return false;
  }
  return STATUS_TRANSITIONS[current]?.includes(next) || false;
}

function complaintHistoryFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    complaintId: row.complaint_id,
    oldStatus: row.old_status,
    newStatus: row.new_status,
    changedBy: row.changed_by,
    changedByRole: row.changed_by_role,
    timestamp: row.timestamp,
    remarks: row.remarks || '',
  };
}

function getComplaintStatusHistory(complaintId) {
  return database.prepare(`
    SELECT * FROM complaint_status_history
    WHERE complaint_id = ?
    ORDER BY timestamp ASC, id ASC
  `).all(complaintId).map(complaintHistoryFromRow);
}

function recordComplaintStatusChange(complaintId, oldStatus, newStatus, changedBy, changedByRole, remarks = '') {
  const entry = database.prepare(`
    INSERT INTO complaint_status_history (
      complaint_id, old_status, new_status, changed_by, changed_by_role, timestamp, remarks
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    complaintId,
    oldStatus ? normalizeComplaintStatus(oldStatus) : null,
    normalizeComplaintStatus(newStatus),
    changedBy,
    changedByRole,
    new Date().toISOString(),
    String(remarks || '').trim()
  );

  return database.prepare('SELECT * FROM complaint_status_history WHERE id = ?').get(entry.lastInsertRowid);
}

function detectComplaintCategory(title, description) {
  const combinedText = `${title} ${description}`.toLowerCase();
  const matchingRule = departmentRules.find((rule) => rule.keywords.some((keyword) => combinedText.includes(keyword)));
  return matchingRule ? matchingRule.category : 'General Civic Issue';
}

function detectDepartment(title, description) {
  const combinedText = `${title} ${description}`.toLowerCase();
  const matchingRule = departmentRules.find((rule) => rule.keywords.some((keyword) => combinedText.includes(keyword)));
  return matchingRule ? matchingRule.department : 'Public Works Department';
}

function detectPriority(title, description) {
  const combinedText = `${title} ${description}`.toLowerCase();
  if (/(urgent|emergency|danger|flood|broken pipe|power cut|accident|medical)/i.test(combinedText)) {
    return 'High';
  }
  if (/(not working|delay|issue|light|water|road|drain)/i.test(combinedText)) {
    return 'Medium';
  }
  return 'Low';
}

function findNearbyComplaintMatches(complaint) {
  if (!Number.isFinite(complaint.latitude) || !Number.isFinite(complaint.longitude)) return [];
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const candidates = database.prepare(`
    SELECT id, title, category, latitude, longitude FROM complaints
    WHERE created_at >= ? AND id != ? AND latitude IS NOT NULL AND longitude IS NOT NULL
  `).all(since, complaint.id);
  return candidates.map((candidate) => {
    const latitudeDelta = (candidate.latitude - complaint.latitude) * Math.PI / 180;
    const longitudeDelta = (candidate.longitude - complaint.longitude) * Math.PI / 180;
    const a = Math.sin(latitudeDelta / 2) ** 2
      + Math.cos(complaint.latitude * Math.PI / 180)
      * Math.cos(candidate.latitude * Math.PI / 180)
      * Math.sin(longitudeDelta / 2) ** 2;
    const distanceMeters = 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return { id: candidate.id, title: candidate.title, category: candidate.category, distanceMeters: Math.round(distanceMeters) };
  }).filter((candidate) => candidate.distanceMeters <= 150).slice(0, 10);
}

async function analyzeComplaintWithGemini(complaint) {
  const nearbyMatches = findNearbyComplaintMatches(complaint);
  const fallback = {
    provider: 'gemini',
    analysisStatus: 'unavailable',
    category: detectComplaintCategory(complaint.title, complaint.description),
    priority: detectPriority(complaint.title, complaint.description),
    department: detectDepartment(complaint.title, complaint.description),
    assessment: 'unclear',
    photoMatch: complaint.photo ? 'unclear' : 'no_photo',
    possibleDuplicate: nearbyMatches.length > 0,
    nearbyMatches,
    rationale: 'Automated analysis is unavailable. A department reviewer must assess this complaint.',
  };
  const apiKey = process.env.GEMINI_API_KEY;

  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const recentTitles = database.prepare(`
    SELECT id, title FROM complaints
    WHERE created_at >= ? AND id != ?
    ORDER BY created_at DESC LIMIT 20
  `).all(since, complaint.id).map((item) => ({ id: item.id, title: item.title }));
  const nearbyReports = [];
  if (Number.isFinite(complaint.latitude) && Number.isFinite(complaint.longitude)) {
    const withCoordinates = database.prepare(`
      SELECT id, title, category, latitude, longitude FROM complaints
      WHERE latitude IS NOT NULL AND longitude IS NOT NULL AND id != ?
      ORDER BY created_at DESC LIMIT 500
    `).all(complaint.id);
    for (const item of withCoordinates) {
      const lat1 = complaint.latitude * Math.PI / 180;
      const lat2 = item.latitude * Math.PI / 180;
      const deltaLat = (item.latitude - complaint.latitude) * Math.PI / 180;
      const deltaLon = (item.longitude - complaint.longitude) * Math.PI / 180;
      const haversine = Math.sin(deltaLat / 2) ** 2
        + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
      const distanceMeters = 6371000 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
      if (distanceMeters <= 250) nearbyReports.push({
        id: item.id,
        title: item.title,
        category: item.category,
        distanceMeters: Math.round(distanceMeters),
      });
    }
  }
  fallback.nearbyReports = nearbyReports;
  if (!apiKey) return fallback;
  const prompt = [
    'Review this civic complaint as an assistant for a human verifier. Do not make a final accept/reject decision.',
    'Return only JSON with keys category, priority (Low|Medium|High), department, assessment (genuine|suspicious|unclear), photoMatch (matches|mismatch|unclear|no_photo), possibleDuplicate (boolean), rationale (brief).',
    'A missing or unclear image/location is not proof of fraud. Satellite or map data is not available and cannot confirm small street-level issues.',
    `Complaint title: ${complaint.title}`,
    `Description: ${complaint.description}`,
    `Citizen-provided location: ${complaint.location || 'not provided'}`,
    `User-permitted GPS coordinates: ${Number.isFinite(complaint.latitude) ? `${complaint.latitude}, ${complaint.longitude}` : 'not provided'}`,
    `Nearby complaints within 150 metres (supporting signal only, not proof): ${JSON.stringify(nearbyMatches)}`,
    `Nearby reports within 250m based on citizen-permitted GPS, as supporting context only: ${JSON.stringify(nearbyReports)}`,
    `Recent complaint titles for duplicate review: ${JSON.stringify(recentTitles)}`,
  ].join('\n');
  const parts = [{ text: prompt }];
  const photoMatch = String(complaint.photo || '').match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/i);
  if (photoMatch) {
    parts.push({ inline_data: { mime_type: `image/${photoMatch[1].toLowerCase()}`, data: photoMatch[2] } });
  }

  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.1 },
      }),
    });
    if (!response.ok) return fallback;
    const result = await response.json();
    const responseText = result.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('') || '';
    const parsed = JSON.parse(responseText);
    const requestedDepartment = String(parsed.department || '').trim();
    return {
      provider: 'gemini',
      analysisStatus: 'complete',
      category: String(parsed.category || fallback.category).slice(0, 80),
      priority: ['Low', 'Medium', 'High'].includes(parsed.priority) ? parsed.priority : fallback.priority,
      department: departmentNames.includes(requestedDepartment) ? requestedDepartment : fallback.department,
      assessment: ['genuine', 'suspicious', 'unclear'].includes(parsed.assessment) ? parsed.assessment : 'unclear',
      photoMatch: ['matches', 'mismatch', 'unclear', 'no_photo'].includes(parsed.photoMatch) ? parsed.photoMatch : fallback.photoMatch,
      possibleDuplicate: Boolean(parsed.possibleDuplicate || nearbyMatches.length),
      nearbyMatches,
      nearbyReports,
      rationale: String(parsed.rationale || 'Human review is required.').slice(0, 500),
    };
  } catch {
    return fallback;
  }
}

function createComplaintId() {
  return `CMP-${++complaintSequence}`;
}

function writeComplaintStatus(complaint, status, actor, remarks = '') {
  const updatedAt = new Date().toISOString();
  const saveStatusAndHistory = database.transaction(() => {
    database.prepare(`
      UPDATE complaints SET status = ?, updated_at = ?, updated_by_role = ? WHERE id = ?
    `).run(status, updatedAt, actor.role, complaint.id);
    return recordComplaintStatusChange(
      complaint.id,
      complaint.status,
      status,
      actor.email,
      actor.role,
      remarks
    );
  });
  return saveStatusAndHistory();
}

function updateComplaintStatus(req, res, complaint, status, remarks = '') {
  if (!String(status || '').trim()) {
    return res.status(400).json({ message: 'A new complaint status is required.' });
  }
  const nextStatus = normalizeComplaintStatus(status);
  const currentStatus = normalizeComplaintStatus(complaint.status);

  if (!VALID_COMPLAINT_STATUSES.includes(nextStatus)) {
    return res.status(400).json({ message: 'Choose a valid complaint status.' });
  }
  if (!['Assigned', 'In Progress', 'Resolved'].includes(currentStatus)) {
    return res.status(409).json({ message: 'This complaint must be reviewed in the verification panel before routine status updates.' });
  }
  if (!isValidStatusTransition(currentStatus, nextStatus)) {
    return res.status(400).json({
      message: `Invalid status transition from ${currentStatus} to ${nextStatus}.`,
    });
  }

  const history = writeComplaintStatus(complaint, nextStatus, req.user, remarks);

  res.json({
    message: 'Complaint status updated successfully.',
    complaint: findComplaintById(complaint.id),
    history: complaintHistoryFromRow(history),
  });
}

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    message: 'SamadhanAI backend is running successfully.',
    timestamp: new Date().toISOString(),
  });
});

app.post('/api/auth/register', async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const phone = String(req.body.phone || '').replace(/[\s()-]/g, '');
    const password = String(req.body.password || '');
    if (!name || !isValidGmail(email) || !isValidPhone(phone) || password.length < 8) {
      return res.status(400).json({ success: false, message: 'Enter your name, a Gmail address, an international phone number, and a password with at least 8 characters.' });
    }
    if (findUserByEmail(email)) {
      return res.status(409).json({ success: false, message: 'An account with that email already exists.' });
    }

    const credentials = await hashPassword(password);
    const user = {
      name,
      email,
      phone,
      role: 'citizen',
      emailVerified: true,
      phoneVerified: true,
      ...credentials,
    };
    saveUser(user);

    const token = crypto.randomBytes(32).toString('base64url');
    sessions.set(token, { email: user.email, expiresAt: Date.now() + SESSION_TTL_MS });
    setSessionCookie(res, token);
    res.status(201).json({ success: true, user: publicUser(user) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/login', async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const requestedRole = req.body.role;
    if (!['citizen', 'department'].includes(requestedRole)) {
      return res.status(400).json({ success: false, message: 'Choose Citizen or Department sign in.' });
    }
    const user = userFromRow(database.prepare('SELECT * FROM users WHERE email = ? AND role = ?').get(email, requestedRole));
    if (!user || user.accountStatus === 'blocked' || !(await verifyPassword(password, user))) {
      return res.status(401).json({ success: false, message: 'Email or password is incorrect.' });
    }

    const token = crypto.randomBytes(32).toString('base64url');
    sessions.set(token, { email: user.email, expiresAt: Date.now() + SESSION_TTL_MS });
    setSessionCookie(res, token);
    res.json({ success: true, user: publicUser(user) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/department/login', async (req, res, next) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  try {
    const account = userFromRow(database.prepare('SELECT * FROM users WHERE email = ? AND role = ?').get(email, 'department'));
    if (!account || account.accountStatus === 'blocked' || !(await verifyPassword(password, account))) {
      return res.status(401).json({ success: false, message: 'Email or password is incorrect.' });
    }
    const token = crypto.randomBytes(32).toString('base64url');
    sessions.set(token, { email: account.email, expiresAt: Date.now() + SESSION_TTL_MS });
    setSessionCookie(res, token);
    res.status(200).json({ success: true, user: publicUser(account) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/logout', (req, res) => {
  const token = readCookie(req, SESSION_COOKIE);
  if (token) {
    sessions.delete(token);
  }
  res.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    sameSite: 'strict',
    secure: isProduction,
    path: '/',
  });
  res.json({ success: true, message: 'Signed out successfully.' });
});

app.get('/api/auth/me', (req, res) => {
  const user = sessionUser(req);
  if (!user) {
    return res.status(401).json({ success: false, message: 'Please sign in to continue.' });
  }
  res.json({ success: true, user: publicUser(user) });
});

app.get('/api/complaints', requireRole('citizen', 'department'), (req, res) => {
  const visibleComplaints = listComplaints().filter((complaint) => canAccessComplaint(req.user, complaint));
  res.json({ total: visibleComplaints.length, complaints: visibleComplaints });
});

app.get('/api/complaints/review', requireRole('department'), (req, res) => {
  const complaints = listComplaints().filter((complaint) => (
    complaint.department === req.user.department
    && ['Under Verification', 'More Evidence Required'].includes(normalizeComplaintStatus(complaint.status))
  ));
  res.json({ total: complaints.length, complaints });
});

app.get('/api/complaints/:id', requireRole('citizen', 'department'), (req, res) => {
  const complaint = findComplaintById(req.params.id);
  if (!complaint) {
    return res.status(404).json({ message: 'Complaint not found.' });
  }
  if (!canAccessComplaint(req.user, complaint)) {
    return res.status(403).json({ message: 'You cannot access this complaint.' });
  }
  res.json({ complaint });
});

app.post('/api/complaints/:id/evidence', requireRole('citizen'), async (req, res, next) => {
  try {
    const complaint = findComplaintById(req.params.id);
    if (!complaint) return res.status(404).json({ message: 'Complaint not found.' });
    if (!canAccessComplaint(req.user, complaint)) return res.status(403).json({ message: 'You cannot update this complaint.' });
    if (complaint.status !== 'More Evidence Required') {
      return res.status(409).json({ message: 'This complaint does not currently need additional evidence.' });
    }
    const evidenceText = String(req.body.evidenceText || '').trim().slice(0, 2000);
    const photo = String(req.body.photo || '');
    if (!evidenceText && !photo) {
      return res.status(400).json({ message: 'Add a note or photo as supporting evidence.' });
    }
    if (photo && (!/^data:image\/(?:png|jpeg|webp|gif);base64,/i.test(photo) || photo.length > 7_000_000)) {
      return res.status(400).json({ message: 'Choose a supported image smaller than 5 MB.' });
    }

    const timestamp = new Date().toISOString();
    database.prepare(`
      INSERT INTO complaint_evidence (complaint_id, submitted_by, evidence_text, photo, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `).run(complaint.id, req.user.email, evidenceText, photo, timestamp);
    database.prepare(`
      UPDATE complaints SET verification_status = 'under_verification', verification_summary = ?, updated_at = ?
      WHERE id = ?
    `).run('Additional evidence submitted. Human review is pending.', timestamp, complaint.id);
    writeComplaintStatus(complaint, 'Under Verification', req.user, 'Citizen submitted additional evidence for review.');
    verificationAudit(complaint.id, req.user, 'evidence_submitted', evidenceText || 'Supporting photo submitted.');

    const analysis = await analyzeComplaintWithGemini({
      ...complaint,
      description: `${complaint.description}\nAdditional evidence: ${evidenceText}`,
      photo: photo || complaint.photo,
    });
    database.prepare(`
      UPDATE complaints SET verification_data = ?, verification_summary = ?, updated_at = ?
      WHERE id = ?
    `).run(JSON.stringify(analysis), analysis.rationale, new Date().toISOString(), complaint.id);
    verificationAudit(complaint.id, { email: 'system', role: 'system' }, 'evidence_reanalyzed', analysis.rationale, analysis);
    res.status(201).json({ message: 'Evidence submitted. Complaint returned to verification.', complaint: findComplaintById(complaint.id) });
  } catch (error) {
    next(error);
  }
});

app.get('/api/complaints/:id/evidence', requireRole('citizen', 'department'), (req, res) => {
  const complaint = findComplaintById(req.params.id);
  if (!complaint) return res.status(404).json({ message: 'Complaint not found.' });
  if (!canAccessComplaint(req.user, complaint)) return res.status(403).json({ message: 'You cannot access this complaint.' });
  const evidence = database.prepare(`
    SELECT evidence_text, photo, timestamp
    FROM complaint_evidence WHERE complaint_id = ? ORDER BY timestamp ASC, id ASC
  `).all(complaint.id);
  res.json({ complaintId: complaint.id, evidence });
});

app.post('/api/complaints/:id/verification', requireRole('department'), (req, res) => {
  const complaint = findComplaintById(req.params.id);
  if (!complaint) return res.status(404).json({ message: 'Complaint not found.' });
  if (!canAccessComplaint(req.user, complaint)) {
    return res.status(403).json({ message: 'This complaint belongs to another department.' });
  }
  const action = String(req.body.action || '').trim();
  const reason = String(req.body.reason || '').trim().slice(0, 1000);
  const allowedActions = ['approve', 'reject', 'request_more_evidence', 'mark_suspicious', 'block_complaint'];
  if (!allowedActions.includes(action) || !reason) {
    return res.status(400).json({ message: 'Choose a verification action and provide a reason.' });
  }
  if (!['Under Verification', 'More Evidence Required'].includes(complaint.status)) {
    return res.status(409).json({ message: 'Only complaints in verification can receive a review decision.' });
  }
  if (action === 'approve' && complaint.status !== 'Under Verification') {
    return res.status(409).json({ message: 'Review the requested evidence before approving this complaint.' });
  }

  const timestamp = new Date().toISOString();
  if (action === 'approve') {
    database.prepare(`
      UPDATE complaints SET verification_status = 'verified', verification_summary = ?, updated_at = ? WHERE id = ?
    `).run(reason, timestamp, complaint.id);
    writeComplaintStatus(complaint, 'Verified', req.user, reason);
    const verifiedComplaint = findComplaintById(complaint.id);
    writeComplaintStatus(verifiedComplaint, 'Assigned', req.user, `Assigned to ${complaint.department} after verification.`);
  } else if (action === 'reject' || action === 'block_complaint') {
    const verificationStatus = action === 'block_complaint' ? 'blocked' : 'rejected';
    database.prepare(`
      UPDATE complaints SET verification_status = ?, verification_summary = ?, updated_at = ? WHERE id = ?
    `).run(verificationStatus, reason, timestamp, complaint.id);
    writeComplaintStatus(complaint, 'Rejected', req.user, reason);
  } else if (action === 'request_more_evidence') {
    database.prepare(`
      UPDATE complaints SET verification_status = 'more_evidence', verification_summary = ?, updated_at = ? WHERE id = ?
    `).run(reason, timestamp, complaint.id);
    if (complaint.status !== 'More Evidence Required') {
      writeComplaintStatus(complaint, 'More Evidence Required', req.user, reason);
    }
  } else {
    database.prepare(`
      UPDATE complaints SET verification_status = 'suspicious', verification_summary = ?, updated_at = ? WHERE id = ?
    `).run(reason, timestamp, complaint.id);
  }

  verificationAudit(complaint.id, req.user, action, reason, { verificationStatus: action });
  res.json({ message: 'Verification decision recorded.', complaint: findComplaintById(complaint.id) });
});

app.get('/api/complaints/:id/verification-history', requireRole('citizen', 'department'), (req, res) => {
  const complaint = findComplaintById(req.params.id);
  if (!complaint) return res.status(404).json({ message: 'Complaint not found.' });
  if (!canAccessComplaint(req.user, complaint)) return res.status(403).json({ message: 'You are not authorized to view this complaint.' });
  const history = database.prepare(`
    SELECT id, actor_role, action, reason, timestamp, result_json
    FROM complaint_verification_history WHERE complaint_id = ? ORDER BY timestamp ASC, id ASC
  `).all(complaint.id).map((row) => ({
    id: row.id,
    actorRole: row.actor_role,
    action: row.action,
    reason: row.reason,
    timestamp: row.timestamp,
    result: (() => { try { return JSON.parse(row.result_json); } catch { return {}; } })(),
  }));
  res.json({ complaintId: complaint.id, history });
});

app.post('/api/users/:email/restriction', requireRole('department'), (req, res) => {
  const userEmail = String(req.params.email || '').trim().toLowerCase();
  const action = String(req.body.action || '').trim();
  const reason = String(req.body.reason || '').trim().slice(0, 1000);
  const allowedActions = ['warn', 'restrict', 'block', 'unrestrict', 'unblock'];
  if (!allowedActions.includes(action) || !reason) {
    return res.status(400).json({ message: 'Choose an account action and provide an audit reason.' });
  }
  const user = findUserByEmail(userEmail);
  if (!user || user.role !== 'citizen') return res.status(404).json({ message: 'Citizen account not found.' });
  const hasAuthorizedComplaint = database.prepare(`
    SELECT 1 FROM complaints WHERE LOWER(owner_email) = LOWER(?) AND department = ? LIMIT 1
  `).get(userEmail, req.user.department);
  if (!hasAuthorizedComplaint) return res.status(403).json({ message: 'You cannot manage this citizen account.' });

  const accountStatus = action === 'block' ? 'blocked'
    : action === 'restrict' ? 'restricted'
      : action === 'unblock' || action === 'unrestrict' ? 'active'
        : user.accountStatus;
  const timestamp = new Date().toISOString();
  database.prepare(`
    UPDATE users SET account_status = ?, account_status_reason = ?, account_status_updated_at = ? WHERE LOWER(email) = LOWER(?)
  `).run(accountStatus, reason, timestamp, userEmail);
  database.prepare(`
    INSERT INTO user_restriction_history (user_email, actor_email, actor_role, action, reason, timestamp)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(userEmail, req.user.email, req.user.role, action, reason, timestamp);
  res.json({ message: 'Account action recorded.', account: { email: userEmail, accountStatus, reason, timestamp } });
});

app.get('/api/users/:email/restriction-history', requireRole('department'), (req, res) => {
  const userEmail = String(req.params.email || '').trim().toLowerCase();
  const authorized = database.prepare(`
    SELECT 1 FROM complaints WHERE LOWER(owner_email) = LOWER(?) AND department = ? LIMIT 1
  `).get(userEmail, req.user.department);
  if (!authorized) return res.status(403).json({ message: 'You cannot view this account audit history.' });
  const history = database.prepare(`
    SELECT action, reason, timestamp, actor_role FROM user_restriction_history
    WHERE LOWER(user_email) = LOWER(?) ORDER BY timestamp ASC, id ASC
  `).all(userEmail);
  res.json({ history });
});

app.post('/api/complaints', requireRole('citizen'), async (req, res, next) => {
 try {
  const { title, description, photo } = req.body;

  if (!String(title || '').trim() || !String(description || '').trim()) {
    return res.status(400).json({ message: 'Complaint title and description are required.' });
  }
  if (req.user.accountStatus === 'restricted') {
    return res.status(403).json({ message: 'Complaint submission is restricted for this account.' });
  }
  if (photo && (!/^data:image\/(?:png|jpeg|webp|gif);base64,/i.test(photo) || photo.length > 7_000_000)) {
    return res.status(400).json({ message: 'Choose a supported image smaller than 5 MB.' });
  }

  const latitude = req.body.latitude === undefined || req.body.latitude === null || req.body.latitude === ''
    ? null
    : Number(req.body.latitude);
  const longitude = req.body.longitude === undefined || req.body.longitude === null || req.body.longitude === ''
    ? null
    : Number(req.body.longitude);
  if ((latitude === null) !== (longitude === null)
    || (latitude !== null && (!Number.isFinite(latitude) || latitude < -90 || latitude > 90))
    || (longitude !== null && (!Number.isFinite(longitude) || longitude < -180 || longitude > 180))) {
    return res.status(400).json({ message: 'Location coordinates are invalid.' });
  }

  const newComplaint = {
    id: createComplaintId(),
    name: req.user.name,
    email: req.user.email,
    ownerEmail: req.user.email,
    phone: req.user.phone,
    location: String(req.body.location || '').trim() || 'Not specified',
    title: String(title).trim(),
    description: String(description).trim(),
    photo: photo || '',
    category: detectComplaintCategory(title, description),
    department: detectDepartment(title, description),
    priority: detectPriority(title, description),
    status: 'Submitted',
    verificationStatus: 'under_verification',
    verificationSummary: '',
    verificationData: {},
    latitude,
    longitude,
    createdAt: new Date().toISOString(),
  };

  const analysis = await analyzeComplaintWithGemini(newComplaint);
  const categoryRule = departmentRules.find((rule) => rule.category.toLowerCase() === analysis.category.toLowerCase());
  newComplaint.category = analysis.category;
  newComplaint.department = categoryRule?.department || detectDepartment(title, description);
  newComplaint.priority = analysis.priority;
  newComplaint.verificationSummary = analysis.rationale;
  newComplaint.verificationData = analysis;

  saveComplaint(newComplaint);
  verificationAudit(newComplaint.id, req.user, 'submitted_for_verification', analysis.rationale, analysis);
  writeComplaintStatus(newComplaint, 'Under Verification', req.user, 'Complaint received and queued for human verification.');
  res.status(201).json({ message: 'Complaint submitted and is under verification.', complaint: findComplaintById(newComplaint.id) });
 } catch (error) {
  next(error);
 }
});

app.put('/api/complaints/:id/status', requireRole('department'), (req, res) => {
  const complaint = findComplaintById(req.params.id);
  if (!complaint) {
    return res.status(404).json({ message: 'Complaint not found.' });
  }
  if (!canAccessComplaint(req.user, complaint)) {
    return res.status(403).json({ message: 'This complaint is assigned to another department.' });
  }
  return updateComplaintStatus(req, res, complaint, req.body.status, req.body.remarks || '');
});

app.get('/api/complaints/:id/history', requireRole('citizen', 'department'), (req, res) => {
  const complaint = findComplaintById(req.params.id);
  if (!complaint) {
    return res.status(404).json({ message: 'Complaint not found.' });
  }
  if (!canAccessComplaint(req.user, complaint)) {
    return res.status(403).json({ message: 'You are not authorized to view this complaint history.' });
  }

  const history = getComplaintStatusHistory(complaint.id);
  res.json({
    complaintId: complaint.id,
    history: history.map((item) => ({
      ...item,
      newStatus: normalizeComplaintStatus(item.newStatus),
      oldStatus: item.oldStatus ? normalizeComplaintStatus(item.oldStatus) : null,
    })),
  });
});

app.put('/api/complaints/:id/department', requireRole('department'), (req, res) => {
  const complaint = findComplaintById(req.params.id);
  const department = String(req.body.department || '').trim();
  if (!complaint) {
    return res.status(404).json({ message: 'Complaint not found.' });
  }
  if (!canAccessComplaint(req.user, complaint)) {
    return res.status(403).json({ message: 'This complaint is assigned to another department.' });
  }
  if (!departmentRules.some((rule) => rule.department === department)) {
    return res.status(400).json({ message: 'Choose a valid department.' });
  }
  const updatedAt = new Date().toISOString();
  database.prepare(`
    UPDATE complaints SET department = ?, updated_at = ?, updated_by_role = ? WHERE id = ?
  `).run(department, updatedAt, req.user.role, complaint.id);
  res.json({ message: 'Complaint forwarded successfully.', complaint: findComplaintById(complaint.id) });
});

app.delete('/api/complaints/:id', requireRole('department'), (req, res) => {
  const complaint = findComplaintById(req.params.id);
  if (!complaint) {
    return res.status(404).json({ message: 'Complaint not found.' });
  }
  if (!canAccessComplaint(req.user, complaint)) {
    return res.status(403).json({ message: 'This complaint is assigned to another department.' });
  }
  database.prepare('DELETE FROM complaints WHERE id = ?').run(complaint.id);
  res.json({ message: 'Complaint deleted successfully.', complaint });
});

app.get('/complaints', requireRole('department'), (req, res) => {
  const visibleComplaints = listComplaints().filter((complaint) => canAccessComplaint(req.user, complaint));
  res.json({ total: visibleComplaints.length, complaints: visibleComplaints });
});

app.get('/complaints/:id', requireRole('department'), (req, res) => {
  const complaint = findComplaintById(req.params.id);
  if (!complaint) {
    return res.status(404).json({ message: 'Complaint not found.' });
  }
  if (!canAccessComplaint(req.user, complaint)) {
    return res.status(403).json({ message: 'You cannot access this complaint.' });
  }
  res.json({ complaint });
});

app.put('/complaints/:id', requireRole('department'), (req, res) => {
  const complaint = findComplaintById(req.params.id);
  if (!complaint) {
    return res.status(404).json({ message: 'Complaint not found.' });
  }
  if (!canAccessComplaint(req.user, complaint)) {
    return res.status(403).json({ message: 'This complaint is assigned to another department.' });
  }
  return updateComplaintStatus(req, res, complaint, req.body.status || req.query.status, req.body.remarks || '');
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get(['/dashboard', '/dashboard.html'], (req, res) => {
  const user = sessionUser(req);
  if (!user) {
    return res.redirect('/login.html?role=department');
  }
  if (user.role !== 'department') {
    return res.status(403).send('Department access only.');
  }
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

app.get(['/citizen-dashboard', '/citizen-dashboard.html'], (req, res) => {
  const user = sessionUser(req);
  if (!user) {
    return res.redirect('/login.html?role=citizen');
  }
  if (user.role !== 'citizen') {
    return res.status(403).send('Citizen access only.');
  }
  res.sendFile(path.join(__dirname, 'citizen-dashboard.html'));
});

app.get('/login.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'login.html'));
});

app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ success: false, message: 'API endpoint not found.' });
  }
  next();
});

app.use(express.static(path.join(__dirname), { index: false }));

app.use((error, req, res, next) => {
  console.error('Request failed:', error.message);
  const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600
    ? error.status
    : 500;
  res.status(status).json({
    success: false,
    message: status === 500 ? 'An internal server error occurred.' : error.message,
  });
});

function migrateComplaintHistory() {
  const complaintsWithoutHistory = database.prepare(`
    SELECT c.*
    FROM complaints c
    LEFT JOIN complaint_status_history h ON h.complaint_id = c.id
    GROUP BY c.id
    HAVING COUNT(h.id) = 0
  `).all();

  const insertHistoryEntry = database.prepare(`
    INSERT INTO complaint_status_history (complaint_id, old_status, new_status, changed_by, changed_by_role, timestamp, remarks)
    VALUES (@complaintId, @oldStatus, @newStatus, @changedBy, @changedByRole, @timestamp, @remarks)
  `);

  complaintsWithoutHistory.forEach((complaint) => {
    const submittedAt = complaint.created_at || new Date().toISOString();
    insertHistoryEntry.run({
      complaintId: complaint.id,
      oldStatus: null,
      newStatus: normalizeComplaintStatus(complaint.status || 'Submitted'),
      changedBy: complaint.owner_email || complaint.email || 'system',
      changedByRole: 'citizen',
      timestamp: submittedAt,
      remarks: 'Complaint submitted by citizen.',
    });
  });
}

async function startServer() {
  migrateLegacyUsers();
  await ensureDepartmentAccount();
  initializeComplaints();
  migrateComplaintHistory();
  app.listen(PORT, () => {
    console.log(`SamadhanAI backend is running on http://localhost:${PORT}`);
  });
}

startServer().catch((error) => {
  console.error('Unable to start SamadhanAI:', error);
  process.exitCode = 1;
});
