/**
 * tGo · 终局结算面板（T6.6，ScoringPanel，C9 / UI_UX §5.4 三阶段）
 *
 * 职责（TASK.md T6.6 / PROPS C9 / UI_UX §5.4 / W-20）：
 *   - **死子确认**：进入 SCORING 显示 ① 死子确认。预判死子与预判结果由**后端**
 *     终局深算推导（``scoring.prediction``：ownership 链级启发式判定死子 + GTP
 *     ``final_score`` 等价结果，2026/09/11 人工确认；引擎不可用/失败 ``engine:false``
 *     → 手动标记）；点击棋子切换 ✕、[全部清除]、[跳过]（空 dead_points 直接结算）、
 *     [全部确认]（按当前标记结算——后端 Python 数子与预判同口径）；
 *   - **数子结果**：``game.finished {result, black_score, white_score}`` 后进入
 *     （② 数子结果大字 + 黑白目数/贴目/手数网格 + [显示领地] 热力叠加 +
 *     ③ 后续操作 [再来一局][复盘][对局报告(analysis_complete 门控)][结束]）；
 *   - **结算取消**：[继续对弈] → ``scoring.cancel``（SCORING→PLAYING，可重确认）；
 *   - **再来一局**：直接同参数 ``POST /api/games`` 创建并跳转（2026/09/06 人工确认）；
 *   - 多设备信任模型：任一终端确认即生效（API §4.3，无设备锁），其它终端收到
 *     ``game.finished`` 即展示结果。
 *
 * 分层（同 game-sidebar / game-view 约定）：**纯函数层**（无 DOM，可无头测试，
 * FE-SC-*）+ ``createScoringPanelModule``（DOM 呈现 + store 订阅；不直写棋盘——
 * 棋盘由 game-view 驱动，本模块经 deps.board 读棋盘 announce、经 deps.onDead
 * 把死子集合回写到 board deadStones）。
 */

import { gtpOf } from '../core/board.js';
import { hasOpenDialogMask } from '../core/dialog.js';
import { isHumanAi } from '../core/game-model.js';
import { resultText, rankText } from '../core/fmt.js';
import { playersLineHTML } from './game-sidebar.js';

/** M-9：结算确认/取消等待回包上限（ms）——超时解除按钮锁（防「确认中」永久禁用）。 */
export const SCORING_CONFIRM_TIMEOUT_MS = 12000;

/**
 * M-9：确认/取消等待守卫（无 DOM 依赖；无头可测）。
 *
 * ``arm()`` 重新计时（旧计时先清）、``done()`` 清除；超时回调在仍处于 pending
 * 时触发一次后自行失效。确认/取消提交后至服务端广播到达前的窗口内，若回包丢失
 * （断线/引擎无响应/消息错序），面板必须能自行解除按钮锁，否则永久停在「确认中」。
 * @param {Function} onTimeout
 * @param {{setTimeoutImpl?:Function, clearTimeoutImpl?:Function, delayMs?:number}} [opts]
 */
export function createConfirmGuard(onTimeout, opts = {}) {
  const setT = opts.setTimeoutImpl || ((fn, ms) => setTimeout(fn, ms));
  const clearT = opts.clearTimeoutImpl || ((id) => clearTimeout(id));
  const delayMs = Number(opts.delayMs) > 0 ? Number(opts.delayMs) : SCORING_CONFIRM_TIMEOUT_MS;
  let timer = null;
  return {
    arm() {
      this.done();
      timer = setT(() => {
        timer = null;
        onTimeout();
      }, delayMs);
    },
    done() {
      if (timer != null) {
        clearT(timer);
        timer = null;
      }
    },
    get pending() {
      return timer != null;
    },
  };
}

/* ============================================================
 * 纯函数层（无 DOM；可无头测试）
 * ============================================================ */

/** 死子/坐标集合点键。 */
export function pointKey(x, y) {
  return `${x},${y}`;
}

/** 归一坐标列表：数值化、去重、剔除非法（null/负/非数）。 */
export function normalizePoints(points) {
  const out = [];
  const seen = new Set();
  for (const it of Array.isArray(points) ? points : []) {
    if (!it || typeof it !== 'object' || it.x == null || it.y == null) continue;
    const x = Math.trunc(Number(it.x));
    const y = Math.trunc(Number(it.y));
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) continue;
    const k = pointKey(x, y);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ x, y });
  }
  return out;
}

/** 切换一点死子标记（有则移除、无则追加），返回新列表。 */
export function toggleDeadPoint(list, x, y) {
  const pts = normalizePoints(list);
  const px = Math.trunc(Number(x));
  const py = Math.trunc(Number(y));
  if (!Number.isFinite(px) || !Number.isFinite(py) || px < 0 || py < 0) return pts;
  const i = pts.findIndex((p) => p.x === px && p.y === py);
  if (i >= 0) pts.splice(i, 1);
  else pts.push({ x: px, y: py });
  return pts;
}

/** 死子列表 → 服务端坐标对数组 ``[[x,y],...]``（scoring.confirm 载荷）。 */
export function deadToTuples(list) {
  return normalizePoints(list).map((p) => [p.x, p.y]);
}

/** 分数格式化：整数原样、一位小数去尾 0；null/非法 → '—'。 */
export function fmtScore(v) {
  if (v == null || !Number.isFinite(Number(v))) return '—';
  const n = Number(v);
  if (Number.isInteger(n)) return String(n);
  return String(Math.round(n * 10) / 10).replace(/\.0$/, '');
}

/**
 * 数子结果网格派生（黑目/白目/贴目/手数）。认输局（无 black/white 分）返回
 * ``items=[]``（面板隐藏网格，仅大字结果）。
 */
export function deriveScoreGrid(game, scores) {
  const bn = scores && scores.blackScore;
  const wn = scores && scores.whiteScore;
  const numOk = (v) => v != null && v !== '' && Number.isFinite(Number(v));
  const hasNumbers = Boolean(numOk(bn) && numOk(wn));
  const p = (game && game.params) || {};
  const komi = p.komi != null ? fmtScore(p.komi) : '—';
  const moveNo = game && game.lastMoveNo != null ? String(Number(game.lastMoveNo)) : '—';
  if (!hasNumbers) return { hasNumbers: false, items: [] };
  return {
    hasNumbers: true,
    items: [
      { label: '黑目', value: fmtScore(bn) },
      { label: '白目', value: fmtScore(wn) },
      { label: '贴目', value: komi },
      { label: '手数', value: moveNo },
    ],
  };
}

