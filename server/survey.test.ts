import { describe, expect, it, vi } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import { formatAnswer } from "./surveyFormat";
import { DEFAULT_SURVEY_SECTIONS } from "../shared/surveyQuestions";

// ─── Mock DB helpers ──────────────────────────────────────────────────────────

vi.mock("./db", () => ({
  createSurvey: vi.fn().mockResolvedValue(42),
  listSurveys: vi.fn().mockResolvedValue({ rows: [], total: 0 }),
  getSurveyById: vi.fn().mockResolvedValue(null),
  getAllSurveysFull: vi.fn().mockResolvedValue([]),
  getAdminByUsername: vi.fn().mockResolvedValue(null),
  createAdmin: vi.fn().mockResolvedValue(undefined),
  adminExists: vi.fn().mockResolvedValue(false),
  getSurveyConfig: vi.fn().mockResolvedValue(null),
  setSurveyConfig: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./_core/notification", () => ({
  notifyOwner: vi.fn().mockResolvedValue(true),
}));

// ─── Context factory ──────────────────────────────────────────────────────────

function makeCtx(overrides: Partial<TrpcContext> = {}): TrpcContext {
  const cookies: Record<string, string> = {};
  return {
    user: null,
    req: {
      protocol: "https",
      headers: {},
      cookies,
    } as unknown as TrpcContext["req"],
    res: {
      cookie: vi.fn(),
      clearCookie: vi.fn(),
    } as unknown as TrpcContext["res"],
    ...overrides,
  };
}

// ─── formatAnswer tests ───────────────────────────────────────────────────────

describe("formatAnswer", () => {
  it("returns placeholder for empty values", () => {
    expect(formatAnswer(undefined)).toBe("（未填写）");
    expect(formatAnswer(null)).toBe("（未填写）");
    expect(formatAnswer("")).toBe("（未填写）");
  });

  it("formats plain string", () => {
    expect(formatAnswer("北京")).toBe("北京");
  });

  it("formats radio with other", () => {
    expect(formatAnswer({ value: "其他", other: "特殊类型" })).toBe("其他（特殊类型）");
  });

  it("formats checkbox array with labels", () => {
    const val = [{ label: "痛点A" }, { label: "痛点B", value: "30", unit: "%" }];
    const result = formatAnswer(val);
    expect(result).toContain("痛点A");
    expect(result).toContain("痛点B");
  });

  it("formats priority array with stars", () => {
    const val = [{ label: "技术支持", stars: 5 }, { label: "品牌赋能", stars: 3 }];
    const result = formatAnswer(val);
    expect(result).toContain("技术支持");
    expect(result).toContain("5星");
  });
});

// ─── survey.submit ────────────────────────────────────────────────────────────

describe("survey.submit", () => {
  it("creates a survey and returns ok:true with an id", async () => {
    const ctx = makeCtx();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.survey.submit({
      institutionName: "测试机构",
      institutionCity: "北京",
      contactName: "张三",
      contactPhone: "13800138000",
      liaison: "李四",
      fillDate: "2026-04-25",
      answers: { q1_1: "综合医美机构" },
    });

    expect(result.ok).toBe(true);
    expect(result.id).toBe(42);
  });
});

// ─── survey.questions ─────────────────────────────────────────────────────────

describe("survey.questions", () => {
  it("returns default sections when no config saved", async () => {
    const ctx = makeCtx();
    const caller = appRouter.createCaller(ctx);

    const sections = await caller.survey.questions();
    expect(Array.isArray(sections)).toBe(true);
    expect((sections as unknown[]).length).toBeGreaterThan(0);
  });

  it("default sections have the expected 5 modules", () => {
    expect(DEFAULT_SURVEY_SECTIONS.length).toBe(6); // basic info + 5 modules
  });
});

// ─── survey.adminMe ───────────────────────────────────────────────────────────

describe("survey.adminMe", () => {
  it("returns null when no admin session cookie", async () => {
    const ctx = makeCtx();
    const caller = appRouter.createCaller(ctx);

    const me = await caller.survey.adminMe();
    expect(me).toBeNull();
  });
});

// ─── survey.adminLogin ────────────────────────────────────────────────────────

describe("survey.adminLogin", () => {
  it("throws UNAUTHORIZED for non-existent user", async () => {
    const ctx = makeCtx();
    const caller = appRouter.createCaller(ctx);

    await expect(
      caller.survey.adminLogin({ username: "nobody", password: "wrong" })
    ).rejects.toThrow();
  });
});

// ─── survey.adminLogout ───────────────────────────────────────────────────────

describe("survey.adminLogout", () => {
  it("clears admin session cookie and returns ok:true", async () => {
    const clearCookie = vi.fn();
    const ctx = makeCtx({
      res: { cookie: vi.fn(), clearCookie } as unknown as TrpcContext["res"],
    });
    const caller = appRouter.createCaller(ctx);

    const result = await caller.survey.adminLogout();
    expect(result.ok).toBe(true);
    expect(clearCookie).toHaveBeenCalledWith("admin_session", { path: "/" });
  });
});

// ─── Admin-protected routes ───────────────────────────────────────────────────

describe("survey.list", () => {
  it("requires admin session", async () => {
    const ctx = makeCtx();
    const caller = appRouter.createCaller(ctx);

    await expect(
      caller.survey.list({ page: 1, pageSize: 10 })
    ).rejects.toThrow();
  });
});

describe("survey.analytics", () => {
  it("requires admin session", async () => {
    const ctx = makeCtx();
    const caller = appRouter.createCaller(ctx);

    await expect(caller.survey.analytics()).rejects.toThrow();
  });
});

describe("survey.saveConfig", () => {
  it("requires admin session", async () => {
    const ctx = makeCtx();
    const caller = appRouter.createCaller(ctx);

    await expect(
      caller.survey.saveConfig({ sections: [] })
    ).rejects.toThrow();
  });
});

describe("survey.getConfig", () => {
  it("requires admin session", async () => {
    const ctx = makeCtx();
    const caller = appRouter.createCaller(ctx);

    await expect(caller.survey.getConfig()).rejects.toThrow();
  });
});
