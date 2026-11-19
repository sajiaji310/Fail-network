import { RawAlertSchema, type ParseIssue, type ParseResult, type RawAlert } from '../schema';

/** 必填列：缺一列直接整体失败，错误信息指出缺哪列 */
export const REQUIRED_COLUMNS = ['deviceName', 'type', 'severity', 'message', 'firstSeen'] as const;

const NUMERIC_COLUMNS = new Set(['value', 'threshold', 'count']);

/** RFC4180 风格的记录切分：支持引号包裹、"" 转义、CRLF */
function splitRecords(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') field += ch;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function cellToValue(column: string, raw: string): unknown {
  const value = raw.trim();
  if (value === '') return undefined;
  if (NUMERIC_COLUMNS.has(column)) {
    const num = Number(value);
    return Number.isFinite(num) ? num : value; // 非法数字交给 zod 报错，保留原文便于定位
  }
  return value;
}

/**
 * 解析告警 CSV。单行脏数据只跳过该行并记录行号，不中断整批（解析容错）。
 * 返回的 line 是文件真实行号（表头为第 1 行）。
 */
export function parseCsv(text: string): ParseResult {
  const issues: ParseIssue[] = [];
  const clean = text.replace(/^\uFEFF/, '');
  const records = splitRecords(clean).filter((r) => r.some((c) => c.trim() !== ''));

  if (records.length === 0) {
    return { rows: [], issues: [{ message: 'CSV 内容为空' }] };
  }

  const header = records[0]!.map((h) => h.trim());
  const missing = REQUIRED_COLUMNS.filter((c) => !header.includes(c));
  if (missing.length > 0) {
    return { rows: [], issues: [{ line: 1, message: `缺少必填列：${missing.join(', ')}` }] };
  }

  const rows: RawAlert[] = [];
  for (let i = 1; i < records.length; i++) {
    const line = i + 1;
    const cells = records[i]!;
    if (cells.length !== header.length) {
      issues.push({
        line,
        message: `列数不匹配：期望 ${header.length} 列，实际 ${cells.length} 列`,
      });
      continue;
    }

    const draft: Record<string, unknown> = {};
    header.forEach((column, idx) => {
      const value = cellToValue(column, cells[idx] ?? '');
      if (value !== undefined) draft[column] = value;
    });

    const parsed = RawAlertSchema.safeParse(draft);
    if (!parsed.success) {
      issues.push({
        line,
        message: parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '(row)'}: ${issue.message}`)
          .join('; '),
      });
      continue;
    }
    rows.push(parsed.data);
  }

  return { rows, issues };
}