/** 结算子标题：认输局 / 未定型终局（结果为 AI 预判）/ 数子终局。 */
export function settleSubtitle(game, finished) {
  const result = (game && game.result) || '';
  if (/\+Resign$/i.test(String(result))) return '认输终局 · 本局已保存';
  // 未定型终局（导入棋谱末手非双 PASS，2026/10/10 人工口径）：结果取自 AI 预判、
  // 无精确目数（`game.finished` 载荷 `ai_predicted`）——副行须如实说明来源
  if (finished && finished.aiPredicted) return '终局局面未定型 · 结果为 AI 预判';
  if (game && game.status === 'finished') return '终局结算完成';
  return '';
}

/** 终局 BoardNote 文案（棋盘左上有色胶囊行）。 */
export function settleBoardNote(game) {
  if (!game) return '';
  if (game.status === 'scoring') return '终局 · 死子确认：点击棋子标记 ✕（再点取消）';
  if (game.status === 'finished') return `终局 · ${resultText(game.result || '', { verbose: false })}`;
  return '';
}

/** 对弈模式文本（对局信息卡：人机 · 标准/人类/自适应 / 人人）。 */
export function settleModeText(game) {
  const p = (game && game.params) || {};
  if (p.mode === 'human_ai') {
    const base = p.adaptiveEnabled ? '自适应' : p.aiStyle === 'human' ? '人类' : '标准';
    return `人机 · ${base}`;
  }
  if (p.mode === 'human_human') return '人人';
  return p.mode || '—';
}

/** 分析数据完整性文案。 */
export function analysisText(complete) {
  return { text: complete ? '完整' : '不完整', ok: Boolean(complete) };
}

/**
 * 结算信息卡「分析数据 / 分析覆盖」项派生（2026/09/18 人工口径）：
 * - 分析完整 → **保持现有提示不变**（成功图标 + 「完整」）；
 * - 不完整 → 显示「分析覆盖」+ `X/Y`（X＝已分析局面数、Y＝应有局面数 0..last 共 Y 局；
 *   计数缺失/非法 → `—`；X 越界钳制到 [0, Y]）。
 * @param {boolean} complete `reportReady()`（分析数据是否完整）
 * @param {{done?:number,total?:number}|null} [coverage] 覆盖计数（game.state 快照 / REST 刷新）
 * @returns {{ok:boolean, label:string, value:string, icon:string|null, color:string|null}}
 */
export function analysisItemView(complete, coverage = null) {
  const an = analysisText(complete);
  if (an.ok) {
    return { ok: true, label: '分析数据', value: an.text, icon: 'i-success', color: 'var(--eng-idle)' };
  }
  const done = Number(coverage && coverage.done != null ? coverage.done : NaN);
  const total = Number(coverage && coverage.total != null ? coverage.total : NaN);
  const value = Number.isFinite(done) && Number.isFinite(total) && total >= 0
    ? `${Math.min(Math.max(0, done), total)}/${total}`
    : '—';
  return { ok: false, label: '分析覆盖', value, icon: null, color: null };
}

/**
 * 死子确认提示文案（纯函数，2026/09/19 抽取）：对弈结算面板与复盘补结算共用同一口径。
 * 优先级：引擎不可用（DEAD/FATAL）> 等待预判 > 预判无数据 > 预判/手动标记计数。
 * @param {{engineState?:string, predState?:'none'|'waiting'|'seeded'|'no-data', deadCount?:number}} opts
 * @returns {string}
 */
export function deadConfirmHint(opts = {}) {
  const st = String(opts.engineState || '').toUpperCase();
  const predState = opts.predState || 'none';
  const deadCount = Math.max(0, Number(opts.deadCount) || 0);
  if (st === 'DEAD' || st === 'FATAL') return '引擎不可用：请手动点击棋子标记死子（✕）';
  if (predState === 'waiting') return 'AI 正在分析终局局面以预判死子…（可先手动标记）';
  if (predState === 'no-data') return '未能获取 AI 预判：请手动标记死子（✕）';
  if (predState === 'seeded' && deadCount > 0) {
    return `AI 预判 ${deadCount} 颗死子（✕ 标记）· 点击棋子切换死/活`;
  }
  if (deadCount > 0) return `已标记 ${deadCount} 颗死子（✕ 标记）· 点击棋子切换死/活`;
  return '未标记死子 · 点击棋子标记死子（✕），确认后按此结算';
}

/**
 * 预判结果结构化文案（纯函数，2026/09/19）：双 PASS 精确数子预期 / 认输目数估算。
 * 无引擎 / 无结果 → null（不展示）。渲染口径（人工反馈 2026/09/19）：整体主题色
 * 高亮（`.settle-pred`），正文（`白胜 1.5 目`）粗体；删除按当前标记结算的括注。
 * @param {{engine?:boolean, result?:string|null}|null} prediction scoring.prediction 状态切片
 * @returns {{body:string, note:string}|null}
 */
export function predictionResultParts(prediction) {
  const p = prediction;
  if (!p || !p.engine || !p.result) return null;
  return resultHeroParts(p.result);
}

/**
 * 「再来一局」创建载荷（同本局参数）：模式/棋盘/规则/贴目/让子/执色/难度/风格/
 * 自适应/点评 + 黑白 name/rank 快照转发（服务端唯一事实源；AI 侧除外，见下）。
 *
 * **AI 侧快照不外发**（BUG-136）：状态树 `players[AI 侧]` 是**展示派生**值
 * （`state.js::aiSideDisplay` → 名称 `AI` + 显示段位 `5K`，非录入快照）；原样
 * 回传会被创建接口的段位校验拒绝（`5K` 非 `rank_*` 机读码）→ 422
 * INVALID_PAYLOAD「请求参数不合法」。与创建向导同口径：AI 侧留空，服务端自落
 * 名称 `AI`、按 `ai.level` / 自适应推难度。
 */
