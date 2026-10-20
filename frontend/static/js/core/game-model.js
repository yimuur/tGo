/**
 * tGo · 对弈视图纯函数模型（T6.4 GameView core）
 *
 * 将状态树（store）的 ``game`` 切片派生为 GameBoard / DOM 所需数据：
 *   - 让子点 / 吃子回放（``replayStones``）：由于服务端 ``moves`` 不含被提子列表，
 *     当前棋面必须由「让子初始石 + 逐手回放 + 吃子移除」模拟得出（纯逻辑，无 DOM）；
 *   - 回合/降级派生（人人 vs 人机、TURN_AI、引擎 DEAD、AI 自动开局判定）；
 *   - 信息行 / 底部行 / 悔棋剩余 / BoardNote 文本等派生。
 *
 * 约定：本模块**顶层无 DOM 副作用**，可在 Node 无头测试（FE-GM-*）。
 */

import { gtpOf } from './board.js';
import { engineStateClass } from './engine-state.js';
import { gradeAlt, gradeText, rankText, scoreLead, signedPct } from './fmt.js';

/* ============================================================
 * 常量
 * ============================================================ */

/** 12 档棋力段位（顺序 = 后端 RANK_LEVELS / LEVEL.md 难度档位 1..12）。 */
export const LEVEL_RANK_CODES = Object.freeze([
  'rank_20k', 'rank_15k', 'rank_10k', 'rank_8k',
  'rank_5k', 'rank_3k', 'rank_1k', 'rank_1d',
  'rank_3d', 'rank_5d', 'rank_7d', 'rank_9d',
]);

/** 规则集显示文案（与 create-wizard 同源；此处仅对弈信息行使用）。 */
export const RULE_LABELS = Object.freeze({ chinese: '中国', japanese: '日本', aga: 'AGA' });

/**
 * 让子点位基座（镜像后端 go_rules.py；国际经典序，见 BUG-050）。
 * corners 放置序：右上→左下→右下→左上；sides：左→右→上→下。
 */
const HANDICAP_BASE = Object.freeze({
  19: {
    corners: [[15, 3], [3, 15], [15, 15], [3, 3]],
    sides: [[3, 9], [15, 9], [9, 3], [9, 15]],
    center: [9, 9],
  },
  13: {
    corners: [[9, 3], [3, 9], [9, 9], [3, 3]],
    sides: [[3, 6], [9, 6], [6, 3], [6, 9]],
    center: [6, 6],
  },
  9: {
    corners: [[6, 2], [2, 6], [6, 6], [2, 2]],
    sides: [[2, 4], [6, 4], [4, 2], [4, 6]],
    center: [4, 4],
  },
});

/** 各尺寸让子上限（镜像后端 HANDICAP_LIMITS：9/13/19 路 → 4/6/9；未知尺寸 → 0）。 */
export function handicapLimit(size) {
  return { 9: 4, 13: 6, 19: 9 }[Number(size)] || 0;
}

/* ============================================================
 * 颜色工具（状态树 B/W ↔ 棋盘 black/white）
 * ============================================================ */

/** 'B'|'W' → 'black'|'white'。 */
export function boardColor(c) {
  return c === 'W' || c === 'white' ? 'white' : 'black';
}

/** 'black'|'white' → 'B'|'W'。 */
export function sideColor(c) {
  return c === 'white' || c === 'W' ? 'W' : 'B';
}

/** 同格式取反：'B'→'W'、'W'→'B'、'black'→'white'、'white'→'black'。 */
export function otherColor(c) {
  const isWhite = c === 'W' || c === 'white';
  if (c === 'B' || c === 'W') return isWhite ? 'B' : 'W';
  return isWhite ? 'black' : 'white';
}

/** 段位枚举（12 档）→ 显示 '5K'/'1D'；level 1..12 越界钳制；null/缺省回退 5K。 */
export function aiLevelText(level) {
  const n = level === null || level === undefined || level === '' ? NaN : Number(level);
  // 缺省档位 5（rank_5k，idx 4）；LEVEL.md 默认初始 5K
  const idx = Math.max(1, Math.min(12, Number.isFinite(n) ? Math.round(n) : 5)) - 1;
  return rankText(LEVEL_RANK_CODES[idx]);
}

