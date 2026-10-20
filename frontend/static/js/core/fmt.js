/**
 * tGo · 格式化工具（T5.6）
 *
 * 依据 UI_UX §9 术语与文案规范 + WEBUI 静态稿实测样例：
 *   - 负号统一 **U+2212 −**（全站搜证：曲线轴/ΔW/胜率条 delta/报告拐点均用 −），正号用 ASCII +；
 *   - 时间：相对 ≤7 天本地化（≤1 分钟「刚刚」/分钟/小时/「昨天」/天），绝对时间用 Intl.DateTimeFormat，不硬编码格式；
 *   - 结果：`黑胜 2.5 目 (B+2.5)` / `白中盘胜 (W+Resign)`（verbose）；紧凑 `黑胜 3.5`；
 *   - 段位：backend rank 枚举（rank_5k）↔ 显示 `5K/1D`（UI_UX §9：`5K/3D/9D`）；
 *   - 点评五色：`妙着/正着/缓着/失误/败着` + 口语二名 `绝妙/好棋/不当/恶手/昏招`；
 *   - Visit：<1000 整数，≥1000 `1.2k Visit`。
 *
 * 全部为纯函数（无 DOM / Intl 注入式），可无头测试。
 */

/** 点评五色主文案（LEVEL.md / backend report 口径）。 */
export const GRADE_TEXT = Object.freeze({
  brilliant: '妙着',
  good: '正着',
  slow: '缓着',
  mistake: '失误',
  blunder: '败着',
});

/** 点评五色口语二名（气泡标题「失误（恶手）」用）。 */
export const GRADE_ALT = Object.freeze({
  brilliant: '绝妙',
  good: '好棋',
  slow: '不当',
  mistake: '恶手',
  blunder: '昏招',
});

/** 段位解析：accept backend rank code / '5K'/'3D' / 大小写，返回规范显示 '5K'/'1D'；未知 → ''。 */
export function rankText(input) {
  if (input == null) return '';
  const s = String(input).trim();
  const m = /^rank[_-]?(\d+)([kd])$/i.exec(s) || /^(\d+)([kd])$/i.exec(s);
  if (m) return `${Number(m[1])}${m[2].toUpperCase()}`;
  return s; // 已是非标（如人工段位文本），原样返回
}

/** 四舍五入（保留 d 位，对称 half-away-from-zero；负零归零）。 */
export function round(v, d = 0) {
  if (v == null || !Number.isFinite(Number(v))) return NaN;
  const n = Number(v);
  const p = 10 ** d;
  const neg = n < 0 ? -1 : 1;
  const r = (Math.round(Math.abs(n) * p) / p) * neg;
  return Object.is(r, -0) ? 0 : r;
}

/** 补符号（正 + / 负 U+2212）的定点文本；v null/NaN → ''。d=0 整数。 */
export function signed(v, d = 1, plus = true) {
  const r = round(v, d);
  if (!Number.isFinite(r)) return '';
  const neg = r < 0;
  const abs = Math.abs(r);
  const body = abs.toFixed(d).replace(/\.0+$/, '');
  return `${neg ? '−' : plus ? '+' : ''}${body}`;
}

/** 胜率（百分数 0–100）→ '54.2%'（无符号）；v null → ''。 */
export function pct(v, d = 1) {
  const r = round(v, d);
  if (!Number.isFinite(r)) return '';
  return `${r.toFixed(d).replace(/\.0+$/, '')}%`;
}

/** 胜率条 / 紧凑场景 → '43%'（整数）。 */
export function pctCompact(v) {
  const r = round(v, 0);
  if (!Number.isFinite(r)) return '';
  return `${r}%`;
}

/** 带符号百分变化（如 coach 行 '+4.2%'、胜率条 delta '−5%'）→ `${signed}%`。 */
export function signedPct(v, d = 1) {
  const s = signed(v, d, true);
  return s === '' ? '' : `${s}%`;
}

/** 目差 → '+3.1'（coach-sl 等无单位列）。 */
export function scoreLead(v) {
  return signed(v, 1, true);
}

/** 目差带单位 → '+3.1 目'（侧栏当前目差 / ΔS 行）。 */
export function scoreLeadUnit(v) {
  const s = signed(v, 1, true);
  return s === '' ? '' : `${s} 目`;
}

/** Visit 列：<1000 整数；≥1000 → '1.2k'（1 位小数去尾 0）；后接 ' Visit'。 */
export function visits(v) {
  if (v == null || v === '') return '';
  const n = Number(v);
  if (!Number.isFinite(n)) return '';
  const abs = Math.abs(n);
  const num = abs >= 1000 ? `${round(abs / 1000, 1)}k` : String(Math.round(abs));
  return `${num} Visit`;
}

/**
 * 相对时间文案：≤thresholdDays 返回相对（刚刚/分钟前/小时前/昨天/N 天前）；
 * 更早回退绝对时间（Intl）。now 与 rtf 可注入（无头测试确定性）。
 */
