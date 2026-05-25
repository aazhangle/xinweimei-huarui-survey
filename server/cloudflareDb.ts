export type FollowUpStatus = "pending" | "contacted" | "strong_intent" | "not_suitable";

export type D1PreparedStatementLike = {
  bind: (...values: unknown[]) => D1PreparedStatementLike;
  first: <T = Record<string, unknown>>() => Promise<T | null>;
  all: <T = Record<string, unknown>>() => Promise<{ results?: T[] }>;
  run: () => Promise<{ meta?: { last_row_id?: number | string } }>;
};

export type D1DatabaseLike = {
  prepare: (query: string) => D1PreparedStatementLike;
};

export type SurveyRow = {
  id: number;
  institutionName: string;
  institutionCity: string | null;
  contactName: string | null;
  contactPhone: string | null;
  liaison: string | null;
  fillDate: string | null;
  answers: Record<string, unknown>;
  submittedAt: string;
  followUpStatus: FollowUpStatus;
  followUpNote: string | null;
};

type SurveyDbRow = Omit<SurveyRow, "answers"> & { answers: string | null };

let initialized = false;

const INIT_SQL = [
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    openId TEXT NOT NULL UNIQUE,
    name TEXT,
    email TEXT,
    loginMethod TEXT,
    role TEXT NOT NULL DEFAULT 'user',
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
    lastSignedIn TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS surveys (
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
  )`,
  `CREATE TABLE IF NOT EXISTS adminCredentials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    passwordHash TEXT NOT NULL,
    createdAt TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS surveyConfig (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    configKey TEXT NOT NULL UNIQUE,
    configValue TEXT NOT NULL,
    updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_surveys_city ON surveys(institutionCity)`,
  `CREATE INDEX IF NOT EXISTS idx_surveys_submittedAt ON surveys(submittedAt)`,
];

export async function ensureDatabase(db: D1DatabaseLike) {
  if (initialized) return;
  for (const stmt of INIT_SQL) {
    await db.prepare(stmt).run();
  }
  initialized = true;
}

function parseJson(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeSurvey(row: SurveyDbRow): SurveyRow {
  return {
    ...row,
    id: Number(row.id),
    answers: parseJson(row.answers),
    followUpStatus: (row.followUpStatus || "pending") as FollowUpStatus,
  };
}

export async function createSurvey(
  db: D1DatabaseLike,
  data: {
    institutionName: string;
    institutionCity?: string;
    contactName?: string;
    contactPhone?: string;
    liaison?: string;
    fillDate?: string;
    answers: Record<string, unknown>;
  }
): Promise<number> {
  await ensureDatabase(db);
  const submittedAt = new Date().toISOString();
  const result = await db
    .prepare(
      `INSERT INTO surveys (
        institutionName, institutionCity, contactName, contactPhone, liaison, fillDate, answers, submittedAt, followUpStatus
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`
    )
    .bind(
      data.institutionName,
      data.institutionCity ?? null,
      data.contactName ?? null,
      data.contactPhone ?? null,
      data.liaison ?? null,
      data.fillDate ?? null,
      JSON.stringify(data.answers ?? {}),
      submittedAt
    )
    .run();
  return Number(result.meta?.last_row_id ?? 0);
}

export async function listSurveys(
  db: D1DatabaseLike,
  opts: {
    keyword?: string;
    city?: string;
    startDate?: Date;
    endDate?: Date;
    limit?: number;
    offset?: number;
  }
): Promise<{ rows: Omit<SurveyRow, "answers">[]; total: number }> {
  await ensureDatabase(db);
  const where: string[] = [];
  const values: unknown[] = [];

  if (opts.keyword) {
    const kw = `%${opts.keyword}%`;
    where.push(`(institutionName LIKE ? OR contactName LIKE ? OR contactPhone LIKE ? OR liaison LIKE ?)`);
    values.push(kw, kw, kw, kw);
  }
  if (opts.city) {
    where.push(`institutionCity LIKE ?`);
    values.push(`%${opts.city}%`);
  }
  if (opts.startDate) {
    where.push(`submittedAt >= ?`);
    values.push(opts.startDate.toISOString());
  }
  if (opts.endDate) {
    where.push(`submittedAt <= ?`);
    values.push(opts.endDate.toISOString());
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const limit = opts.limit ?? 20;
  const offset = opts.offset ?? 0;

  const countRow = await db
    .prepare(`SELECT COUNT(*) AS count FROM surveys ${whereSql}`)
    .bind(...values)
    .first<{ count: number }>();

  const result = await db
    .prepare(
      `SELECT id, institutionName, institutionCity, contactName, contactPhone, liaison, fillDate,
              submittedAt, followUpStatus, followUpNote
       FROM surveys ${whereSql}
       ORDER BY submittedAt DESC
       LIMIT ? OFFSET ?`
    )
    .bind(...values, limit, offset)
    .all<Omit<SurveyRow, "answers">>();

  return {
    rows: (result.results ?? []).map((row) => ({ ...row, id: Number(row.id), followUpStatus: (row.followUpStatus || "pending") as FollowUpStatus })),
    total: Number(countRow?.count ?? 0),
  };
}

export async function getSurveyById(db: D1DatabaseLike, id: number): Promise<SurveyRow | null> {
  await ensureDatabase(db);
  const row = await db.prepare(`SELECT * FROM surveys WHERE id = ? LIMIT 1`).bind(id).first<SurveyDbRow>();
  return row ? normalizeSurvey(row) : null;
}

export async function getAllSurveysFull(db: D1DatabaseLike): Promise<SurveyRow[]> {
  await ensureDatabase(db);
  const result = await db.prepare(`SELECT * FROM surveys ORDER BY submittedAt DESC`).all<SurveyDbRow>();
  return (result.results ?? []).map(normalizeSurvey);
}

export async function getSurveyStats(db: D1DatabaseLike) {
  await ensureDatabase(db);
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const total = await db.prepare(`SELECT COUNT(*) AS count FROM surveys`).first<{ count: number }>();
  const thisWeek = await db.prepare(`SELECT COUNT(*) AS count FROM surveys WHERE submittedAt >= ?`).bind(weekAgo).first<{ count: number }>();
  const thisMonth = await db.prepare(`SELECT COUNT(*) AS count FROM surveys WHERE submittedAt >= ?`).bind(monthAgo).first<{ count: number }>();
  return {
    total: Number(total?.count ?? 0),
    thisWeek: Number(thisWeek?.count ?? 0),
    thisMonth: Number(thisMonth?.count ?? 0),
  };
}

export async function getCityStats(db: D1DatabaseLike): Promise<{ city: string; count: number }[]> {
  await ensureDatabase(db);
  const result = await db
    .prepare(
      `SELECT institutionCity AS city, COUNT(*) AS count
       FROM surveys
       WHERE institutionCity IS NOT NULL AND institutionCity != ''
       GROUP BY institutionCity
       ORDER BY count DESC`
    )
    .all<{ city: string; count: number }>();
  return (result.results ?? []).filter((r) => r.city).map((r) => ({ city: r.city, count: Number(r.count) }));
}

export async function updateFollowUpStatus(
  db: D1DatabaseLike,
  id: number,
  status: FollowUpStatus,
  note?: string
): Promise<void> {
  await ensureDatabase(db);
  await db
    .prepare(`UPDATE surveys SET followUpStatus = ?, followUpNote = COALESCE(?, followUpNote) WHERE id = ?`)
    .bind(status, note ?? null, id)
    .run();
}

export async function adminExists(db: D1DatabaseLike): Promise<boolean> {
  await ensureDatabase(db);
  const row = await db.prepare(`SELECT COUNT(*) AS count FROM adminCredentials`).first<{ count: number }>();
  return Number(row?.count ?? 0) > 0;
}

export async function getAdminByUsername(db: D1DatabaseLike, username: string): Promise<{ username: string; passwordHash: string } | null> {
  await ensureDatabase(db);
  return await db
    .prepare(`SELECT username, passwordHash FROM adminCredentials WHERE username = ? LIMIT 1`)
    .bind(username)
    .first<{ username: string; passwordHash: string }>();
}

export async function createAdmin(db: D1DatabaseLike, username: string, passwordHash: string): Promise<void> {
  await ensureDatabase(db);
  await db.prepare(`INSERT INTO adminCredentials (username, passwordHash) VALUES (?, ?)`).bind(username, passwordHash).run();
}

export async function getSurveyConfig(db: D1DatabaseLike, key: string): Promise<unknown | null> {
  await ensureDatabase(db);
  const row = await db
    .prepare(`SELECT configValue FROM surveyConfig WHERE configKey = ? LIMIT 1`)
    .bind(key)
    .first<{ configValue: string }>();
  if (!row?.configValue) return null;
  try {
    return JSON.parse(row.configValue);
  } catch {
    return null;
  }
}

export async function setSurveyConfig(db: D1DatabaseLike, key: string, value: unknown): Promise<void> {
  await ensureDatabase(db);
  await db
    .prepare(
      `INSERT INTO surveyConfig (configKey, configValue, updatedAt)
       VALUES (?, ?, ?)
       ON CONFLICT(configKey) DO UPDATE SET configValue = excluded.configValue, updatedAt = excluded.updatedAt`
    )
    .bind(key, JSON.stringify(value), new Date().toISOString())
    .run();
}
