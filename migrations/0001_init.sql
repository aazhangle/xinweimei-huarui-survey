CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  openId TEXT NOT NULL UNIQUE,
  name TEXT,
  email TEXT,
  loginMethod TEXT,
  role TEXT NOT NULL DEFAULT 'user',
  createdAt TEXT NOT NULL DEFAULT (datetime('now')),
  updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
  lastSignedIn TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS surveys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  institutionName TEXT NOT NULL,
  institutionCity TEXT,
  contactName TEXT,
  contactPhone TEXT,
  liaison TEXT,
  fillDate TEXT,
  answers TEXT NOT NULL,
  submittedAt TEXT NOT NULL DEFAULT (datetime('now')),
  followUpStatus TEXT NOT NULL DEFAULT 'pending',
  followUpNote TEXT
);

CREATE TABLE IF NOT EXISTS adminCredentials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  passwordHash TEXT NOT NULL,
  createdAt TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS surveyConfig (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  configKey TEXT NOT NULL UNIQUE,
  configValue TEXT NOT NULL,
  updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_surveys_city ON surveys(institutionCity);
CREATE INDEX IF NOT EXISTS idx_surveys_submittedAt ON surveys(submittedAt);
