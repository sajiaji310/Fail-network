import type { IncidentStatus } from '@prisma/client';

/**
 * 事件状态的中文标签与推进语义。
 *
 * 单独成文件（而不是塞进 badges.tsx）的原因：状态机在服务端要拼错误信息，
 * 徽标在客户端要渲染文字，两边必须同一份文案 —— 复制到第二处就会漂移。
 */

export const INCIDENT_STATUS_LABEL: Record<IncidentStatus, string> = {
  OPEN: '待处理',
  ANALYZING: '研判中',
  LOCATED: '已定位',
  MITIGATED: '已缓解',
  RESOLVED: '已恢复',
  CLOSED: '已归档',
};

/** 流转按钮的动词语义（11.3：按钮文案是动词，不是"确定"） */
export const INCIDENT_ACTION_LABEL: Partial<Record<IncidentStatus, string>> = {
  ANALYZING: '开始研判',
  LOCATED: '标记已定位',
  MITIGATED: '标记已缓解',
  RESOLVED: '结案',
  CLOSED: '归档',
};

/** 每个目标状态的后果说明，放在二次确认弹窗里，替用户把话说全 */
export const INCIDENT_ACTION_HINT: Partial<Record<IncidentStatus, string>> = {
  ANALYZING: '进入研判阶段，便于区分"已接手"和"没人管"。',
  LOCATED: '记录定位时间，MTTR 仍以恢复时间为准。',
  MITIGATED: '故障已缓解但未恢复，事件仍然活跃。',
  RESOLVED:
    '写结案时间与 MTTR，并自动沉淀一条案例、生成复盘报告。结案后不能再回到活跃状态，30 分钟内同簇再现由系统自动重开。',
  CLOSED: '归档后不再出现在活跃列表，只是整理动作，不影响 MTTR。',
};