/** 人机 AI 风格显示文案（人工口径 2026/09/10：标准 / 拟人 / 匹配）。 */
export const AI_MODE_LABELS = Object.freeze({
  standard: '标准',
  human: '拟人',
  adaptive: '匹配',
});

/**
 * 人机对局 **AI 侧**显示派生：名称恒为 `AI` + 难度段位短标 + 风格标签
 * （人工口径：`AI` 右上段位标志`[5K]` · 标准/拟人/匹配）。
 *
 * 服务端 `black_name`/`white_name` 对 AI 侧无意义（旧数据落「真人」），
 * 展示以对局参数派生为准（人类侧仍读快照 name/rank）。
 *
 * 入参兼容状态树 game（`params.*`）与 API GameInfo 行（snake_case，两版通用）。
 * @param {object|null} source
 * @param {'black'|'white'} side
 * @returns {{name:string, rank:string, tag:string}|null} 非 AI 侧 → null（沿用原显示）
 */
export function aiSideDisplay(source, side) {
  if (!source) return null;
  const p = source.params || null;
  const mode = p ? p.mode : source.mode;
  if (mode !== 'human_ai') return null;
  const humanColor = p ? p.humanColor : source.human_color;
  // human_color='B' → AI 执白；'W'/缺省 → AI 执黑（与后端 _ai_color 同口径）
  const aiSide = humanColor === 'B' ? 'white' : 'black';
  if (side !== aiSide) return null;
  const aiStyle = p ? p.aiStyle : source.ai_style;
  const aiLevel = p ? p.aiLevel : source.ai_level;
  const adaptive = p ? p.adaptiveEnabled : source.adaptive_enabled;
  const tag = adaptive
    ? AI_MODE_LABELS.adaptive
    : aiStyle === 'human' ? AI_MODE_LABELS.human : AI_MODE_LABELS.standard;
  return { name: 'AI', rank: aiLevelText(aiLevel), tag };
}

/* ============================================================
 * 让子 / 棋面回放（吃子模拟）
 * ============================================================ */

/**
 * 国际经典让子点位（1-9 子；1-4 四角 → 5/7 子天元入座、6/8 子不着天元）。
 * 仅显示用——须与后端 go_rules.py 镜像一致（服务端按此序下发 initialStones）。
 * 非法尺寸/数量钳制为空/最大子集。
 */
export function handicapPoints(size, handicap) {
  const n = Number(handicap) || 0;
  if (n <= 0) return [];
  const base = HANDICAP_BASE[Number(size)];
  if (!base) return [];
  const { corners, sides, center } = base;
  const seq = [...corners, ...sides];
  let pts;
  if (n <= 4) pts = seq.slice(0, n);
  else if (n === 5) pts = [...corners, center];
  else if (n === 6) pts = seq.slice(0, 6);
  else if (n === 7) pts = [...seq.slice(0, 6), center];
  else if (n === 8) pts = seq.slice(0, 8);
  else pts = [...seq.slice(0, 8), center];  // 9 子（含）以上 → 全 9 星
  return pts.map(([x, y]) => ({ x, y, color: 'black' }));
}

/**
 * 由「让子 + 落子序列（回放至 ``upto``）」推导**当前棋面**棋子（含吃子移除）。
 * @param {object} opts
 * @param {number} [opts.size=19]       路数 9|13|19
 * @param {number} [opts.handicap=0]    让子数（黑子）
 * @param {Array<{moveNo,color,x,y,isPass}>} [opts.moves] 归一 move（B/W）
 * @param {number} [opts.upto]          仅回放 moveNo ≤ upto 的手（缺省全部）
 * @returns {Array<{x:number,y:number,color:'black'|'white',moveNo?:number}>}
 */
