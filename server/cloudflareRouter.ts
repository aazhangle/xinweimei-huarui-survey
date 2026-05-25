import bcrypt from "bcryptjs";
import { initTRPC, TRPCError } from "@trpc/server";
import { SignJWT, jwtVerify } from "jose";
import superjson from "superjson";
import { z } from "zod";
import { DEFAULT_SURVEY_SECTIONS, setSurveySections, type Section } from "../shared/surveyQuestions";
import {
  adminExists,
  createAdmin,
  createSurvey,
  getAdminByUsername,
  getAllSurveysFull,
  getCityStats,
  getSurveyById,
  getSurveyConfig,
  getSurveyStats,
  listSurveys,
  setSurveyConfig,
  updateFollowUpStatus,
  type D1DatabaseLike,
  type FollowUpStatus,
} from "./cloudflareDb";

const SURVEY_CONFIG_KEY = "survey_sections";

export type CloudflareEnv = {
  DB: D1DatabaseLike;
  JWT_SECRET?: string;
  ADMIN_USERNAME?: string;
  ADMIN_PASSWORD?: string;
  ADMIN_PASSWORD_HASH?: string;
};

export type CloudflareContext = {
  env: CloudflareEnv;
  req: Request;
  adminUser?: string | null;
};

function readCookie(req: Request, name: string): string | null {
  const cookie = req.headers.get("Cookie") || "";
  const part = cookie.split(";").map((s) => s.trim()).find((s) => s.startsWith(`${name}=`));
  if (!part) return null;
  return decodeURIComponent(part.slice(name.length + 1));
}

function getJwtSecret(env: CloudflareEnv) {
  const secret = env.JWT_SECRET || "fallback-secret-change-me";
  return new TextEncoder().encode(secret);
}

async function signAdminToken(env: CloudflareEnv, username: string): Promise<string> {
  return new SignJWT({ sub: username, role: "admin" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(getJwtSecret(env));
}

export async function verifyAdminToken(env: CloudflareEnv, token: string | null | undefined): Promise<string | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, getJwtSecret(env));
    if (payload.role !== "admin") return null;
    return typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}

export async function createCloudflareContext(env: CloudflareEnv, req: Request): Promise<CloudflareContext> {
  const auth = req.headers.get("Authorization") || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  const cookieToken = readCookie(req, "admin_session");
  const adminUser = await verifyAdminToken(env, bearer || cookieToken);
  return { env, req, adminUser };
}

const t = initTRPC.context<CloudflareContext>().create({ transformer: superjson });
const router = t.router;
const publicProcedure = t.procedure;

const surveyAdminProcedure = publicProcedure.use(async ({ ctx, next }) => {
  if (!ctx.adminUser) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "请先登录管理后台" });
  }
  return next({ ctx: { ...ctx, adminUser: ctx.adminUser } });
});

const listInput = z.object({
  keyword: z.string().optional(),
  city: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(100).default(20),
});

function asSections(value: unknown): Section[] {
  if (value && Array.isArray(value)) return value as Section[];
  return DEFAULT_SURVEY_SECTIONS;
}

function bumpRadio(map: Record<string, number>, value: unknown) {
  if (typeof value === "string" && value) map[value] = (map[value] ?? 0) + 1;
  else if (value && typeof value === "object") {
    const v = value as { value?: string; other?: string };
    if (v.value) {
      const key = v.value === "其他" && v.other ? `其他：${v.other}` : v.value;
      map[key] = (map[key] ?? 0) + 1;
    }
  }
}

function bumpCheckbox(map: Record<string, number>, value: unknown) {
  if (!Array.isArray(value)) return;
  for (const item of value) {
    const label = typeof item === "string" ? item : (item as { label?: string })?.label ?? "";
    if (label) map[label] = (map[label] ?? 0) + 1;
  }
}

