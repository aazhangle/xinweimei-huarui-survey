import { DEFAULT_SURVEY_SECTIONS, type Section } from "../../../shared/surveyQuestions";
import { formatAnswer } from "../../../server/surveyFormat";
import { getAllSurveysFull, getSurveyConfig, type D1DatabaseLike } from "../../../server/cloudflareDb";
import { verifyAdminToken, type CloudflareEnv } from "../../../server/cloudflareRouter";

const SURVEY_CONFIG_KEY = "survey_sections";

type PagesFunctionContext = {
  request: Request;
  env: CloudflareEnv & { DB: D1DatabaseLike };
};

function csvEscape(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  if(/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function getBearerToken(req: Request): string | null {
  const auth = req.headers.get("Authorization") || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7);
  const url = new URL(req.url);
  return url.searchParams.get("token");
}

export const onRequestGet = async (context: PagesFunctionContext) => {
  const username = await verifyAdminToken(context.env, getBearerToken(context.request));
  if (!username) {
    return Response.json({ error: "未授权，请先登录管理后台" }, { status: 401 });
  }

  const savedConfig = await getSurveyConfig(context.env.DB, SURVEY_CONFIG_KEY);
  const sections: Section[] = Array.isArray(savedConfig) && savedConfig.length > 0 ? (savedConfig as Section[]) : DEFAULT_SURVEY_SECTIONS;
  const rows = await getAllSurveysFull(context.env.DB);

  const baseHeaders = ["ID", "机构名称", "机构城市", "填写人", "联系电话", "对接人（信为美）", "填写日期", "提交时间", "跟进状态", "跟进备注"];
  const questionHeaders: string[] = [];
  for (const section of sections) {
    for (const q of section.questions) questionHeaders.push(`[${section.title}] ${q.label}`);
  }

  const csvRows: string[][] = [[...baseHeaders, ...questionHeaders]];
  for (const row of rows) {
    const answers = row.answers ?? {};
    const baseValues = [
      row.id,
      row.institutionName,
      row.institutionCity ?? "",
      row.contactName ?? "",
      row.contactPhone ?? "",
      row.liaison ?? "",
      row.fillDate ?? "",
      row.submittedAt ? new Date(row.submittedAt).toLocaleString("zh-CN", { hour12: false }) : "",
      row.followUpStatus ?? "pending",
      row.followUpNote ?? "",
    ].map(String);
    const answerValues: string[] = [];
    for (const section of sections) {
      for (const q of section.questions) answerValues.push(formatAnswer(answers[q.id], q.type));
    }
    csvRows.push([...baseValues, ...answerValues]);
  }

  const csv = "\uFEFF" + csvRows.map((r) => r.map(csvEscape).join(",")).join("\n");
  const filename = encodeURIComponent("信为美花蕊焕新调研数据.csv");

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename*=UTF-8''${filename}`,
      "Cache-Control": "no-store",
    },
  });
};