export function relTimeText(ts, opts = {}) {
  const time = toTime(ts);
  if (time == null) return '';
  const now = toTime(opts.now != null ? opts.now : Date.now());
  const thresholdDays = opts.thresholdDays ?? 7;
  const diffSec = (time - now) / 1000;
  // 1 分钟内（含时钟微小偏移的未来）→ 刚刚
  if (diffSec > -60) return '刚刚';
  const abs = -diffSec;
  const minutes = Math.floor(abs / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days === 1) return '昨天';
  if (days <= thresholdDays) return `${days} 天前`;
  return absoluteTimeText(time, opts);
}

/** 绝对时间 → Intl.DateTimeFormat（zh-CN），可注入 formatter 以便测试固定 locale/时区。 */
export function absoluteTimeText(ts, opts = {}) {
  const time = toTime(ts);
  if (time == null) return '';
  const fmt =
    opts.formatter ||
    new Intl.DateTimeFormat('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  return fmt.format(new Date(time));
}

/** 归一时间为 ms 数值（Date|number|ISO string|SQLite naive）；非法 → null。
 *
 * SQLite ``datetime('now')`` 输出 ``'YYYY-MM-DD HH:MM:SS'``（**UTC 无时区标记**）；
 * 若直接交给 ``Date.parse`` 会被当作本地时间，产生整时区偏移（如 UTC+8 错 8 小时）→
 * 统一按 UTC 解析。含时区（Z/±HH:MM）或 ISO 的字符串维持原解析。 */
export function toTime(ts) {
  if (ts == null) return null;
  if (ts instanceof Date) return Number.isNaN(ts.getTime()) ? null : ts.getTime();
  if (typeof ts === 'number') return Number.isFinite(ts) ? ts : null;
  if (typeof ts === 'string') {
    const s = String(ts).trim();
    let parsed;
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) {
      parsed = Date.parse(`${s.replace(' ', 'T')}Z`);
    } else {
      parsed = Date.parse(s);
    }
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

/**
 * 结果文本：backend result 形如 `B+7.5 / W+2 / B+Resign / W+Resign / Draw`。
 * verbose=true（侧栏/报告）→ '黑胜 7.5 目 (B+7.5)'；false（列表行）→ '黑胜 3.5'/'白中盘胜'。
 */
export function resultText(result, opts = {}) {
  if (result == null || result === '') return '';
  const verbose = opts.verbose !== false;
  const s = String(result).trim();
  if (/^draw$/i.test(s)) return '和棋';
  const m = /^([BWbw])\+([0-9.]+|[Rr][Ee][Ss][Ii][Gg][Nn]?|[Tt])$/.exec(s) || /^([BWbw])\+([^+]+)$/.exec(s);
  if (!m) return s;
  const side = /^[Bb]$/.test(m[1]) ? '黑' : '白';
  const val = m[2];
  if (/^[0-9.]+$/.test(val)) {
    const pts = round(Number(val), 1);
    const body = `${side}胜 ${pts} 目`;
    return verbose ? `${body} (${s})` : body;
  }
  // 中盘/超时等无目数获胜
  const body = `${side}中盘胜`;
  return verbose ? `${body} (${s})` : body;
}

/** 点评主文案 → grade 映射；未知 grade 返回输入。 */
export function gradeText(grade) {
  return GRADE_TEXT[grade] || String(grade == null ? '' : grade);
}

/** 口语二名；未知返回主文案。 */
export function gradeAlt(grade) {
  return GRADE_ALT[grade] || gradeText(grade);
}

/** 气泡标题：'失误（恶手）'。 */
export function gradeBubbleTitle(grade) {
  const g = GRADE_TEXT[grade];
  if (!g) return '';
  const alt = GRADE_ALT[grade];
  return alt && alt !== g ? `${g}（${alt}）` : g;
}

/**
 * 胜率单位归一（**唯一换算模块**：`core/fmt.js`）。
 *
 * 口径（2026/09/11 人工确认，ISSUE-050 细化）：API/WS 载荷中的 `winrate` 一律
 * 已由**后端输出边界**（`api/public.py::winrate_to_percent`）换算为 0..100 百分比
 * ——前端**不得再次换算**（曾出现报告弹层 `ΔW −690%` 的重复 ×100）。
 * 本函数仅供内部小数口径（如无头测试/旧曲线数据）显式换算：`unit='percent'` 原样返回。
 */
export function winrateToPercent(v, unit = 'fraction') {
  if (v == null || !Number.isFinite(Number(v))) return null;
  const n = Number(v);
  return unit === 'fraction' ? n * 100 : n;
}

/**
 * 比例（0..1 内部量，如吻合度/覆盖率/构成占比）→ 百分比数值（不取整）。
 *
 * 说明：此类字段（`match_rate`/覆盖率等）在 API 契约中就是 0..1 小数，与 winrate 的
 * “后端已换算为百分数”不同；为把**所有 ×100 收敛到本模块**（视图层禁止 ×100，
 * 见 `tests/contracts.test.js::FE-CTR-02`），统一经此函数换算。
 */
export function fractionToPercent(v) {
  if (v == null || !Number.isFinite(Number(v))) return null;
  return Number(v) * 100;
}
