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
const DEMO_DEPARTMENT_EMAIL = process.env.SAMADHAN_DEMO_DEPARTMENT_EMAIL || 'department@samadhanai.com';
const DEMO_DEPARTMENT_PASSWORD = process.env.SAMADHAN_DEMO_DEPARTMENT_PASSWORD || 'Dept@123';
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
    password_hash TEXT NOT NULL
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
    updated_by_role TEXT
  );
  CREATE INDEX IF NOT EXISTS complaints_owner_email_idx ON complaints(owner_email);
  CREATE INDEX IF NOT EXISTS complaints_department_idx ON complaints(department);
`);

const insertUser = database.prepare(`
  INSERT OR IGNORE INTO users (email, name, phone, role, department, salt, password_hash)
  VALUES (@email, @name, @phone, @role, @department, @salt, @passwordHash)
`);

function userFromRow(row) {
  if (!row) return null;
  return {
    name: row.name,
    email: row.email,
    phone: row.phone || '',
    role: row.role,
    department: row.department || '',
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
    category, department, priority, status, created_at, updated_at, updated_by_role
  ) VALUES (
    @id, @name, @email, @ownerEmail, @phone, @location, @title, @description, @photo,
    @category, @department, @priority, @status, @createdAt, @updatedAt, @updatedByRole
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
  });
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
  };
}

async function ensureDepartmentAccount() {
  const email = (process.env.SAMADHAN_DEPARTMENT_EMAIL || 'department@samadhanai.local').trim().toLowerCase();
  const department = process.env.SAMADHAN_DEPARTMENT_NAME || 'Municipal Corporation';
  let account = userFromRow(database.prepare('SELECT * FROM users WHERE role = ? LIMIT 1').get('department'));
  const configuredPassword = process.env.SAMADHAN_DEPARTMENT_PASSWORD;

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

const departmentRules = [
  { department: 'Municipal Corporation', keywords: ['street light', 'garbage', 'drain', 'sewer', 'water logging',  'cleaning', 'waste', 'public hygiene'] },
  { department: 'Electricity Department', keywords: ['electricity', 'power', 'transformer', 'light', 'streetlight', 'wire', 'breaker', 'power cut'] },
  { department: 'Water Supply Department', keywords: ['water supply', 'tap', 'pipeline', 'leak', 'water', 'drainage', 'pipe'] },
  { department: 'Traffic Police', keywords: ['traffic', 'signal', 'accident', 'parking', 'roadblock', 'junction', 'crossing'] },
  { department: 'Health Department', keywords: ['hospital', 'clinic', 'medicine', 'sanitation', 'health', 'mosquito', 'medical'] },
  { department: 'Public Works Department', keywords: ['road', 'pothole', 'bridge'] },
];


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

function createComplaintId() {
  return `CMP-${++complaintSequence}`;
}

function updateComplaintStatus(req, res, complaint, status) {
  const allowedStatuses = ['Submitted', 'Pending', 'In Progress', 'Resolved'];
  if (!allowedStatuses.includes(status)) {
    return res.status(400).json({ message: 'Choose a valid complaint status.' });
  }
  const updatedAt = new Date().toISOString();
  database.prepare(`
    UPDATE complaints SET status = ?, updated_at = ?, updated_by_role = ? WHERE id = ?
  `).run(status, updatedAt, req.user.role, complaint.id);
  res.json({ message: 'Complaint status updated successfully.', complaint: findComplaintById(complaint.id) });
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
    const password = String(req.body.password || '');
    if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 8) {
      return res.status(400).json({ success: false, message: 'Enter your name, a valid email, and a password with at least 8 characters.' });
    }
    if (findUserByEmail(email)) {
      return res.status(409).json({ success: false, message: 'An account with that email already exists.' });
    }

    const credentials = await hashPassword(password);
    const user = {
      name,
      email,
      phone: String(req.body.phone || '').trim(),
      role: 'citizen',
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
    if (!user || !(await verifyPassword(password, user))) {
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

app.post('/api/department/login', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (email !== DEMO_DEPARTMENT_EMAIL.toLowerCase() || password !== DEMO_DEPARTMENT_PASSWORD) {
    return res.status(401).json({ success: false, message: 'Email or password is incorrect.' });
  }

  const account = userFromRow(database.prepare('SELECT * FROM users WHERE role = ? LIMIT 1').get('department'));
  if (!account) {
    return res.status(503).json({ success: false, message: 'Department account is not available.' });
  }

  const token = crypto.randomBytes(32).toString('base64url');
  sessions.set(token, { email: account.email, expiresAt: Date.now() + SESSION_TTL_MS });
  setSessionCookie(res, token);
  res.status(200).json({ success: true, user: publicUser(account) });
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

app.post('/api/complaints', requireRole('citizen'), (req, res) => {
  const { title, description, photo } = req.body;
  if (!String(title || '').trim() || !String(description || '').trim()) {
    return res.status(400).json({ message: 'Complaint title and description are required.' });
  }
  if (photo && (!/^data:image\/(?:png|jpeg|webp|gif);base64,/i.test(photo) || photo.length > 7_000_000)) {
    return res.status(400).json({ message: 'Choose a supported image smaller than 5 MB.' });
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
    category: 'General Grievance',
    department: detectDepartment(title, description),
    priority: detectPriority(title, description),
    status: 'Submitted',
    createdAt: new Date().toISOString(),
  };
  saveComplaint(newComplaint);
  res.status(201).json({ message: 'Complaint submitted successfully.', complaint: newComplaint });
});

app.put('/api/complaints/:id/status', requireRole('department'), (req, res) => {
  const complaint = findComplaintById(req.params.id);
  if (!complaint) {
    return res.status(404).json({ message: 'Complaint not found.' });
  }
  if (!canAccessComplaint(req.user, complaint)) {
    return res.status(403).json({ message: 'This complaint is assigned to another department.' });
  }
  return updateComplaintStatus(req, res, complaint, req.body.status);
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
  return updateComplaintStatus(req, res, complaint, req.body.status || req.query.status);
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

async function startServer() {
  migrateLegacyUsers();
  await ensureDepartmentAccount();
  initializeComplaints();
  app.listen(PORT, () => {
    console.log(`SamadhanAI backend is running on http://localhost:${PORT}`);
  });
}

startServer().catch((error) => {
  console.error('Unable to start SamadhanAI:', error);
  process.exitCode = 1;
});
