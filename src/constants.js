// 领域常量与状态词表。来源资料全部为字符串，状态使用中文枚举。

export const MISSING = '?' // 来源系统对缺失值的统一标记

// performance.state：一条运行经历的状态分类
export const STATE = Object.freeze({
  RUN: '运行',
  BYPASS: '旁路',
  STOP: '停机',
  MISSING: '缺测',
  PLANNED_REMOVAL: '计划拆除',
  REMOVED: '已拆除',
  INSTALLED: '已装填',
})

// 一个运行日可提供的寿命证据类型
export const EVIDENCE = Object.freeze({
  BREACH: '性能越界', // 有效读数低于进料阈值（失效事件）
  OK: '正常读数',
  PENDING: '证据待查', // 化验未生效，结论挂起
  INSUFFICIENT: '取样不足', // 无读数（缺测/停机/拆装窗口）
  PLANNED: '计划更换', // 计划拆除：删失而非自然失效
  NON_RUN: '非运行经历', // 旁路：有读数但不计入磨损
})

// 维修任务状态与班组权限
export const TASK = Object.freeze({
  STARTED: '已开工',
  SIGNED: '已签',
  CANDIDATE: '候选',
})

export const AUTHORITY = Object.freeze({
  IMMOVABLE: '不可移位',
  SHIFT_LEAD: '班长',
  PLANNER: '计划员',
})

// 产品交接状态与客户验收
export const PIECE = Object.freeze({
  ISSUED: '已签发',
  PENDING_QC: '待检',
  SHIPPED: '已发',
  RECHECK: '重检',
})

export const GRADE = Object.freeze({
  STABLE: '稳定',
  PENDING: '待检',
})

// 计划员按运行日查询时，三类需要分清的风险性质
export const RISK_KIND = Object.freeze({
  RISING: '风险确实上升', // 有效越界或同批失效聚集
  NO_EVIDENCE: '缺乏证据', // 取样不足/化验待查/无同类参考
  NOT_FEASIBLE: '根本安排不下', // 施工位、容器、化验名额等硬约束冲突
})

// 可比较的运行状态：只有真正带料运行的记录才参与寿命比较
export const COMPARABLE_STATES = Object.freeze([STATE.RUN])
