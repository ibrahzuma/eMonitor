/** Parsing of bulk-import input (CSV or JSON) into POST /resources/import items. */
import type { JsonObject, JsonValue } from "@/types/api";

export const CSV_COLUMNS = ["name", "kind", "address", "environment", "location", "business_owner", "description", "tags"] as const;

/** RFC 4180-style CSV parser (quoted fields, escaped quotes, CRLF, newlines inside quotes). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"' && field === "") {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

export interface ParseResult {
  items: JsonObject[];
  error: string | null;
}

export function csvToItems(text: string): ParseResult {
  const rows = parseCsv(text);
  if (!rows.length) return { items: [], error: "No rows found" };
  const header = rows[0].map((h) => h.trim().toLowerCase());
  if (!header.includes("name") || !header.includes("kind")) {
    return { items: [], error: "The header row must contain at least the columns name and kind" };
  }
  const unknown = header.filter((h) => h && !(CSV_COLUMNS as readonly string[]).includes(h));
  if (unknown.length) return { items: [], error: `Unknown column(s): ${unknown.join(", ")}` };
  const items = rows.slice(1).map((cells) => {
    const item: JsonObject = {};
    header.forEach((h, i) => {
      const v = (cells[i] ?? "").trim();
      if (!h || v === "") return;
      if (h === "tags") item.tags = v.split(";").map((t) => t.trim()).filter(Boolean);
      else if (h === "kind" || h === "environment") item[h] = v.toLowerCase();
      else item[h] = v;
    });
    return item;
  });
  if (!items.length) return { items: [], error: "No data rows after the header" };
  return { items, error: null };
}

function isObject(v: JsonValue): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Parse pasted input: a JSON array, {"items": [...]}, or CSV with a header row. */
export function parseImport(text: string): ParseResult {
  const t = text.trim();
  if (!t) return { items: [], error: "Paste CSV or JSON first" };
  if (t.startsWith("[") || t.startsWith("{")) {
    let data: JsonValue;
    try {
      data = JSON.parse(t) as JsonValue;
    } catch (e) {
      return { items: [], error: `Invalid JSON: ${e instanceof Error ? e.message : "parse error"}` };
    }
    const list = Array.isArray(data) ? data : isObject(data) && Array.isArray(data.items) ? data.items : null;
    if (!list) return { items: [], error: "JSON must be an array of resources or an object with an items array" };
    if (!list.every(isObject)) return { items: [], error: "Every JSON item must be an object" };
    if (!list.length) return { items: [], error: "The JSON array is empty" };
    if (list.length > 1000) return { items: [], error: "At most 1000 items per import" };
    return { items: list as JsonObject[], error: null };
  }
  const res = csvToItems(t);
  if (res.items.length > 1000) return { items: [], error: "At most 1000 items per import" };
  return res;
}