export const appRouter = router({
  survey: router({
    submit: publicProcedure
      .input(
        z.object({
          institutionName: z.string().min(1),
          institutionCity: z.string().optional(),
          contactName: z.string().optional(),
          contactPhone: z.string().optional(),
          liaison: z.string().optional(),
          fillDate: z.string().optional(),
          answers: z.record(z.string(), z.unknown()),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const id = await createSurvey(ctx.env.DB, input);
        return { ok: true, id } as const;
      }),

    questions: publicProcedure.query(async ({ ctx }) => {
      const saved = await getSurveyConfig(ctx.env.DB, SURVEY_CONFIG_KEY);
      return asSections(saved);
    }),

    publicStats: publicProcedure.query(async ({ ctx }) => {
      const stats = await getSurveyStats(ctx.env.DB);
      return { total: stats.total };
    }),

    publicCityStats: publicProcedure.query(async ({ ctx }) => {
      return await getCityStats(ctx.env.DB);
    }),

    adminLogin: publicProcedure
      .input(z.object({ username: z.string(), password: z.string() }))
      .mutation(async ({ input, ctx }) => {
        const defaultUsername = ctx.env.ADMIN_USERNAME || "admin";
        const defaultPassword = ctx.env.ADMIN_PASSWORD || "xwm666666";

        if (!(await adminExists(ctx.env.DB))) {
          const hash = ctx.env.ADMIN_PASSWORD_HASH || (await bcrypt.hash(defaultPassword, 10));
          await createAdmin(ctx.env.DB, defaultUsername, hash);
        }

        const admin = await getAdminByUsername(ctx.env.DB, input.username);
        if (!admin) throw new TRPCError({ code: "UNAUTHORIZED", message: "账号或密码错误" });

        const valid = await bcrypt.compare(input.password, admin.passwordHash);
        if (!valid) throw new TRPCError({ code: "UNAUTHORIZED", message: "账号或密码错误" });

        const token = await signAdminToken(ctx.env, admin.username);
        return { ok: true, username: admin.username, token } as const;
      }),

    adminLogout: publicProcedure.mutation(() => {
      return { ok: true } as const;
    }),

    adminMe: publicProcedure.query(({ ctx }) => {
      return ctx.adminUser ? { username: ctx.adminUser } : null;
    }),

    list: surveyAdminProcedure.input(listInput).query(async ({ input, ctx }) => {
      const limit = input.pageSize;
      const offset = (input.page - 1) * input.pageSize;
      const startDate = input.startDate ? new Date(`${input.startDate}T00:00:00+08:00`) : undefined;
      const endDate = input.endDate ? new Date(`${input.endDate}T23:59:59+08:00`) : undefined;
      return await listSurveys(ctx.env.DB, {
        keyword: input.keyword || undefined,
        city: input.city || undefined,
        startDate,
        endDate,
        limit,
        offset,
      });
    }),

    detail: surveyAdminProcedure.input(z.object({ id: z.number().int() })).query(async ({ input, ctx }) => {
      const row = await getSurveyById(ctx.env.DB, input.id);
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "记录不存在" });
      return row;
    }),

    analytics: surveyAdminProcedure.query(async ({ ctx }) => {
      const rows = await getAllSurveysFull(ctx.env.DB);
      const total = rows.length;
      const typeCount: Record<string, number> = {};
      const painCount: Record<string, number> = {};
      const planCount: Record<string, number> = {};
      const priorityScores: Record<string, { totalStars: number; voters: number }> = {};
      const cityCount: Record<string, number> = {};
      const privateStartedCount: Record<string, number> = {};

      for (const row of rows) {
        const a = row.answers ?? {};
        bumpRadio(typeCount, a.q1_1);
        bumpCheckbox(painCount, a.q2_4);
        bumpCheckbox(planCount, a.q5_4);
        bumpRadio(privateStartedCount, a.q3_1);
        if (row.institutionCity) cityCount[row.institutionCity] = (cityCount[row.institutionCity] ?? 0) + 1;

        const priorityVal = a.q5_1;
        if (Array.isArray(priorityVal)) {
          for (const item of priorityVal) {
            const it = item as { label?: string; stars?: number };
            if (it.label) {
              const cur = priorityScores[it.label] ?? { totalStars: 0, voters: 0 };
              const stars = Number(it.stars ?? 0);
              cur.totalStars += stars;
              if (stars > 0) cur.voters += 1;
              priorityScores[it.label] = cur;
            }
          }
        }
      }

      return {
        total,
        typeDistribution: Object.entries(typeCount).map(([label, count]) => ({ label, count })),
        painTop: Object.entries(painCount).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([label, count]) => ({ label, count })),
        planDistribution: Object.entries(planCount).map(([label, count]) => ({ label, count })),
        priorityRanking: Object.entries(priorityScores)
          .map(([label, v]) => ({
            label,
            totalStars: v.totalStars,
            voters: v.voters,
            avg: v.voters > 0 ? Math.round((v.totalStars / v.voters) * 100) / 100 : 0,
          }))
          .sort((a, b) => b.totalStars - a.totalStars),
        cityDistribution: Object.entries(cityCount).sort((a, b) => b[1] - a[1]).map(([label, count]) => ({ label, count })),
        privateStartedDistribution: Object.entries(privateStartedCount).map(([label, count]) => ({ label, count })),
      };
    }),

    stats: surveyAdminProcedure.query(async ({ ctx }) => {
      return await getSurveyStats(ctx.env.DB);
    }),

    updateFollowUp: surveyAdminProcedure
      .input(
        z.object({
          id: z.number().int(),
          status: z.enum(["pending", "contacted", "strong_intent", "not_suitable"]),
          note: z.string().optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        await updateFollowUpStatus(ctx.env.DB, input.id, input.status as FollowUpStatus, input.note);
        return { ok: true } as const;
      }),

    saveConfig: surveyAdminProcedure.input(z.object({ sections: z.array(z.unknown()) })).mutation(async ({ input, ctx }) => {
      await setSurveyConfig(ctx.env.DB, SURVEY_CONFIG_KEY, input.sections);
      setSurveySections(input.sections as Parameters<typeof setSurveySections>[0]);
      return { ok: true } as const;
    }),
  }),
});

export type CloudflareAppRouter = typeof appRouter;
