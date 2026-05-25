import { and, desc, eq, gte, like, lte, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { adminCredentials, InsertUser, surveyConfig, surveys, users } from "../drizzle/schema";
import { ENV } from "./_core/env";

let _db: ReturnType<typeof drizzle> | null = null;

export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}

// ─── Users ───────────────────────────────────────────────────────────────────

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) throw new Error("User openId is required for upsert");
  const db = await getDb();
  if (!db) { console.warn("[Database] Cannot upsert user: database not available"); return; }
  try {
    const values: InsertUser = { openId: user.openId };
    const updateSet: Record<string, unknown> = {};
    const textFields = ["name", "email", "loginMethod"] as const;
    type TextField = (typeof textFields)[number];
    const assignNullable = (field: TextField) => {
      const value = user[field];
      if (value === undefined) return;
      const normalized = value ?? null;
      values[field] = normalized;
      updateSet[field] = normalized;
    };
    textFields.forEach(assignNullable);
    if (user.lastSignedIn !== undefined) { values.lastSignedIn = user.lastSignedIn; updateSet.lastSignedIn = user.lastSignedIn; }
    if (user.role !== undefined) { values.role = user.role; updateSet.role = user.role; }
    else if (user.openId === ENV.ownerOpenId) { values.role = "admin"; updateSet.role = "admin"; }
    if (!values.lastSignedIn) values.lastSignedIn = new Date();
    if (Object.keys(updateSet).length === 0) updateSet.lastSignedIn = new Date();
    await db.insert(users).values(values).onDuplicateKeyUpdate({ set: updateSet });
  } catch (error) {
    console.error("[Database] Failed to upsert user:", error);
    throw error;
  }
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) { console.warn("[Database] Cannot get user: database not available"); return undefined; }
  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

// ─── Surveys ─────────────────────────────────────────────────────────────────

export async function createSurvey(data: {
  institutionName: string;
  institutionCity?: string;
  contactName?: string;
  contactPhone?: string;
  liaison?: string;
  fillDate?: string;
  answers: Record<string, unknown>;
}): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const result = await db.insert(surveys).values({
    institutionName: data.institutionName,
    institutionCity: data.institutionCity ?? null,
    contactName: data.contactName ?? null,
    contactPhone: data.contactPhone ?? null,
    liaison: data.liaison ?? null,
    fillDate: data.fillDate ?? null,
    answers: data.answers,
  });
  return (result as unknown as { insertId: number }[])[0]?.insertId ?? 0;
}

export async function listSurveys(opts: {
  keyword?: string;
  city?: string;
  startDate?: Date;
  endDate?: Date;
  limit?: number;
  offset?: number;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const conditions = [];
  if (opts.keyword) conditions.push(like(surveys.institutionName, `%${opts.keyword}%`));
  if (opts.city) conditions.push(like(surveys.institutionCity, `%${opts.city}%`));
  if (opts.startDate) conditions.push(gte(surveys.submittedAt, opts.startDate));
  if (opts.endDate) conditions.push(lte(surveys.submittedAt, opts.endDate));

  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const limit = opts.limit ?? 20;
  const offset = opts.offset ?? 0;

  const [rows, countRows] = await Promise.all([
    db
      .select({
        id: surveys.id,
        institutionName: surveys.institutionName,
        institutionCity: surveys.institutionCity,
        contactName: surveys.contactName,
        contactPhone: surveys.contactPhone,
        liaison: surveys.liaison,
        fillDate: surveys.fillDate,
        submittedAt: surveys.submittedAt,
        followUpStatus: surveys.followUpStatus,
        followUpNote: surveys.followUpNote,
      })
      .from(surveys)
      .where(where)
      .orderBy(desc(surveys.submittedAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)` })
      .from(surveys)
      .where(where),
  ]);

  const total = Number(countRows[0]?.count ?? 0);
  return { rows, total };
}

export async function getSurveyById(id: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const result = await db.select().from(surveys).where(eq(surveys.id, id)).limit(1);
  return result[0] ?? null;
}

export async function getAllSurveysFull() {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.select().from(surveys).orderBy(desc(surveys.submittedAt));
}

export async function getSurveyStats() {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const [totalRows, weekRows, monthRows] = await Promise.all([
    db.select({ count: sql<number>`count(*)` }).from(surveys),
    db.select({ count: sql<number>`count(*)` }).from(surveys).where(gte(surveys.submittedAt, weekAgo)),
    db.select({ count: sql<number>`count(*)` }).from(surveys).where(gte(surveys.submittedAt, monthAgo)),
  ]);
  return {
    total: Number(totalRows[0]?.count ?? 0),
    thisWeek: Number(weekRows[0]?.count ?? 0),
    thisMonth: Number(monthRows[0]?.count ?? 0),
  };
}

export async function updateFollowUpStatus(
  id: number,
  status: "pending" | "contacted" | "strong_intent" | "not_suitable",
  note?: string
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db
    .update(surveys)
    .set({ followUpStatus: status, ...(note !== undefined ? { followUpNote: note } : {}) })
    .where(eq(surveys.id, id));
}

export async function getCityStats(): Promise<{ city: string; count: number }[]> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const rows = await db
    .select({
      city: surveys.institutionCity,
      count: sql<number>`count(*)`,
    })
    .from(surveys)
    .where(sql`${surveys.institutionCity} is not null and ${surveys.institutionCity} != ''`)
    .groupBy(surveys.institutionCity)
    .orderBy(desc(sql<number>`count(*)`));
  return rows
    .filter((r) => r.city)
    .map((r) => ({ city: r.city as string, count: Number(r.count) }));
}

// ─── Admin Credentials ───────────────────────────────────────────────────────

export async function getAdminByUsername(username: string) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const result = await db
    .select()
    .from(adminCredentials)
    .where(eq(adminCredentials.username, username))
    .limit(1);
  return result[0] ?? null;
}

export async function createAdmin(username: string, passwordHash: string) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.insert(adminCredentials).values({ username, passwordHash });
}

export async function adminExists(): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const result = await db.select({ count: sql<number>`count(*)` }).from(adminCredentials);
  return Number(result[0]?.count ?? 0) > 0;
}

// ─── Survey Config ────────────────────────────────────────────────────────────

export async function getSurveyConfig(key: string): Promise<unknown | null> {
  const db = await getDb();
  if (!db) return null;
  const result = await db
    .select()
    .from(surveyConfig)
    .where(eq(surveyConfig.configKey, key))
    .limit(1);
  return result[0]?.configValue ?? null;
}

export async function setSurveyConfig(key: string, value: unknown): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db
    .insert(surveyConfig)
    .values({ configKey: key, configValue: value })
    .onDuplicateKeyUpdate({ set: { configValue: value } });
}