export function rematchPayload(game) {
  const p = (game && game.params) || {};
  const pl = (game && game.players) || {};
  // 人类执色 = 本载荷 `color` 同值（缺省 B），AI 侧取补色（与服务端 `_ai_color` 同口径）
  const humanColor = p.humanColor === 'W' ? 'W' : 'B';
  const aiSide = humanColor === 'B' ? 'white' : 'black';
  const snapshot = (side) => {
    if (p.mode === 'human_ai' && side === aiSide) return { name: null, rank: null };
    const s = pl[side] || {};
    return { name: s.name != null && s.name !== '' ? s.name : null, rank: s.rank || null };
  };
  const payload = {
    mode: p.mode === 'human_ai' ? 'human_ai' : 'human_human',
    board_size: p.boardSize || 19,
    rules: p.rules || 'chinese',
    komi: (p.handicap || 0) > 0 ? 0 : p.komi != null ? p.komi : null,
    handicap: p.handicap || 0,
    black: snapshot('black'),
    white: snapshot('white'),
    coaching: Boolean(p.coachingEnabled),
  };
  if (p.mode === 'human_ai') {
    payload.color = humanColor;
    if (p.adaptiveEnabled) {
      payload.ai = { style: 'human', adaptive: true };
    } else {
      const level = Number(p.aiLevel);
      payload.ai = {
        style: p.aiStyle === 'human' ? 'human' : 'standard',
        adaptive: false,
        level: Number.isFinite(level) ? level : null,
      };
    }
  }
  return payload;
}

/** 是否认输终局（跳过死子确认阶段）。 */
export function isResigned(game) {
  return /\+Resign$/i.test(String((game && game.result) || ''));
}

/**
 * 结果大字拆分：正文 + 圆括号附注（如 `白胜 6.5 目` + `(W+6.5)`）。
 * 附注以 ``<small>`` 呈现（基线 .result-hero .big small 16px，UI_UX §5.4）。
 */
export function resultHeroParts(result) {
  const s = resultText(result, { verbose: true });
  const m = /^(.*?)\s*(\([^)]*\))\s*$/.exec(s);
  return m ? { body: m[1], note: m[2] } : { body: s, note: '' };
}

/* ============================================================
 * 结算面板模块
 * ============================================================ */

/**
 * @param {object} deps
 * @param {object} deps.store 状态树（store）
 * @param {object} deps.hub   WS 双通道（sendGame）
 * @param {object} deps.api   REST 客户端（详情/报告门控刷新）
 * @param {Function} deps.toast
 * @param {{desktop:HTMLElement, mobile:HTMLElement}} deps.hosts 挂载点：desktop=桌面侧栏内
 *   容器；mobile=移动（≤767）**底部抽屉根容器**（模块自建抽屉壳 `.settle-drawer` 挂入）
 * @param {boolean|Function} [deps.isDesktop] 桌面断点（缺省 matchMedia ≥768）
 * @param {Function} deps.boardRef  () => GameBoard|null（读棋盘 announce）
 * @param {Function} deps.onDead    (list)=>void 死子集合回写（game-view 设 board deadStones）
 * @param {Function} deps.onTerritoryToggle ()=>boolean 显示/隐藏领地（game-view 请求+热力）
 * @param {Function} deps.onRematch (payload)=>void 再来一局（game-view 创建并跳转）
 * @param {Function} deps.onOpenReport (gameId)=>void 打开对局报告弹层（T6.9；缺省回退跳转直达路由）
 * @param {Function} deps.onEnd     ()=>void 结束（离开本对局）
 * @param {Function} deps.nav       (hash)=>void
 * @param {Function} deps.confirm   ({title,message,okText,cancelText,danger,okIcon})=>Promise<boolean>
 *   （✕/ESC 取消结算的二次确认，缺省时直接发送 scoring.cancel）
 */