export function replayStones({ size = 19, handicap = 0, moves = [], upto } = {}) {
  const n = Number(size);
  const grid = Array.from({ length: n }, () => Array(n).fill(null));
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const limit = upto === undefined || upto === null ? Infinity : Number(upto);

  for (const { x, y } of handicapPoints(size, handicap)) {
    if (x >= 0 && y >= 0 && x < n && y < n) grid[y][x] = 'black';
  }

  /** 同色棋串 + 气（空点邻域）集合。 */
  function groupAndLiberties(sx, sy) {
    const color = grid[sy][sx];
    const seen = new Set();
    const liberties = new Set();
    const stack = [[sx, sy]];
    while (stack.length) {
      const [x, y] = stack.pop();
      const k = `${x},${y}`;
      if (seen.has(k)) continue;
      seen.add(k);
      for (const [dx, dy] of dirs) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
        const c = grid[ny][nx];
        if (c === null) liberties.add(`${nx},${ny}`);
        else if (c === color && !seen.has(`${nx},${ny}`)) stack.push([nx, ny]);
      }
    }
    return { stones: [...seen], liberties };
  }

  const sorted = (Array.isArray(moves) ? moves : [])
    .slice()
    .sort((a, b) => Number(a.moveNo) - Number(b.moveNo));

  for (const m of sorted) {
    if (m.isPass || m.x === null || m.x === undefined || m.y === null || m.y === undefined) continue;
    if (Number(m.moveNo) > limit) break;
    const x = Number(m.x);
    const y = Number(m.y);
    if (x < 0 || y < 0 || x >= n || y >= n) continue;
    const color = m.color === 'white' || m.color === 'W' ? 'white' : 'black';
    grid[y][x] = color;
    let capturedAny = false;
    for (const [dx, dy] of dirs) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
      const c = grid[ny][nx];
      if (c && c !== color) {
        const g = groupAndLiberties(nx, ny);
        if (g.liberties.size === 0) {
          for (const k of g.stones) {
            const [gx, gy] = k.split(',').map(Number);
            grid[gy][gx] = null;
          }
          capturedAny = true;
        }
      }
    }
    // 自杀防护（服务端已禁，仅兜底）：无气且未提子 → 回滚
    const own = groupAndLiberties(x, y);
    if (own.liberties.size === 0 && !capturedAny) grid[y][x] = null;
  }

  const stones = [];
  const placed = new Map(); // 落子手数（供 GameBoard 当前手标记）
  for (let y = 0; y < n; y += 1) {
    for (let x = 0; x < n; x += 1) {
      if (grid[y][x]) stones.push({ x, y, color: grid[y][x] });
    }
  }
  for (const m of sorted) {
    if (m.isPass || m.x === null || m.x === undefined || m.y === null || m.y === undefined) continue;
    if (Number(m.moveNo) > limit) break;
    placed.set(`${m.x},${m.y}`, Number(m.moveNo));
  }
  for (const s of stones) {
    const mn = placed.get(`${s.x},${s.y}`);
    if (mn !== undefined) s.moveNo = mn;
  }
  return stones;
}

/** 便捷：由状态树 game 切片推导当前棋面子。 */
export function stonesForGame(game) {
  if (!game) return [];
  const p = game.params || {};
  return replayStones({
    size: p.boardSize || 19,
    handicap: p.handicap || 0,
    moves: game.moves || [],
  });
}

/* ============================================================
 * 回合 / 引擎降级派生
 * ============================================================ */

export function isHumanAi(g) {
  return Boolean(g && g.params && g.params.mode === 'human_ai');
}

/** 人机：AI 执色 side（B/W）。 */
export function aiColorOf(g) {
  return g && g.params && g.params.humanColor ? otherColor(g.params.humanColor) : 'W';
}

