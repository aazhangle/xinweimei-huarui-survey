import type { Request, Response } from "express";
import ExcelJS from "exceljs";
import { jwtVerify } from "jose";
import { getAllSurveysFull, getSurveyConfig } from "./db";
import { DEFAULT_SURVEY_SECTIONS } from "../shared/surveyQuestions";
import type { Section } from "../shared/surveyQuestions";
import { formatAnswer } from "./surveyFormat";

const ADMIN_SESSION_KEY = "admin_session";
const SURVEY_CONFIG_KEY = "survey_sections";

const GREEN_FILL: ExcelJS.Fill = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FF4CAF50" },
};

const WHITE_FONT: Partial<ExcelJS.Font> = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };

async function verifyAdminCookie(req: Request): Promise<boolean> {
  const token = req.cookies?.[ADMIN_SESSION_KEY];
  if (!token) return false;
  try {
    const secret = new TextEncoder().encode(process.env.JWT_SECRET ?? "fallback-secret-change-me");
    const { payload } = await jwtVerify(token, secret);
    return payload.role === "admin";
  } catch {
    return false;
  }
}

export async function handleExportExcel(req: Request, res: Response) {
  // Admin-only guard
  const isAdmin = await verifyAdminCookie(req);
  if (!isAdmin) {
    res.status(401).json({ error: "未授权，请先登录管理后台" });
    return;
  }

  try {
    // Use current (possibly edited) survey config for column headers
    const savedConfig = await getSurveyConfig(SURVEY_CONFIG_KEY);
    const sections: Section[] =
      savedConfig && Array.isArray(savedConfig) && savedConfig.length > 0
        ? (savedConfig as Section[])
        : DEFAULT_SURVEY_SECTIONS;

    const rows = await getAllSurveysFull();
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("调研数据");

    // Build header columns
    const baseHeaders = [
      "ID", "机构名称", "机构城市", "填写人", "联系电话", "对接人（信为美）", "填写日期", "提交时间",
    ];

    const questionHeaders: string[] = [];
    for (const section of sections) {
      for (const q of section.questions) {
        questionHeaders.push(`[${section.title}] ${q.label}`);
      }
    }

    const allHeaders = [...baseHeaders, ...questionHeaders];
    sheet.addRow(allHeaders);

    // Style header row
    const headerRow = sheet.getRow(1);
    headerRow.eachCell((cell) => {
      cell.fill = GREEN_FILL;
      cell.font = WHITE_FONT;
      cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
      cell.border = {
        top: { style: "thin", color: { argb: "FF388E3C" } },
        bottom: { style: "thin", color: { argb: "FF388E3C" } },
        left: { style: "thin", color: { argb: "FF388E3C" } },
        right: { style: "thin", color: { argb: "FF388E3C" } },
      };
    });
    headerRow.height = 28;

    // Set column widths
    sheet.getColumn(1).width = 6;
    sheet.getColumn(2).width = 24;
    sheet.getColumn(3).width = 16;
    sheet.getColumn(4).width = 12;
    sheet.getColumn(5).width = 16;
    sheet.getColumn(6).width = 16;
    sheet.getColumn(7).width = 14;
    sheet.getColumn(8).width = 20;
    for (let i = 9; i <= allHeaders.length; i++) {
      sheet.getColumn(i).width = 28;
    }

    // Add data rows
    for (const row of rows) {
      const answers = (row.answers as Record<string, unknown>) ?? {};
      const baseValues = [
        row.id,
        row.institutionName,
        row.institutionCity ?? "",
        row.contactName ?? "",
        row.contactPhone ?? "",
        row.liaison ?? "",
        row.fillDate ?? "",
        row.submittedAt ? new Date(row.submittedAt).toLocaleString("zh-CN") : "",
      ];
      const answerValues: string[] = [];
      for (const section of sections) {
        for (const q of section.questions) {
          answerValues.push(formatAnswer(answers[q.id], q.type));
        }
      }
      const dataRow = sheet.addRow([...baseValues, ...answerValues]);
      dataRow.eachCell((cell) => {
        cell.alignment = { vertical: "top", wrapText: true };
      });
    }

    // Freeze header row
    sheet.views = [{ state: "frozen", ySplit: 1 }];

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent("信为美调研数据导出")}.xlsx`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error("[Export Excel]", err);
    res.status(500).json({ error: "导出失败" });
  }
}
