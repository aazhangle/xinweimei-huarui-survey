import bcrypt from "bcryptjs";
import { SignJWT, jwtVerify } from "jose";
import { z } from "zod";
import { DEFAULT_SURVEY_SECTIONS, setSurveySections } from "../../shared/surveyQuestions";
import { notifyOwner } from "../_core/notification";
import { publicProcedure, router } from "../_core/trpc";
import {
  adminExists,
  createAdmin,
  createSurvey,
  getAllSurveysFull,
  getAdminByUsername,
  getCityStats,
  getSurveyById,
  getSurveyConfig,
  getSurveyStats,
  listSurveys,
  setSurveyConfig,
  updateFollowUpStatus,
} from "../db";
import { TRPCError } from "@trpc/server";

const ADMIN_SESSION_KEY = "admin_session";
const SURVEY_CONFIG_KEY = "survey_sections";

// ─── Admin JWT helpers ────────────────────────────────────────────────────────

function getJwtSecret() {
  const secret = process.env.JWT_SECRET ?? "fallback-secret-change-me";
  return new TextEncoder().encode(secret);
}

async function signAdminToken(username: string): Promise<string> {
  return new SignJWT({ sub: username, role: "admin" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(getJwtSecret());
}

async function verifyAdminToken(token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, getJwtSecret());
    return typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}

// ─── Middleware: require admin session ────────────────────────────────────────

const surveyAdminProcedure = publicProcedure.use(async ({ ctx, next }) => {
  const token = ctx.req.cookies?.[ADMIN_SESSION_KEY];
  if (!token) throw new TRPCError({ code: "UNAUTHORIZED", message: "请先登录管理后台" });
  const username = await verifyAdminToken(token);
  if (!username) throw new TRPCError({ code: "UNAUTHORIZED", message: "会话已过期，请重新登录" });
  return next({ ctx: { ...ctx, adminUser: username } });
});

// ─── Input schemas ────────────────────────────────────────────────────────────

const listInput = z.object({
  keyword: z.string().optional(),
  city: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(100).default(20),
});

// ─── Router ───────────────────────────────────────────────────────────────────

export const surveyRouter = router({
  /** Public: submit a survey */
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
    .mutation(async ({ input }) => {
      const id = await createSurvey({
        institutionName: input.institutionName,
        institutionCity: input.institutionCity,
        contactName: input.contactName,
        contactPhone: input.contactPhone,
        liaison: input.liaison,
        fillDate: input.fillDate,
        answers: input.answers,
      });

      const notifyEmail = "798847559@qq.com";
      const summary = [
        `机构名称：${input.institutionName}`,
        input.institutionCity ? `机构城市：${input.institutionCity}` : "",
        input.contactName ? `填写人：${input.contactName}` : "",
        input.contactPhone ? `联系电话：${input.contactPhone}` : "",
        input.fillDate ? `填写日期：${input.fillDate}` : "",
        "",
        "请前往后台查看完整填写内容。",
        `通知邮箱：${notifyEmail}`,
      ]
        .filter(Boolean)
        .join("\n");

      notifyOwner({
        title: `【信为美调研】新提交：${input.institutionName}`,
        content: summary,
      } as const).catch((err) => {
        console.warn("[Survey.submit] notifyOwner failed:", err);
      });

      return { ok: true, id } as const;
    }),

  /** Public: get current question structure */
  questions: publicProcedure.query(async () => {
    const saved = await getSurveyConfig(SURVEY_CONFIG_KEY);
    if (saved && Array.isArray(saved)) return saved;
    return DEFAULT_SURVEY_SECTIONS;
  }),

  // ─── Admin auth ─────────────────────────────────────────────────────────────

  /** Admin: login */
  adminLogin: publicProcedure
    .input(z.object({ username: z.string(), password: z.string() }))
    .mutation(async ({ input, ctx }) => {
      // Auto-create default admin if none exists
      const exists = await adminExists();
      if (!exists) {
        const hash = await bcrypt.hash("xwm666666", 10);
        await createAdmin("admin", hash);
      }

      const admin = await getAdminByUsername(input.username);
      if (!admin) throw new TRPCError({ code: "UNAUTHORIZED", message: "账号或密码错误" });

      const valid = await bcrypt.compare(input.password, admin.passwordHash);
      if (!valid) throw new TRPCError({ code: "UNAUTHORIZED", message: "账号或密码错误" });

      const token = await signAdminToken(admin.username);
      ctx.res.cookie(ADMIN_SESSION_KEY, token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
        maxAge: 7 * 24 * 60 * 60 * 1000,
        path: "/",
      });
      return { ok: true, username: admin.username } as const;
    }),

  /** Admin: logout */
  adminLogout: publicProcedure.mutation(({ ctx }) => {
    ctx.res.clearCookie(ADMIN_SESSION_KEY, { path: "/" });
    return { ok: true } as const;
  }),

  /** Admin: check session */
  adminMe: publicProcedure.query(async ({ ctx }) => {
    const token = ctx.req.cookies?.[ADMIN_SESSION_KEY];
    if (!token) return null;
    const username = await verifyAdminToken(token);
    return username ? { username } : null;
  }),

  // ─── Admin data ──────────────────────────────────────────────────────────────

  /** Admin: list surveys */
  list: surveyAdminProcedure.input(listInput).query(async ({ input }) => {
    const limit = input.pageSize;
    const offset = (input.page - 1) * input.pageSize;
    const startDate = input.startDate ? new Date(input.startDate) : undefined;
    const endDate = input.endDate ? new Date(input.endDate + "T23:59:59") : undefined;
    return await listSurveys({
      keyword: input.keyword || undefined,
      city: input.city || undefined,
      startDate,
      endDate,
      limit,
      offset,
    });
  }),

  /** Admin: survey detail */
  detail: surveyAdminProcedure
    .input(z.object({ id: z.number().int() }))
    .query(async ({ input }) => {
      const row = await getSurveyById(input.id);
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "记录不存在" });
      return row;
    }),

  /** Admin: analytics */
  analytics: surveyAdminProcedure.query(async () => {
    const rows = await getAllSurveysFull();
    const total = rows.length;

    const typeCount: Record<string, number> = {};
    const painCount: Record<string, number> = {};
    const planCount: Record<string, number> = {};
    const priorityScores: Record<string, { totalStars: number; voters: number }> = {};
    const cityCount: Record<string, number> = {};
    const privateStartedCount: Record<string, number> = {};

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
      if (Array.isArray(value)) {
        for (const item of value) {
          const label = typeof item === "string" ? item : (item as { label?: string })?.label ?? "";
          if (label) map[label] = (map[label] ?? 0) + 1;
        }
      }
    }

    for (const row of rows) {
      const a = (row.answers as Record<string, unknown>) ?? {};
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
            cur.totalStars += Number(it.stars ?? 0);
            if (Number(it.stars ?? 0) > 0) cur.voters += 1;
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

  // ─── Survey config (question editor) ─────────────────────────────────────────

  /** Admin: get survey config */
  getConfig: surveyAdminProcedure.query(async () => {
    const saved = await getSurveyConfig(SURVEY_CONFIG_KEY);
    if (saved && Array.isArray(saved)) return saved;
    return DEFAULT_SURVEY_SECTIONS;
  }),

  /** Public: get total submission count for homepage display */
  publicStats: publicProcedure.query(async () => {
    const stats = await getSurveyStats();
    return { total: stats.total };
  }),

  /** Public: get city distribution for homepage map */
  publicCityStats: publicProcedure.query(async () => {
    return await getCityStats();
  }),

  /** Admin: get stats summary */
  stats: surveyAdminProcedure.query(async () => {
    return await getSurveyStats();
  }),

  /** Admin: update follow-up status */
  updateFollowUp: surveyAdminProcedure
    .input(
      z.object({
        id: z.number().int(),
        status: z.enum(["pending", "contacted", "strong_intent", "not_suitable"]),
        note: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      await updateFollowUpStatus(input.id, input.status, input.note);
      return { ok: true } as const;
    }),

  /** Admin: save survey config */
  saveConfig: surveyAdminProcedure
    .input(z.object({ sections: z.array(z.unknown()) }))
    .mutation(async ({ input }) => {
      await setSurveyConfig(SURVEY_CONFIG_KEY, input.sections);
      // Update runtime cache
      setSurveySections(input.sections as Parameters<typeof setSurveySections>[0]);
      return { ok: true } as const;
    }),
});