export function createScoringPanelModule(deps = {}) {
  const store = deps.store;
  const hub = deps.hub;
  const api = deps.api;
  const toast = deps.toast || (() => {});
  const hosts = deps.hosts || {};
  const nav = deps.nav || ((h) => { location.hash = h; });

  let destroyed = false;
  let wrapper = null; // 卡片容器（.scoring-panel；桌面侧栏 / 移动抽屉 body 间迁移）
  let drawerEl = null; // 移动/平板抽屉壳（头部含收起/关闭，模块自持）
  let drawerBodyEl = null;
  let drawerTitleEl = null;
  let unsub = null;
  let mqHandler = null;
  let escHandler = null;
  let errHandler = null;

  const self = {
    active: false,
    kind: null, // 'scoring' | 'finished'
    dead: [],
    touched: false, // 用户已开始手动校正（此后不再自动预判覆盖）
    predicted: false, // 已应用服务端预判死子
    predState: 'none', // none | waiting | seeded | no-data
    prediction: null, // 服务端预判载荷（scoring.prediction；含预判结果）
    confirming: false, // 确认/跳过提交中（防重复）
    finished: null, // { result, blackScore, whiteScore, deadCount }
    analysisComplete: null, // 报告门控（REST 刷新覆盖）
    analysisTried: 0,
    coverage: null, // 分析覆盖计数（REST 刷新提供结算后补写的最新值；否则读 game.state 快照）
    terrOn: false, // [显示领地] 按钮态
    collapsed: false, // ≤767 抽屉收起态（露出棋盘；下滑/点空白不关闭，仅 ✕/ESC 关闭）
  };

  // M-9：确认/取消等待守卫——回包丢失（断线/引擎无响应）时解除按钮锁并提示重试。
  // 正常路径由 store 推送（game.finished/game.state）或 tgo:error 复位（done()）。
  const confirmGuard = createConfirmGuard(
    () => {
      if (destroyed || !self.active || self.kind !== 'scoring' || !self.confirming) return;
      self.confirming = false;
      render();
      toast({ level: 'warn', text: '结算提交超时：未收到服务器确认，请重试', key: 'scoring-timeout' });
    },
    deps.confirmTimeoutMs ? { delayMs: deps.confirmTimeoutMs } : {}
  );

  /* ---------------- 工具 ---------------- */

  function isDesktop() {
    if (typeof deps.isDesktop === 'function') return Boolean(deps.isDesktop());
    if (deps.isDesktop !== undefined) return Boolean(deps.isDesktop);
    return typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia('(min-width: 768px)').matches
      : true;
  }

  function currentGame() {
    const s = store.getState();
    return s.game || null;
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function board() {
    return typeof deps.boardRef === 'function' ? deps.boardRef() : null;
  }

  /* ---------------- 死子预判（服务端 scoring.prediction，2026/09/11） ----------------
   *
   * 口径（人工确认）：结算时由**后端**提交终局深算（maxVisits=深度分析值）→
   * 预判死子（ownership 链级启发式，GTP final_status_list dead 等价）+ GTP
   * final_score 等价结果 → ``scoring.prediction`` 推送；前端仅展示与预标，
   * 白标可任意校正；引擎不可用/失败时服务端推 ``engine:false`` → 转人工标记。
   *
   * 终局态（认输 / 双 PASS 确认后）同样同步：认输后服务端的终局深算结果
   * （GTP 语义 final_score 等价目数）需在结算面板展示；同手数二次预判
   * （取消结算后再次进入）按**载荷变化**重绘。
   */

  /** 预判载荷等价性（同手数二次预判：死子/结果/目数任一不同 → 需重绘）。 */
  function samePrediction(a, b) {
    if (!a || !b) return a === b;
    const points = (p) => (Array.isArray(p) ? p : []).map((d) => `${d.x},${d.y}`).join('|');
    return a.gameId === b.gameId && a.moveNo === b.moveNo && a.engine === b.engine
      && a.finished === b.finished && a.result === b.result && a.lead === b.lead
      && a.blackScore === b.blackScore && a.whiteScore === b.whiteScore
      && points(a.deadPoints) === points(b.deadPoints);
  }

  function syncPrediction() {
    const g = currentGame();
    if (!g) return;
    const pred = store.getState().prediction;
    const fresh = pred && Number(pred.gameId) === Number(g.gameId)
      && Number(pred.moveNo) === Number(g.lastMoveNo);
    if (!fresh) {
      // 尚无预判：等待服务端终局深算（失败时服务端会推 engine:false）
      if (self.predState !== 'waiting') {
        self.predState = 'waiting';
        render();
      }
      return;
    }
    const changed = !samePrediction(self.prediction, pred);
    self.prediction = pred;
    if (!pred.engine) {
      if (self.predState !== 'no-data' || changed) {
        self.predState = 'no-data';
        render();
      }
      return;
    }
    // 仅 SCORING 阶段预标死子（终局态死子集已确认，不再被预判覆盖）
    if (self.kind === 'scoring' && !self.predicted && !self.touched) {
      // 用户未开始手动校正：按 AI 预判预标死子（可用点击棋子切换）
      self.predicted = true;
      self.dead = normalizePoints(pred.deadPoints);
      syncDead();
    }
    if (self.predState !== 'seeded' || changed) {
      self.predState = 'seeded';
      render();
    }
  }

  function predHintText() {
    const s = store.getState();
    return deadConfirmHint({
      engineState: (s.engine && s.engine.state) || '',
      predState: self.predState,
      deadCount: self.dead.length,
    });
  }

  /** 预判结果结构化文案（双 PASS：精确数子预期；认输：GTP 预期分支的目数估算）。 */
  function predictionParts() {
    return predictionResultParts(self.prediction);
  }

  /* ---------------- 死子集合 ---------------- */

  function syncDead() {
    const list = normalizePoints(self.dead);
    self.dead = list;
    if (typeof deps.onDead === 'function') deps.onDead(list);
  }

  /** 棋盘点击棋子：切换死/活（game-view 在 SCORING 时经此回调驱动）。 */
  function toggleDead(pt) {
    if (!self.active || self.kind !== 'scoring') return;
    if (self.confirming) return;
    self.touched = true;
    const wasDead = self.dead.some((d) => d.x === Number(pt.x) && d.y === Number(pt.y));
    self.dead = toggleDeadPoint(self.dead, pt.x, pt.y);
    syncDead();
    const g = currentGame();
    const b = board();
    if (b && typeof b.announce === 'function') {
      const size = (g && g.params && g.params.boardSize) || 19;
      const gtp = gtpOf(Number(pt.x), Number(pt.y), size);
      b.announce(wasDead ? `取消死子标记 ${gtp}` : `标记死子 ${gtp}`);
    }
    render();
  }

  function clearDead() {
    self.touched = true;
    self.dead = [];
    syncDead();
    render();
  }

  /* ---------------- 提交 / 结算取消 ---------------- */

  async function submitScoring(skip) {
    if (self.confirming || !hub || typeof hub.sendGame !== 'function') return;
    const g = currentGame();
    if (!g || g.status !== 'scoring') return;
    self.confirming = true;
    self.touched = true;
    render();
    hub.sendGame('scoring.confirm', { dead_points: skip ? [] : deadToTuples(self.dead) });
    // game.finished/game.state 到达后自动复位 confirming（store 订阅 render）；
    // M-9：回包丢失时由守卫超时解除（旧实现无兜底 → 按钮永久禁用）
    confirmGuard.arm();
  }

  function cancelScoring() {
    if (self.confirming || !hub || typeof hub.sendGame !== 'function') return;
    const g = currentGame();
    if (!g || g.status !== 'scoring') return;
    self.confirming = true;
    hub.sendGame('scoring.cancel');
    confirmGuard.arm(); // M-9：取消同样等待 game.state 回投；超时解除
  }

  /* ---------------- 报告门控刷新（analysis_complete） ---------------- */

  /** 分析覆盖计数：REST 刷新（结算后终局分析仍在补写 → 比快照新）优先，否则取 game.state 快照。 */
  function coverageOf() {
    if (self.coverage) return self.coverage;
    const g = currentGame();
    if (g && g.coverage && g.coverage.total != null) {
      return { done: Number(g.coverage.done) || 0, total: Number(g.coverage.total) };
    }
    return null;
  }

  async function refreshAnalysis() {
    const g = currentGame();
    if (!g || !api || destroyed) return;
    self.analysisTried += 1;
    try {
      const res = await api.get(`/games/${g.gameId}`);
      const d = res && res.data;
      if (d) {
        if (typeof d.analysis_complete === 'boolean') self.analysisComplete = d.analysis_complete;
        // 覆盖计数（同 analysis_complete 口径：REST 为结算后补写的最新值）
        if (d.analyses_count != null && d.moves_count != null) {
          const total = Math.max(0, Number(d.moves_count)) + 1; // 0..last 共 moves_count+1 局
          self.coverage = { done: Math.min(Math.max(0, Number(d.analyses_count)), total), total };
        }
        render();
      }
      // 结算刚完成时终局分析可能仍在补写：短延迟后再查一次
      if (self.analysisComplete !== true && self.analysisTried < 2) {
        setTimeout(() => {
          if (!destroyed && self.active && self.kind === 'finished') refreshAnalysis();
        }, 5000);
      }
    } catch {
      /* 详情拉取失败不阻断结算面板 */
    }
  }

  function reportReady() {
    const g = currentGame();
    // REST 刷新（结算后终局分析可能仍在补写）优先于 game.state 快照（可能滞后）
    if (self.analysisComplete !== null) return Boolean(self.analysisComplete);
    if (g && g.analysisComplete !== undefined) return Boolean(g.analysisComplete);
    return false;
  }

  function reportDisabledReason() {
    return reportReady() ? '' : '分析数据不完整：可在复盘页先完成全局分析';
  }

  /* ---------------- 动作 ---------------- */

  function onTerritoryToggle() {
    if (typeof deps.onTerritoryToggle !== 'function') return;
    const next = deps.onTerritoryToggle();
    if (next === true || next === false) self.terrOn = next;
    render();
  }

  function onRematch() {
    if (typeof deps.onRematch !== 'function') return;
    deps.onRematch(rematchPayload(currentGame()));
  }

  function onReview() {
    const g = currentGame();
    if (g) nav(`#/review/${g.gameId}`);
  }

  function onReport() {
    if (!reportReady()) {
      toast({ level: 'info', text: reportDisabledReason(), key: 'report-incomplete' });
      return;
    }
    const g = currentGame();
    if (!g) return;
    // T6.9：报告＝全站弹层（默认人类视角由弹层内按 game 推导）；无回调回退旧直达
    if (typeof deps.onOpenReport === 'function') {
      deps.onOpenReport(g.gameId);
      return;
    }
    const p = (g.params || {}).humanColor === 'W' ? 'W' : 'B';
    nav(`#/report/${g.gameId}?p=${p}`);
  }

  function onEnd() {
    if (typeof deps.onEnd === 'function') deps.onEnd();
  }

  /* ---------------- 渲染 ---------------- */

  function deadPhaseHTML() {
    const g = currentGame();
    const hint = predHintText();
    const empty = self.dead.length === 0;
    const pred = predictionParts();
    return `
      <div class="scoring-steps">
        <div>
          <div class="muted step-line"><b style="color:var(--text-1)">① 死子确认</b>
            <span class="dead-count num">${esc(self.dead.length > 0 ? `已标 ${self.dead.length} 颗` : '')}</span>
          </div>
          <p class="settle-hint">${esc(hint)}</p>
          ${pred ? `<p class="settle-hint muted">AI 预判结果：<span class="settle-pred"><b>${esc(pred.body)}</b>${pred.note ? ` ${esc(pred.note)}` : ''}</span></p>` : ''}
          <div class="dead-tools">
            <button class="btn btn-primary" type="button" data-act="confirm"
                    ${self.confirming ? 'disabled' : ''}>全部确认</button>
            <button class="btn btn-secondary" type="button" data-act="clear"
                    ${empty || self.confirming ? 'disabled' : ''}>全部清除</button>
            <button class="btn btn-ghost" type="button" data-act="skip"
                    ${self.confirming ? 'disabled' : ''}>跳过</button>
          </div>
          <div class="muted" style="font-size:12px;margin-top:8px">
            <svg class="icon" style="width:13px;height:13px;vertical-align:-2px" aria-hidden="true"><use href="#i-info"/></svg>
            ${isHumanAi(g) ? '人机对弈：死子确认由你完成' : '结算取消可重新标记；任一终端确认即生效'}
          </div>
        </div>
      </div>
      <div class="divider"></div>
      <div class="dead-tools">
        <button class="btn btn-ghost btn-sm" type="button" data-act="cancel"
                ${self.confirming ? 'disabled' : ''}>继续对弈</button>
        <span class="settle-cancel-hint">结算取消：SCORING→PLAYING，可重新确认死子</span>
      </div>`;
  }

  function resultPhaseHTML() {
    const g = currentGame();
    const f = self.finished || {
      result: (g && g.result) || null,
      blackScore: null,
      whiteScore: null,
    };
    const grid = deriveScoreGrid(g, f);
    const resigned = isResigned(g);
    const hero = resultHeroParts(f.result || (g && g.result));
    const engineDown = String((store.getState().engine && store.getState().engine.state) || '')
      .toUpperCase() === 'DEAD'
      || String((store.getState().engine && store.getState().engine.state) || '')
        .toUpperCase() === 'FATAL';
    const terrClass = self.terrOn ? 'btn btn-secondary btn-sm on' : 'btn btn-secondary btn-sm';
    const pred = predictionParts();
    const follow = `
      <div class="follow-actions" style="justify-content:flex-start">
        <button class="btn btn-primary" type="button" data-act="rematch">再来一局</button>
        <button class="btn btn-secondary" type="button" data-act="review">复盘</button>
        <button class="btn btn-secondary" type="button" data-act="report"
                ${reportReady() ? '' : 'disabled'} title="${esc(reportDisabledReason())}">对局报告</button>
        <button class="btn btn-ghost" type="button" data-act="end">结束</button>
      </div>`;
    return `
      <div class="result-hero">
        <div class="big num">${esc(hero.body || '—')}${hero.note ? ` <small>${esc(hero.note)}</small>` : ''}</div>
        <div class="sub">${esc(resigned ? '认输终局 · 本局已保存' : settleSubtitle(g))}</div>
      </div>
      ${grid.hasNumbers ? `
      <div class="result-grid">
        ${grid.items.map((it) => `
          <div class="item"><div class="label">${esc(it.label)}</div>
            <div class="value num">${esc(it.value)}</div></div>`).join('')}
      </div>` : `${pred ? `<p class="settle-hint muted">AI 预判目数：<span class="settle-pred"><b>${esc(pred.body)}</b>${pred.note ? ` ${esc(pred.note)}` : ''}</span></p>` : ''}`}
      <div class="dead-tools" style="justify-content:center">
        <button class="${terrClass}" type="button" data-act="territory"
                title="领地热力图切换：黑/白热力覆盖（含死子 ✕ 叠加）">
          <svg class="icon" style="width:15px;height:15px" aria-hidden="true"><use href="#i-territory"/></svg>显示领地
        </button>
      </div>
      <p class="settle-foot muted">
        ${engineDown ? '引擎不可用：数子由后端 Python 结算（领地热力可能缺数据）' : '结算与领地：由引擎分析取终局结果'}
      </p>
      <div class="divider"></div>
      <div class="settle-step3"><b style="color:var(--text-1)">② 后续操作</b></div>
      ${follow}
      ${resigned ? '' : '<div class="divider"></div><div class="dead-tools" style="justify-content:flex-start"><span class="settle-cancel-hint muted">死子已确认并计入结算</span></div>'}
    `;
  }

  function infoCardHTML2() {
    const g = currentGame();
    const pl = (g && g.players) || {};
    const players = {
      black: {
        name: (pl.black && pl.black.name) || '真人',
        rank: rankText(pl.black && pl.black.rank),
        tag: (pl.black && pl.black.tag) || '',
      },
      white: {
        name: (pl.white && pl.white.name) || '真人',
        rank: rankText(pl.white && pl.white.rank),
        tag: (pl.white && pl.white.tag) || '',
      },
    };
    const anItem = analysisItemView(reportReady(), coverageOf());
    return `
      <div class="card" data-ref="settleInfo">
        <h3><svg class="icon" aria-hidden="true"><use href="#i-info"/></svg>对局信息</h3>
        ${playersLineHTML(players)}
        <div class="kv">
          <div class="item">
            <div class="label">模式</div>
            <div class="value" style="font-size:14px">${esc(settleModeText(g))}</div>
          </div>
          <div class="item">
            <div class="label">${anItem.label}</div>
            ${anItem.icon
              ? `<div class="value" style="font-size:14px;display:flex;align-items:center;justify-content:center;gap:4px">
                  <svg class="icon" style="width:16px;height:16px;color:${anItem.color}" aria-hidden="true"><use href="#${anItem.icon}"/></svg>
                  ${anItem.value}
                </div>`
              : `<div class="value num" style="font-size:14px">${anItem.value}</div>`}
          </div>
        </div>
      </div>`;
  }

  function panelHTML() {
    const g = currentGame();
    const phase = self.kind === 'finished' ? 'result' : 'dead-confirm';
    const title = phase === 'result' ? '终局结算' : '终局结算';
    return `
      <div class="scoring-panel">
        <div class="card" data-ref="settleMain">
          <h3><svg class="icon" aria-hidden="true"><use href="#i-comment"/></svg>${title}</h3>
          ${phase === 'result' ? resultPhaseHTML() : deadPhaseHTML()}
        </div>
        ${infoCardHTML2()}
      </div>`;
  }

  /* ---------------- ≤767 底部结算抽屉壳（grip 收起/展开 + ✕/ESC） ----------------
   * 2026/09/06 第二轮人工确认：
   *   - 卡宽与桌面一致、**固定 384px 不随屏缩放**（窄屏抽屉 body 横向滚动查看）；
   *   - 顶部小横条（grip）= 收起/展开把手：轻点切换；按住下滑收起、上滑展开；不关闭；
   *     下滑小横条 / 点空白不关闭抽屉（收起即可），**不设独立 [收起/展开] 按钮**；
   *   - [✕]/ESC：SCORING → 取消结算（scoring.cancel，二次确认）；
   *     FINISHED → [结束]（deps.onEnd，等同面板 [结束]）。
   */

  function drawerTitle() {
    const g = currentGame();
    if (!g) return '终局结算';
    if (self.kind === 'finished' || g.status === 'finished') return '终局结算 · 对局已结束';
    if (self.dead.length > 0) return `终局结算 · 死子已标 ${self.dead.length} 颗`;
    return '终局结算 · 死子确认';
  }

  /** [✕]/ESC 按钮文案按阶段：SCORING=取消结算；FINISHED=结束。 */
  function drawerCloseAria() {
    const g = currentGame();
    if (g && (self.kind === 'finished' || g.status === 'finished')) {
      return { label: '结束并离开（对局已结束）', title: '结束（对局已结束）' };
    }
    return { label: '取消结算（返回对弈）', title: '取消结算（返回对弈）' };
  }

  /** grip 小横条交互：轻点=收起/展开切换；按住下滑=收起、上滑=展开；绝不关闭。 */
  function bindGrip(grip) {
    let drag = null;
    let suppressClickUntil = 0;
    const onMove = (e) => {
      if (!drag) return;
      const dy = e.clientY - drag.y;
      if (Math.abs(dy) > 6) drag.moved = true;
      let ty = 0;
      if (self.collapsed) ty = Math.min(0, dy); // 收起态可上拉展开
      else ty = Math.max(0, dy); // 展开态可下拉收起
      if (drawerEl) drawerEl.style.transform = ty ? `translateY(${ty}px)` : '';
    };
    const end = (e) => {
      if (!drag) return;
      const dy = e.clientY - drag.y;
      const moved = drag.moved;
      drag = null;
      if (drawerEl) {
        drawerEl.classList.remove('dragging');
        drawerEl.style.transform = '';
      }
      try {
        grip.releasePointerCapture(e.pointerId);
      } catch {
        /* 无捕获环境 */
      }
      if (!moved) return; // 轻点交由 click 切换
      suppressClickUntil = Date.now() + 350;
      if (dy > 40 && !self.collapsed) setCollapsed(true);
      else if (dy < -40 && self.collapsed) setCollapsed(false);
    };
    grip.addEventListener('pointerdown', (e) => {
      drag = { y: e.clientY, moved: false };
      if (drawerEl) drawerEl.classList.add('dragging');
      try {
        grip.setPointerCapture(e.pointerId);
      } catch {
        /* 忽略 */
      }
    });
    grip.addEventListener('pointermove', onMove);
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
    grip.addEventListener('click', () => {
      if (Date.now() < suppressClickUntil) return; // 拖动后的合成 click 忽略
      setCollapsed(!self.collapsed);
    });
  }

  function ensureDrawer() {
    if (drawerEl || !hosts.mobile) return;
    drawerEl = document.createElement('div');
    drawerEl.className = 'settle-drawer';
    drawerEl.setAttribute('role', 'dialog');
    drawerEl.setAttribute('aria-modal', 'false');
    drawerEl.setAttribute('aria-label', '终局结算');
    drawerEl.innerHTML = `
      <button class="drawer-grip" type="button"
              aria-expanded="true" aria-label="收起结算面板（露出棋盘）"
              title="轻点收起/展开；按住下滑收起、上滑展开（不关闭）"></button>
      <div class="settle-drawer-head">
        <span class="settle-drawer-title num" data-ref2="title"></span>
        <button class="icon-btn" type="button" data-act2="close"
                aria-label="取消结算（返回对弈）" title="取消结算（返回对弈）">
          <svg class="icon" aria-hidden="true"><use href="#i-close"/></svg>
        </button>
      </div>
      <div class="settle-drawer-body" data-ref2="body"></div>`;
    drawerTitleEl = drawerEl.querySelector('[data-ref2="title"]');
    drawerBodyEl = drawerEl.querySelector('[data-ref2="body"]');
    if (hosts.mobile) hosts.mobile.appendChild(drawerEl);
    const grip = drawerEl.querySelector('.drawer-grip');
    bindGrip(grip);
    drawerEl.addEventListener('click', (e) => {
      const btn = e.target && e.target.closest ? e.target.closest('[data-act2]') : null;
      if (btn && btn.dataset.act2 === 'close') handleDrawerDismiss();
    });
  }

  function setCollapsed(collapsed) {
    self.collapsed = Boolean(collapsed);
    if (drawerEl) drawerEl.classList.toggle('collapsed', self.collapsed);
    syncDrawerState();
  }

  /** 抽屉头部（标题 / grip 收起态 / [✕] 阶段文案）随阶段与标记数同步。 */
  function syncDrawerState() {
    if (!drawerEl) return;
    if (drawerTitleEl) drawerTitleEl.textContent = drawerTitle();
    const ca = drawerCloseAria();
    const closeBtn = drawerEl.querySelector('[data-act2="close"]');
    if (closeBtn) {
      closeBtn.setAttribute('aria-label', ca.label);
      closeBtn.title = ca.title;
    }
    const grip = drawerEl.querySelector('.drawer-grip');
    if (grip) {
      grip.setAttribute('aria-expanded', String(!self.collapsed));
      grip.setAttribute('aria-label', self.collapsed ? '展开结算面板' : '收起结算面板（露出棋盘）');
      grip.title = self.collapsed ? '轻点展开' : '轻点收起；按住下滑收起、上滑展开（不关闭）';
    }
  }

  /** 抽屉 [✕]/ESC：SCORING → 取消结算（二次确认）；FINISHED → [结束]（deps.onEnd）。 */
  async function handleDrawerDismiss() {
    const g = currentGame();
    if (!g) return;
    // 终局已完成：[结束] 不受 confirming 影响（跳过/确认后 confirming 仍为 true）
    if (self.kind === 'finished' || g.status === 'finished') {
      if (typeof deps.onEnd === 'function') deps.onEnd();
      return;
    }
    if (self.confirming) return;
    if (g.status !== 'scoring') return;
    const confirmFn = deps.confirm;
    if (typeof confirmFn !== 'function') {
      cancelScoring();
      return;
    }
    const ok = await confirmFn({
      title: '取消本次结算？',
      message: '将返回对弈（SCORING→PLAYING），已标记的死子会被清除；需再次双 PASS 才可进入结算。',
      okText: '取消结算',
      cancelText: '返回结算',
      danger: true,
      okIcon: 'i-error',
    });
    if (!ok || destroyed) return;
    if (self.active && self.kind === 'scoring' && !self.confirming) cancelScoring();
  }

  function render() {
    if (destroyed || !self.active || !wrapper) return;
    const g = currentGame();
    if (!g || (g.status !== 'scoring' && g.status !== 'finished')) {
      wrapper.innerHTML = '';
      return;
    }
    if (self.kind === 'finished' && g.status !== 'finished') self.kind = 'scoring';
    if (self.kind === 'scoring' && g.status === 'finished') {
      self.kind = 'finished';
      self.confirming = false;
      confirmGuard.done();
      if (!self.finished) {
        self.finished = {
          result: g.result,
          blackScore: null,
          whiteScore: null,
          deadCount: self.dead.length,
        };
      }
      self.analysisComplete = g.analysisComplete !== undefined ? Boolean(g.analysisComplete) : null;
      refreshAnalysis();
    }
    if (self.kind === 'scoring' || self.kind === 'finished') syncPrediction();
    wrapper.innerHTML = panelHTML();
    syncDrawerState();
  }

  /** 把面板挂到对应宿主（≥768=侧栏 / ≤767=底部抽屉），并切换宿主可见性。 */
  function place() {
    if (destroyed || !wrapper) return;
    const desktop = isDesktop();
    if (hosts.desktop) hosts.desktop.classList.toggle('u-hide', !desktop || !self.active);
    if (hosts.mobile) hosts.mobile.classList.toggle('u-hide', desktop || !self.active);
    if (desktop) {
      // 抽屉壳仅在移动宿主内构建；回桌面时移除（wrapper 回桌面侧栏）
      if (drawerEl && hosts.mobile && drawerEl.parentNode === hosts.mobile) {
        hosts.mobile.removeChild(drawerEl);
      }
      if (hosts.desktop && wrapper.parentNode !== hosts.desktop) hosts.desktop.appendChild(wrapper);
      return;
    }
    ensureDrawer();
    if (drawerEl && hosts.mobile && drawerEl.parentNode !== hosts.mobile) {
      hosts.mobile.appendChild(drawerEl);
    }
    if (drawerBodyEl && wrapper.parentNode !== drawerBodyEl) drawerBodyEl.appendChild(wrapper);
    if (drawerEl) drawerEl.classList.toggle('collapsed', self.collapsed);
    syncDrawerState();
  }

  function onStoreChange(state, message) {
    if (destroyed || !self.active) return;
    const type = message && message.type;
    const g = state.game;
    if (!g) return;
    // 结算结果：game.finished 载荷（score 随后 game.state 不携带 → 本地捕获）
    if (type === 'game.finished' && (g.status === 'finished' || self.kind === 'scoring')) {
      const data = (message && message.data) || {};
      self.finished = {
        result: data.result != null ? data.result : g.result,
        blackScore: data.black_score !== undefined ? data.black_score : null,
        whiteScore: data.white_score !== undefined ? data.white_score : null,
        deadCount: self.dead.length,
      };
    }
    if (type === 'game.state' && g.status === 'active') {
      // 结算取消 → 回对弈：复位面板内瞬态
      self.confirming = false;
      confirmGuard.done();
    }
    if (type === 'game.state' || type === 'game.finished' || type === 'position.ownership'
      || type === 'scoring.prediction') {
      if (g.status === 'scoring' || g.status === 'finished') {
        if (g.status === 'finished' && g.result && !self.finished) {
          self.finished = { result: g.result, blackScore: null, whiteScore: null, deadCount: null };
        }
        render();
      }
    }
  }

  /* ---------------- 生命周期 ---------------- */

  function ensureBuilt() {
    if (wrapper || destroyed) return;
    wrapper = document.createElement('div');
    wrapper.className = 'scoring-panel-root';
    if (!unsub) {
      unsub = store.subscribe((state, message) => onStoreChange(state, message || {}));
    }
    // 断点监听（迁移：≥768 侧栏 / ≤767 底部抽屉）
    if (typeof window !== 'undefined' && window.matchMedia && !mqHandler) {
      const mql = window.matchMedia('(min-width: 768px)');
      if (typeof mql.addEventListener === 'function') {
        mqHandler = () => {
          if (!destroyed) place();
        };
        mql.addEventListener('change', mqHandler);
      }
    }
    wrapper.addEventListener('click', (e) => {
      const btn = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
      if (!btn) return;
      const act = btn.dataset.act;
      if (act === 'confirm') submitScoring(false);
      else if (act === 'skip') submitScoring(true);
      else if (act === 'clear') clearDead();
      else if (act === 'cancel') cancelScoring();
      else if (act === 'territory') onTerritoryToggle();
      else if (act === 'rematch') onRematch();
      else if (act === 'review') onReview();
      else if (act === 'report') onReport();
      else if (act === 'end') onEnd();
    });
    // ESC（≤767 抽屉）：同 [✕] —— SCORING=取消结算（二次确认）、FINISHED=[结束]；
    // **可见**弹层打开时让位给弹层自身（报告弹层单例常驻 DOM，存在性判定会永久拦截
    // ESC，2026/09/19 修复：改用 hasOpenDialogMask）
    if (typeof document !== 'undefined' && !escHandler) {
      escHandler = (e) => {
        if (destroyed || e.key !== 'Escape') return;
        if (!self.active || isDesktop()) return;
        if (hasOpenDialogMask()) return;
        e.preventDefault();
        handleDrawerDismiss();
      };
      document.addEventListener('keydown', escHandler, true);
    }
    // 对弈通道错误（确认/取消/领地请求被拒等）→ 解除确认中锁，允许重试
    if (typeof window !== 'undefined' && !errHandler) {
      errHandler = (e) => {
        if (destroyed) return;
        const ev = e && e.detail;
        if (!ev || (ev.channel && ev.channel !== 'game')) return;
        if (self.confirming && self.active && self.kind === 'scoring') {
          self.confirming = false;
          confirmGuard.done();
          render();
        }
      };
      window.addEventListener('tgo:error', errHandler);
    }
  }

  return {
    /** 激活结算面板（kind: 'scoring'|'finished'）。 */
    activate(kind) {
      if (destroyed) return;
      ensureBuilt();
      self.active = true;
      self.kind = kind === 'finished' ? 'finished' : 'scoring';
      self.confirming = false;
      confirmGuard.done(); // M-9：新结算会话：清旧计时
      self.terrOn = false;
      self.collapsed = false;
      self.analysisComplete = null; // 每个结算会话重新判定（防跨对局残留）
      self.coverage = null;
      // 每次进入结算重新预判（取消后再结算可重确认；死子手动标记集上次已清）
      self.touched = false;
      self.predicted = false;
      self.predRequested = false;
      self.predState = 'none';
      if (self.predTimer) {
        clearTimeout(self.predTimer);
        self.predTimer = null;
      }
      const g = currentGame();
      if (g && g.status === 'finished') {
        self.kind = 'finished';
        self.finished = {
          result: g.result,
          blackScore: null,
          whiteScore: null,
          deadCount: self.dead.length,
        };
        self.analysisComplete = g.analysisComplete !== undefined ? Boolean(g.analysisComplete) : null;
        refreshAnalysis();
      }
      render();
      place();
    },
    /** 停用（回对弈 / 视图切换）。 */
    deactivate() {
      if (destroyed) return;
      self.active = false;
      self.kind = null;
      self.confirming = false;
      confirmGuard.done(); // M-9：离开结算会话：清等待计时
      self.touched = false;
      self.predicted = false;
      self.predRequested = false;
      self.predState = 'none';
      // 离开结算会话：清死子标记（结算取消后重确认 / 新对局接管）
      self.dead = [];
      syncDead();
      if (self.predTimer) {
        clearTimeout(self.predTimer);
        self.predTimer = null;
      }
      if (self.analysisTimer) {
        clearTimeout(self.analysisTimer);
        self.analysisTimer = null;
      }
      if (wrapper && wrapper.parentNode) wrapper.parentNode.removeChild(wrapper);
      if (hosts.desktop) hosts.desktop.classList.add('u-hide');
      if (hosts.mobile) hosts.mobile.classList.add('u-hide');
      if (drawerEl && drawerEl.parentNode) drawerEl.parentNode.removeChild(drawerEl);
      drawerEl = null;
      drawerBodyEl = null;
      drawerTitleEl = null;
    },
    place,
    isActive: () => self.active,
    /** 游戏状态在 SCORING 时棋盘点击死子切换入口。 */
    toggleDead,
    /** 进入结算时的初始死子集合（回读用；一般空/预判后由内部 seed）。 */
    deadList: () => normalizePoints(self.dead),
    destroy() {
      destroyed = true;
      confirmGuard.done(); // M-9：销毁：清等待计时
      if (self.predTimer) {
        clearTimeout(self.predTimer);
        self.predTimer = null;
      }
      if (self.analysisTimer) {
        clearTimeout(self.analysisTimer);
        self.analysisTimer = null;
      }
      if (unsub) {
        unsub();
        unsub = null;
      }
      if (mqHandler && typeof window !== 'undefined' && window.matchMedia) {
        const mql = window.matchMedia('(min-width: 768px)');
        if (typeof mql.removeEventListener === 'function') mql.removeEventListener('change', mqHandler);
        mqHandler = null;
      }
      if (errHandler && typeof window !== 'undefined') {
        window.removeEventListener('tgo:error', errHandler);
        errHandler = null;
      }
      if (escHandler && typeof document !== 'undefined') {
        document.removeEventListener('keydown', escHandler, true);
        escHandler = null;
      }
      if (drawerEl && drawerEl.parentNode) drawerEl.parentNode.removeChild(drawerEl);
      drawerEl = null;
      drawerBodyEl = null;
      drawerTitleEl = null;
      if (wrapper && wrapper.parentNode) wrapper.parentNode.removeChild(wrapper);
      wrapper = null;
    },
  };
}

export default createScoringPanelModule;
