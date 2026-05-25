import type { Section } from "../shared/surveyQuestions";

/**
 * Format a single answer value into a human-readable string.
 */
export function formatAnswer(value: unknown, type?: string): string {
  if (value === undefined || value === null || value === "") return "（未填写）";

  // radio with other
  if (typeof value === "object" && !Array.isArray(value)) {
    const v = value as Record<string, unknown>;
    if ("value" in v) {
      const main = String(v.value ?? "");
      const other = v.other ? `（${v.other}）` : "";
      return main + other;
    }
    // composite
    return Object.entries(v)
      .map(([k, val]) => `${k}: ${val}`)
      .join("，");
  }

  // checkbox array
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") return item;
        const it = item as Record<string, unknown>;
        const label = String(it.label ?? "");
        if (it.value !== undefined && it.value !== "") return `${label}（${it.value}${it.unit ?? ""}）`;
        if (it.stars !== undefined) return `${label}：${it.stars}星`;
        return label;
      })
      .filter(Boolean)
      .join("、");
  }

  return String(value);
}

/**
 * Build a flat list of { label, value } pairs for a survey row,
 * following the section/question structure.
 */
export function buildAnswerPairs(
  answers: Record<string, unknown>,
  sections: Section[]
): Array<{ section: string; label: string; value: string }> {
  const pairs: Array<{ section: string; label: string; value: string }> = [];
  for (const section of sections) {
    for (const q of section.questions) {
      const raw = answers[q.id];
      pairs.push({
        section: section.title,
        label: q.label,
        value: formatAnswer(raw, q.type),
      });
    }
  }
  return pairs;
}