/**
 * 落子动画“由下到上”侧（2026/09/13 人工口径）：
 *   - 人机对弈＝**人类方**（人类落子自棋盘下方落入、AI 落子自上方落入，与执色无关）；
 *   - 人人对弈＝**黑方**（黑自下方落入、白自上方落入）。
 * 入参兼容状态树 game（`params.*`，humanColor 'B'/'W'）与 API 行（snake_case）。
 * @param {object|null} source
 * @returns {'black'|'white'} 自棋盘下方落入的一方
 */
export function dropUpSide(source) {
  if (!source) return 'black';
  const p = source.params || null;
  const mode = p ? p.mode : source.mode;
  if (mode === 'human_ai') {
    const hc = p ? p.humanColor : source.human_color;
    return hc === 'W' || hc === 'white' ? 'white' : 'black'; // 'B'/缺省＝人类执黑
  }
  return 'black'; // 人人对弈：黑方由下到上
}

/** 进行中（PLAYING/created 均可操作，首手自动开局）。 */
export function isInPlay(g) {
  return Boolean(g && (g.status === 'active' || g.status === 'created'));
}

/**
 * 下一手执色（服务器 `game_service._next_color` 的**本地同源推导**，BUG-094）。
 *
 * 口径（DATABASE §3.3）：`moveNo = lastMoveNo + 1`；让子局（`handicap > 0`）白先，
 * 否则黑先（PASS 同样计入手数）——与 `game.state.next_color` **完全同源**
 * （只看手数奇偶，不看落子内容），因此客户端复算与服务器一致。
 *
 * 用途：`defer_ai` 化后 AI 应手期**不广播 game.state**（WS 只在 AI 收尾/失败时推送），
 * `move.applied` 也不推进 `nextColor` → store 的 `next_color` 在该窗口是**陈旧值**；
 * 20s busy 兜底清锁后若仍读陈旧值，会把「AI 待行」误判成人类回合
 * （提子计数器当前方翻人类 / 思考胶囊消失 / 棋盘误可点 / 支招误可用）。
 * @returns {'B'|'W'|null} null＝数据不足（调用方退化用快照值）
 */
export function nextColorOf(g) {
  const last = g ? g.lastMoveNo : null;
  if (last === undefined || last === null) return null;
  const moveNo = Number(last) + 1;
  if (!Number.isFinite(moveNo) || moveNo <= 0) return null;
  const handicap = Number(g.params && g.params.handicap) || 0;
  const first = handicap > 0 ? 'W' : 'B'; // 让子棋白先（DATABASE §3.3）
  return moveNo % 2 === 1 ? first : otherColor(first);
}

/** 当前应落子方（回合派生统一口径：本地推导优先，快照值兜底）。 */
export function nextColorToMove(g) {
  return nextColorOf(g) || (g && g.nextColor) || null;
}

/**
 * 棋盘是否允许点击落子：
 * - 人人：PLAYING/created 均开放（共享棋盘语义，服务端推导当前方）；
 * - 人机：仅轮到人类执色时开放（``TURN_AI``/AI 先行时禁输入）。
 * @param {object} g 状态树 game
 * @param {boolean} [pending] 本地发送中（AI 思考/等待服务端回包时禁输入防指令堆积）
 */
export function boardInteractive(g, pending = false) {
  if (!isInPlay(g)) return false;
  if (pending) return false;
  if (!isHumanAi(g)) return true;
  return nextColorToMove(g) === g.params.humanColor;
}

/** 引擎不可用（DEAD/FATAL）→ 人机棋盘降饱和 + 警示条（分类统一取 `engineStateClass`）。 */
export function engineDown(engineState) {
  const cls = engineStateClass(engineState);
  return cls === 'recovering' || cls === 'fatal';
}

/** 棋盘 engineDead prop：仅人机在引擎 DEAD/FATAL 时灰化（人人不阻断）。 */
export function boardEngineDead(g, engineState) {
  return isHumanAi(g) && engineDown(engineState);
}

