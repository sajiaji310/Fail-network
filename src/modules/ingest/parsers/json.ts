import { RawAlertSchema, type ParseIssue, type ParseResult, type RawAlert } from '../schema';

/**
 * 解析 JSON 导入内容：既接受裸数组，也接受 { alerts: [...] } 或 { data: [...] }。
 * 逐条校验，坏行只跳过并记 index，不中断整批。
 */
export function parseJson(content: unknown): ParseResult {
  const issues: ParseIssue[] = [];

  let list: unknown;
  if (Array.isArray(content)) {
    list = content;
  } else if (content && typeof content === 'object') {
    const obj = content as Record<string, unknown>;
    list = obj.alerts ?? obj.data ?? obj.items;
  }

  if (!Array.isArray(list)) {
    return { rows: [], issues: [{ message: 'JSON 结构不合法：期望数组或 { alerts: [...] }' }] };
  }

  const rows: RawAlert[] = [];
  list.forEach((item, index) => {
    const parsed = RawAlertSchema.safeParse(item);
    if (!parsed.success) {
      issues.push({
        index,
        message: parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '(item)'}: ${issue.message}`)
          .join('; '),
      });
      return;
    }
    rows.push(parsed.data);
  });

  return { rows, issues };
}

/** 文本入口：JSON 语法错误也要变成 issues 而不是抛异常 */
export function parseJsonText(text: string): ParseResult {
  try {
    return parseJson(JSON.parse(text));
  } catch (error) {
    return {
      rows: [],
      issues: [
        { message: `JSON 解析失败：${error instanceof Error ? error.message : '未知错误'}` },
      ],
    };
  }
}