/** 是否应显示「AI 思考/等待」胶囊（人机且轮到 AI）。 */
export function aiWaitVisible(g, pending = false) {
  if (!isHumanAi(g)) return false;
  if (!isInPlay(g)) return false;
  // 服务端明确回投「AI 应手挂起」（ai_pending，R2）：以服务端事实为准展示胶囊
  // （本地奇偶推导用于抗 defer 窗口陈旧快照；两者不一致时以显式挂起为准）
  if (g.aiPending) return true;
  if (pending) return true; // 人类刚落子，服务端正在执行 AI（同步）
  return nextColorToMove(g) === aiColorOf(g);
}

/** AI 胶囊文案（区分引擎异常/人类模型缺失/AI 应手失败：等待恢复 vs 失败 vs 思考中）。
 *  优先级：引擎 DEAD/FATAL（瞬时故障，可重试）先于 ``humanModelUnavailable``（B2，
 *  人类风格对局的 AI 因人类模型未挂载被阻断——引擎恢复后仍生效）；
 *  ``aiPending``（R2，服务端 AI 应手后台失败原因随 game.state 回投）先于「思考中」——
 *  否则引擎仍可用（如单次查询失败）时 UI 永远显示「思考中」，无从判断应手已失败。 */
export function aiWaitLabel(engineState, { humanModelUnavailable = false, aiPending = null } = {}) {
  const st = String(engineState || '').toUpperCase();
  if (st === 'DEAD' || st === 'FATAL') return '等待引擎恢复';
  if (humanModelUnavailable) return '人类模型不可用';
  if (aiPending) return 'AI 应手失败';
  return '思考中';
}

/** AI 应手失败自动重试延迟序列（R2，最多 2 次；仅 ``aiPending`` 存在且引擎可用时）。 */
export const AI_RETRY_DELAYS_MS = [5000, 15000];

/**
 * AI 应手失败（``game.aiPending``）的重试决策（纯函数，R2）。
 *
 * 仅在「服务端确实回投了挂起原因」时重试（不猜“思考太久”）：引擎 DEAD/FATAL 与
 * 人类模型缺失不重试（无意义），等引擎状态变化后由 store 变更自然重试。
 * @param {{pending?:boolean, engineState?:string, humanModelUnavailable?:boolean,
 *          scheduled?:boolean, attempts?:number}} opts
 * @returns {{action:'schedule'|'none', delayMs:number|null}}
 */
export function aiRetryPlan({
  pending = false,
  engineState = '',
  humanModelUnavailable = false,
  scheduled = false,
  attempts = 0,
} = {}) {
  if (!pending || scheduled) return { action: 'none', delayMs: null };
  if (engineDown(engineState) || humanModelUnavailable) return { action: 'none', delayMs: null };
  const delay = AI_RETRY_DELAYS_MS[attempts];
  if (delay === undefined) return { action: 'none', delayMs: null };
  return { action: 'schedule', delayMs: delay };
}

/** 人类风格/自适应难度需要人类模型（PRD §4.1.1：缺失时仅标准风格可用）。 */
export function needsHumanModel(g) {
  if (!isHumanAi(g)) return false;
  const p = (g && g.params) || {};
  return p.aiStyle === 'human' || Boolean(p.adaptiveEnabled);
}

/**
 * 是否应自动发送 WS ``start``（开局/续行）：
 * 人机且轮到 AI 行动（created AI 先行 / active ``TURN_AI`` 挂起恢复），
 * 且引擎非 DEAD/FATAL（IDLE 直接执行；STOPPED 未启动 / INIT 加载中 / 未知=按需
 * 加载——服务端 ``ai_move`` 经 manager.ensure_ready 就地拉起引擎并等待就绪后落子）。
 * 由视图单次触发（token 含引擎态，防同态重复发）。
 *
 * ``humanModelUnavailable``（B2，2026/09/10 人工决策）：人类模型未挂载时
 * 人类风格对局无法续行——不发无意义 start（提示由胶囊/横幅呈现，恢复后自动续行）。
 */
export function aiShouldAutoStart(
  g,
  engineState,
  pending = false,
  { humanModelUnavailable = false } = {},
) {
  if (pending || !isHumanAi(g)) return false;
  if (!isInPlay(g)) return false;
  if (humanModelUnavailable) return false;
  const st = String(engineState || '').toUpperCase();
  if (st === 'DEAD' || st === 'FATAL') return false;
  return g.nextColor === aiColorOf(g);
}

/* ============================================================
 * 悔棋 / 信息行 / BoardNote 派生
 * ============================================================ */

/** 悔棋剩余次数 = max(0, 上限 − undo_count)；上限取 config.play.max_undo。 */
export function undoRemaining(g, maxUndo) {
  const cap = Number(maxUndo);
  if (!Number.isFinite(cap) || cap <= 0) return 0;
  const used = g && g.undoCount !== undefined ? Number(g.undoCount) || 0 : 0;
  return Math.max(0, cap - used);
}

/** 悔棋按钮文案（UI_UX §5.2.4：悔棋（N）＝剩余次数）。 */
export function undoLabel(remaining) {
  return `悔棋（${Math.max(0, remaining)}）`;
}

/** 对局信息行分段（§5.2.3：第 N 手 · 路数 · 规则 · 贴目 · 分先/让子 · 对弈模式）。
 *  2026/09/06 人工反馈：人人对弈也须显示对弈模式 → human_human 追加「人人」段
 *  （人机由 AI 档位段隐式表达；人人无 AI 段故显式标注）。
 *  2026/09/09（T6.10）：新增本地偏好入参 ``showMatchRank``——自适应难度时开=
 *  `AI 匹配 · 5K`、关=`AI 自适应`（UI_UX §5.2.3，管理页「显示当前 AI 匹配档位」）。
 *  2026/09/14：`AI 自适应` 同 `AI 匹配 · X` 一并归入徽章段（`badge:'accent'`）——信息行
 *  两组文案同为「AI 档位徽章」，移动端单行省略时固定完整显示（分组见 core/info-row.js）。
 *  2026/09/10：新增 ``coach``（自动点评开关态）——创建时开启点评的对局追加可点击
 *  徽章段（`{coach:true, on}`，视图渲染为 `data-act="coachToggle"` 按钮）。
 */
export function metaSegments(g, { showMatchRank = true, coach = null } = {}) {
  if (!g) return [];
  const p = g.params || {};
  const segs = [{ text: `第 ${g.lastMoveNo || 0} 手` }];
  segs.push({ text: `${p.boardSize || 19}路` });
  if (p.rules) segs.push({ text: RULE_LABELS[p.rules] || p.rules });
  if (p.komi !== undefined && p.komi !== null) segs.push({ text: `贴 ${p.komi}` });
  if ((p.handicap || 0) > 0) segs.push({ text: `让 ${p.handicap} 子` });
  else segs.push({ text: '分先' });
  if (p.mode === 'human_human') {
    segs.push({ text: '人人' });
  } else if (p.mode === 'human_ai') {
    if (p.adaptiveEnabled) {
      segs.push(
        showMatchRank
          ? { text: `AI 匹配 · ${aiLevelText(p.aiLevel)}`, badge: 'accent' }
          : { text: 'AI 自适应', badge: 'accent' },
      );
    }
    else if (p.aiStyle === 'human') segs.push({ text: `人类 · ${aiLevelText(p.aiLevel)}` });
    else segs.push({ text: `标准 · ${aiLevelText(p.aiLevel)}` });
  }
  // 自动点评开关（仅创建时开启点评的对局；人工口径 2026/09/10：徽章可点击开/关）
  if (p.coachingEnabled && coach) {
    segs.push({ text: '自动点评', coach: true, on: coach.enabled !== false });
  }
  return segs;
}

/**
 * 当前执色方视角值 → **黑方视角**（对局信息卡 / 胜率目差曲线等固定黑方展示用）。
 *
 * 视角约定（2026/09/11 人工确认）：AI 支招/推荐/点评载荷为当前执色方（或落子方）
 * 视角；信息卡与曲线固定黑方 —— 需要时经此单一换算点回黑方。
 * @param {number|null} value 当前执色方视角值（胜率百分比或目差）
 * @param {'B'|'W'|null} side 载荷视角方
 * @returns {number|null} 黑方视角值（side='W' 时取反/取补）
 */
export function blackSideValue(value, side) {
  if (value == null || !Number.isFinite(Number(value))) return null;
  const v = Number(value);
  if (side !== 'W') return v;
  return 100 - v;
}

/**
 * 当前执色方视角目差 → 黑方视角目差（白方取负）。
 * @param {number|null} value 当前执色方视角目差
 * @param {'B'|'W'|null} side 载荷视角方
 * @returns {number|null}
 */
export function blackSideScore(value, side) {
  if (value == null || !Number.isFinite(Number(value))) return null;
  const v = Number(value);
  return side === 'W' ? -v : v;
}

/**
 * 点评气泡文案（对弈/复盘共用）：`白 第 N 手 · 失误（恶手）` + `ΔW … · ΔS … 目`。
 *
 * 视角（2026/09/11 人工确认）：ΔW/ΔS 为**落子方视角**（好手正、恶手负），
 * 故文案标注落子方（黑/白），避免与“当前执色方视角”的支招/推荐卡混淆；
 * ΔS=`score_delta`（目数变化，恶手为负，与 ΔW 同向）。
 * @param {object|null} comment ``{grade, color?, delta_winrate(%), score_delta}``
 * @param {number|string} moveNo 手数显示（对弈=绝对手数；复盘=当前显示手）
 * @returns {{grade:string, line1:string, line2:string}|null} 无 grade → null
 */
export function commentBubbleModel(comment, moveNo) {
  const c = comment || {};
  if (!c.grade) return null;
  const bits = [
    c.delta_winrate != null ? `ΔW ${signedPct(c.delta_winrate, 1)}` : '',
    c.score_delta != null ? `ΔS ${scoreLead(c.score_delta)} 目` : '',
  ].filter(Boolean);
  const side = c.color === 'W' ? '白' : c.color === 'B' ? '黑' : '';
  return {
    grade: c.grade,
    line1: `${side ? `${side} ` : ''}第 ${moveNo} 手 · ${gradeText(c.grade)}（${gradeAlt(c.grade)}）`,
    line2: bits.join(' · '),
  };
}

/**
 * 简洁着法文本（棋盘左上角提示，2026/09/13 人工口径）：`白 J3`；PASS → `白 PASS`。
 * 无手数信息；空着法 → null。
 */
export function shortMoveText(move, size) {
  if (!move) return null;
  const color = move.color === 'W' ? '白' : '黑';
  const coord = move.isPass ? 'PASS' : gtpOf(Number(move.x), Number(move.y), Number(size) || 19);
  return `${color} ${coord}`;
}

/** 末手描述（BoardNote 动效行）：`text`＝无障碍/完整文案（含手数）；`short`＝棋盘提示。 */
export function lastMoveDesc(moves, size) {
  const list = Array.isArray(moves) ? moves : [];
  const last = list.length ? list[list.length - 1] : null;
  if (!last) return null;
  const color = last.color === 'W' ? '白' : '黑';
  const coord = last.isPass ? 'PASS' : gtpOf(Number(last.x), Number(last.y), Number(size) || 19);
  return {
    moveNo: Number(last.moveNo),
    color: last.color,
    isPass: Boolean(last.isPass),
    coord,
    text: `第 ${last.moveNo} 手 · ${color} ${coord}`,
    short: shortMoveText(last, size),
  };
}

/** 提子数/当前方（底部行）：captures + 当前执色。 */
export function capturesState(g) {
  if (!g) return { black: 0, white: 0, toMove: null };
  const next = nextColorToMove(g);
  return {
    black: g.captures ? Number(g.captures.black) || 0 : 0,
    white: g.captures ? Number(g.captures.white) || 0 : 0,
    toMove: isInPlay(g) && next ? boardColor(next) : null,
  };
}
