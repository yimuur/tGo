/**
 * tGo · 棋谱列表与对局管理（T6.7，GameList，C10 / UI_UX §5.5.1 / §6.4 / §10）
 *
 * 复盘入口（路由 ``#/review``，顶栏 [+创建对局] 原地演化 [导入棋谱]——见 app.js/
 * core/sgf-import.js）。视图内容：
 *   - 筛选条：状态 tab（全部/进行中/已结束）+ 收藏 chip（AND，W-13）+ 搜索框
 *     （姓名＝服务端模糊 LIKE；`#123`＝对局编号**定位**（2026/09/21 人工决策：不筛
 *     只跳——服务端 focus_id 算页，前端翻页并选中）；T6.7 后端协议：
 *     GET /api/games?name=&status=可重复 OR&focus_id=）；
 *   - 列表（固定 10 条/页分页——人类修订 R3：不再随视口“一页同屏”收缩；页面随列表
 *     自然滚动，顶栏 sticky 吸顶）：模式徽章、标题「黑名 rank-sup vs 白名 rank-sup
 *     （#i-vs）」、「N路 · 规则」、结果或「进行中 · 第 N 手」、相对时间、收藏心；
 *     主操作 收藏/[回放|续弈] 常显（2026/09/14 人工反馈：[续弈] 非 primary，[回放] 保持
 *     primary）；次操作 [导出棋谱]/[删除] 桌面 hover 显现、
 *     移动端收进 ··· 菜单（``.btn-ghost:not(.menu-more)`` 排除规则，UI_UX §5.5.1）；
 *     删除仅非进行中（进行中灰置 + Tooltip W-16 + 二次确认）；导出 SGF 下载；
 *   - 缩略预览：桌面/平板＝右侧吸顶预览卡（sticky top:76，列表滚动时固定可见）；
 *     移动 ≤767＝底部弹出预览抽屉（无遮罩贴底、仅 grip 小横条 收起/展开——轻点切换、
 *     按住下滑收起、上滑展开，绝不关闭；抽屉外输入透传，列表仍可滚可点；
 *     **进入页面默认收起**（2026/09/14 人工反馈：不自动弹出，用户点 grip 才展开））。
 *     卡内（2026/09/13 人工反馈重排）：玩家行（黑 vs 白）在预览图**上方** → 迷你
 *     棋盘（真实局面，经 replayStones 吃子回放）→ 图下**一行**＝左侧对局信息
 *     （`#编号徽章 · N 手 · 贴 X · 分先/让 N 子 · 结果（仅结束）`，不换行、超出
 *     `…` 省略；**2026/09/21 人工决策：徽章由 人人/人机 改为对局编号**——
 *     模式由玩家行的 AI 侧派（`AI 5K · 标准`）表达）+ 右侧操作按钮
 *     （[回放|续弈] + [报告]）；原「选中对局预览」标题与 SVG 图标已删除；
 *     空态（还没有对局 / 无符合筛选的对局）。
 *
 * 结构：纯函数层（无 DOM、可无头测试 FE-RLIST-*）与 ``createView`` 控制器同文件；
 * 顶层无 DOM 副作用；输入输出对齐 API §3.1 GameInfo 白名单 Schema。
 */
import { rankText, relTimeText, resultText, round } from '../core/fmt.js';
import { aiSideDisplay, RULE_LABELS, replayStones } from '../core/game-model.js';
import { LS_KEYS } from '../core/localstore.js';
import { resolvePreviewStoneColors } from '../core/stone-style.js';
import { buildHash } from '../core/route.js';

/* ============================================================
 * 常量（UI_UX §5.5.1 / 静态稿基线）
 * ============================================================ */

/** 每页条数（人类修订 R3：固定 10 条/页，桌面/移动一致；页面自然滚动、不按视口收缩）。 */
export const PAGE_SIZE = 10;

/** 状态 tab（进行中 = 未结束：created/active/scoring；已结束 = finished）。 */
export const STATUS_TABS = Object.freeze([
  { key: 'all', label: '全部' },
  { key: 'active', label: '进行中' },
  { key: 'finished', label: '已结束' },
]);

/** 「进行中」tab 的服务端状态集（与 GameFlow FSM 一一对应，API §3.1）。 */
export const ACTIVE_STATUSES = Object.freeze(['created', 'active', 'scoring']);

/** 删除二次确认文案（§5.5.1）。 */
export const DELETE_CONFIRM = Object.freeze({
  title: '删除对局',
  message: '将删除该对局及全部关联分析数据（不可恢复）。',
  okText: '删除',
  danger: true,
});

/** 进行中删除入口 Tooltip（W-16）。 */
export const DELETE_DISABLED_TIP = '对局进行中，不可删除';

/* ============================================================
 * 纯函数层（无 DOM）
 * ============================================================ */

function clampPage(p, total) {
  const n = Number(p);
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(Math.ceil(total), Math.trunc(n)));
}

/** tab → 服务端 status 参数（all=不过滤；active=多状态 OR 数组）。 */
export function statusToParam(tab) {
  if (tab === 'active') return ACTIVE_STATUSES.slice();
  if (tab === 'finished') return 'finished';
  return null;
}

/**
 * 搜索框意图解析（2026/09/21 人工决策：编号搜索＝**定位跳页**，不是筛选）：
 *   - `#123`（`#` 与数字间允许空白）→ `{kind:'id', id}`：服务端 focus_id 算出所在页
 *     → 前端翻页并选中（列表不做 name 过滤；编号不存在/被当前筛选排除 → 一次性提示）；
 *   - 其余非空文本 → `{kind:'name', name}`：服务端黑/白名 LIKE 模糊搜索（既有口径）；
 *   - 空白 / `#` 单独输入（正在输入中）/ 非法编号（`#0`、超安全整数）→ `{kind:'none'}`。
 * @param {string} [q]
 * @returns {{kind:'id', id:number}|{kind:'name', name:string}|{kind:'none'}}
 */
export function searchIntent(q) {
  const raw = String(q == null ? '' : q).trim();
  if (!raw) return { kind: 'none' };
  const m = /^#\s*(\d+)$/.exec(raw);
  if (m) {
    const id = Number(m[1]);
    // focus_id 服务端约束 ge=1（0/越界直接放行会 422）→ 非法编号按无搜索处理
    return Number.isSafeInteger(id) && id >= 1 ? { kind: 'id', id } : { kind: 'none' };
  }
  if (raw === '#') return { kind: 'none' }; // 刚输入 `#`（编号尚未写完）
  return { kind: 'name', name: raw };
}

/**
 * 列表请求 query（rest-client 数组 → 重复参数键：?status=a&status=b）。
 * 编号搜索不产生 `name`（定位由调用方附 `focus_id`；否则 LIKE %#123% 恒 0 行）。
 * @param {object} [s]
 * @param {string} [s.tab='all']  'all'|'active'|'finished'
 * @param {boolean} [s.favOnly=false]
 * @param {string} [s.q='']
 * @param {number} [s.page=1]
 * @param {number} [s.pageSize=10]
 */
export function listQuery(s = {}) {
  const pageSize = Number(s.pageSize) > 0 ? Number(s.pageSize) : PAGE_SIZE;
  const query = { page_size: pageSize, page: Math.max(1, Math.trunc(Number(s.page) || 1)) };
  const st = statusToParam(s.tab);
  if (st) query.status = st;
  if (s.favOnly) query.favorite = true;
  const intent = searchIntent(s.q);
  if (intent.kind === 'name') query.name = intent.name;
  return query;
}

/**
 * 列表筛选状态 ↔ 路由 query（URL 状态同步，2026/09/19 人工决策）：
 * `#/review?tab=<all|active|finished>&fav=1&q=<关键词>&page=<n>`（默认值省略，可分享/刷新/后退恢复）。
 * 非法值一律归一默认（tab 未知 → all；page 非正整数 → 1；q 非字符串 → 空）。
 */
export function listStateFromQuery(query = {}) {
  const raw = query || {};
  const keys = STATUS_TABS.map((t) => t.key);
  const tab = keys.includes(String(raw.tab)) ? String(raw.tab) : 'all';
  const favOnly = String(raw.fav) === '1';
  const q = typeof raw.q === 'string' ? raw.q : '';
  const page = Number(raw.page);
  return { tab, favOnly, q, page: Number.isInteger(page) && page >= 1 ? page : 1 };
}

/** 筛选状态 → 路由 query（与 listStateFromQuery 互逆；仅非默认值输出）。 */
export function listQueryFromState(s = {}) {
  const out = {};
  if (s.tab && s.tab !== 'all') out.tab = String(s.tab);
  if (s.favOnly) out.fav = '1';
  const q = String(s.q || '').trim();
  if (q) out.q = q;
  const page = Number(s.page);
  if (Number.isInteger(page) && page > 1) out.page = String(page);
  return out;
}

/** 空态派生：loading → none（无局无筛选）→ filter（有局但筛选无结果）→ list。 */
export function deriveEmptyState({ loading = false, error = false, total = 0, rows = [], filtersActive = false } = {}) {
  if (loading) return { kind: 'loading' };
  if (error) return { kind: 'error' };
  if (rows.length === 0 && !filtersActive && total === 0) {
    return {
      kind: 'none',
      title: '还没有对局',
      text: '开始你的第一局，或从顶栏导入棋谱（SGF）',
      cta: { label: '创建对局', hash: '#/create' },
    };
  }
  if (rows.length === 0) {
    return { kind: 'filter', title: '无符合筛选的对局', text: '试试调整状态 / 收藏 / 编号或姓名搜索' };
  }
  return { kind: 'list' };
}

/**
 * 列表保留式加载判定（棋局列表防闪烁，2026/09/13/BUG-061）：切换状态 tab / 收藏筛选 /
 * 搜索 / 分页的等待期**不得**把已有行换成矮 loading 块再回弹——实测列表高度
 * 968→240→968px 塌缩回弹（同 BUG-006/051/052 根因）。已有行 → 原地保留（调用方叠
 * `.is-busy` 忙碌遮罩）；首次加载 / 当前无行 → 照常替换。
 * @param {{loading?:boolean, hasRows?:boolean}} d
 * @returns {'keep'|'replace'}
 */
export function retainListAction(d = {}) {
  const { loading = false, hasRows = false } = d;
  return loading && hasRows ? 'keep' : 'replace';
}

/**
 * 列表侧（黑/白）显示模型——人机 AI 侧用共享派生（名称 `AI` + `ai_level` 段位
 * 短标 + 风格标签`标准/拟人/匹配`，人工口径 2026/09/10）。
 */
function sideModelOf(game, side) {
  const ai = aiSideDisplay(game, side);
  if (ai) return { name: ai.name, rank: ai.rank, tag: ai.tag };
  const name = side === 'black' ? game.black_name : game.white_name;
  const raw = side === 'black' ? game.black_rank : game.white_rank;
  return {
    name: name && name !== '' ? name : '真人',
    rank: raw ? rankText(raw) : '',
    tag: '',
  };
}

/**
 * GameInfo（列表行）→ 显示模型。
 * @param {object} game  API §3.1 GameInfo（list items）
 * @param {object} [opts]
 * @param {number|Date} [opts.now]  相对时间基准（测试注入）
 */
export function deriveRow(game, opts = {}) {
  const g = game || {};
  const id = Number(g.id);
  const finished = g.status === 'finished';
  const black = sideModelOf(g, 'black');
  const white = sideModelOf(g, 'white');
  const rules = RULE_LABELS[g.rules] || g.rules || '';
  const sizeRule = `${g.board_size || 19}路${rules ? ` · ${rules}` : ''}`;
  const resultRaw = g.status === 'finished' ? resultText(g.result, { verbose: false }) : '';
  // 状态文案（2026/09/19 人工口径）：结算中（scoring，未确认结算）须与进行中区分——
  // `结算中 · 第 N 手`（原实现与 active 同文案 `进行中 · 第 N 手`，隐瞒了待结算态）
  const moveNo = Number(g.last_move_no) || 0;
  const statusText = finished
    ? (resultRaw ? `已结束 · ${resultRaw}` : '已结束')
    : g.status === 'scoring'
      ? `结算中 · 第 ${moveNo} 手`
      : moveNo > 0
        ? `进行中 · 第 ${moveNo} 手`
        : '进行中 · 尚未开局';
  const relTime = relTimeText(g.updated_at, { now: opts.now });
  const humanAi = g.mode === 'human_ai';
  // 已结束，或「已创建但 0 手」的未开局对局可删除（W-16 修订 2026/09/13：
  // 后者无任何对局数据、删之无碍；进行中且有落子的对局仍不可删）
  const canDelete = finished || (g.status === 'created' && (Number(g.last_move_no) || 0) === 0);
  return {
    id,
    fav: Boolean(g.favorite),
    finished,
    canDelete,
    modeLabel: humanAi ? '人机' : '人人',
    modeAccent: humanAi,
    black,
    white,
    fullTitle: `${black.name} vs ${white.name}`,
    sizeRule,
    statusText,
    relTime,
    primary: finished
      ? { label: '回放', kind: 'review' }
      : { label: '续弈', kind: 'game' },
  };
}

/** 归一详情落子序列（DB snake_case → 状态树 camelCase，供 replayStones）。 */
export function normalizeMoves(moves) {
  if (!Array.isArray(moves)) return [];
  return moves
    .filter((m) => m && !m.is_pass && m.x !== null && m.x !== undefined && m.y !== null && m.y !== undefined)
    .map((m) => ({
      moveNo: Number(m.move_no),
      color: m.color,
      x: Number(m.x),
      y: Number(m.y),
      isPass: Boolean(m.is_pass),
    }));
}

/** 详情（GameInfo + moves + analysis_complete）→ 预览模型。
 *  2026/09/13 人工反馈：信息行（图下一行左侧）＝`N 手 · 贴 X · 分先/让 N 子 · 结果`
 *  （结果仅结束的对局）；2026/09/21 人工决策：行首徽章＝对局编号 `#id`
 *  （原 人人/人机 模式徽章——模式由玩家行的 AI 侧派表达）。
 */
export function derivePreview(detail) {
  if (!detail) return { kind: 'empty' };
  const g = detail;
  const finished = g.status === 'finished';
  const last = Number(g.last_move_no) || 0;
  const size = Number(g.board_size) || 19;
  const moves = normalizeMoves(detail.moves);
  const stones = replayStones({
    size,
    handicap: Number(g.handicap) || 0,
    moves,
  });
  const handicap = Number(g.handicap) || 0;
  const komi = g.komi == null || !Number.isFinite(Number(g.komi)) ? null : Number(g.komi);
  const segs = [`${last} 手`];
  if (komi != null) segs.push(`贴 ${round(komi, 1)}`);
  segs.push(handicap > 0 ? `让 ${handicap} 子` : '分先');
  const resultRaw = finished && g.result ? String(g.result) : '';
  if (resultRaw) segs.push(resultRaw);
  return {
    kind: 'ready',
    id: Number(g.id),
    size,
    last,
    finished,
    stones,
    infoSegs: segs,
    reportReady: finished && Boolean(detail.analysis_complete),
    black: sideModelOf(g, 'black'),
    white: sideModelOf(g, 'white'),
    primary: finished ? { label: '回放', kind: 'review' } : { label: '续弈', kind: 'game' },
  };
}

/** 分页窗口（<=7 全显；否则按当前页 1 … cur±1 … total，省略号以 '…' 占位）。 */
export function pagerWindow(page, totalPages) {
  const total = Math.max(1, Number(totalPages) || 1);
  const cur = clampPage(page, total);
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }
  if (cur <= 3) return [1, 2, 3, '…', total];
  if (cur >= total - 2) return [1, '…', total - 2, total - 1, total];
  return [1, '…', cur - 1, cur, cur + 1, '…', total];
}

/** 分页派生（total/页/当前页 → 展示模型）。 */
export function derivePager({ total = 0, page = 1, pageSize = PAGE_SIZE } = {}) {
  const size = Number(pageSize) > 0 ? Number(pageSize) : PAGE_SIZE;
  const totalPages = Math.max(1, Math.ceil(Number(total) / size));
  const current = clampPage(page, totalPages);
  return {
    total: Number(total),
    totalPages,
    current,
    pages: pagerWindow(current, totalPages),
    hasPrev: current > 1,
    hasNext: current < totalPages,
  };
}

/**
 * 迷你棋盘 SVG（预览真实局面；网格/星位随路数）。云子渲染与主棋盘 paintStone
 * （core/stone-style.js）同源同几何（2026/09/08）：
 *   - 石体：35%/35% 三档渐变（读 app.css 预览专用云子 token，resolvePreviewStoneColors）；
 *   - 底-右缘辉光：以“石心 + (0.45R, 1.12R)”为心的 userSpaceOnUse 径向渐变
 *     （外径 1.1R，前 0.3 全强度后同色 alpha 衰减）叠于石体上——与 paintStone 同锚点同式；
 *   - 外投影：分色 feDropShadow（dx=0.1R / dy=0.2R / σ=0.15R≈canvas shadowBlur 0.3R）。
 * 石子在各自 translate 局部系内引用共享 defs → 预览数量大也不膨胀唯一渐变。
 * @param {number} size       9|13|19
 * @param {Array<{x:number,y:number,color:'black'|'white'}>} stones
 * @param {string} [uid]      gradient/filter id 后缀（同页多棋盘去重）
 * @returns {string}
 */
export function miniBoardSvg(size, stones = [], uid = '') {
  const n = Math.max(2, Math.min(19, Number(size) || 19));
  const pal = resolvePreviewStoneColors(typeof document !== 'undefined' ? document : null);
  const view = 300;
  const margin = 16;
  const cell = (view - margin * 2) / (n - 1);
  const pos = (i) => (margin + cell * i).toFixed(2);
  const lines = [];
  for (let i = 0; i < n; i += 1) {
    const p = pos(i);
    lines.push(`<line x1="${p}" y1="${margin}" x2="${p}" y2="${view - margin}"/><line x1="${margin}" y1="${p}" x2="${view - margin}" y2="${p}"/>`);
  }
  const starRows = n >= 19 ? [3, 9, 15] : n === 13 ? [3, 6, 9] : n === 9 ? [2, 4, 6] : [2];
  const stars = [];
  for (const r of starRows) {
    for (const c of starRows) {
      stars.push(`<circle cx="${pos(c)}" cy="${pos(r)}" r="2.6"/>`);
    }
  }
  const r = Math.max(2.6, cell * 0.46).toFixed(2);
  const R = Number(r);
  const pb = `pb${uid}`;
  const pw = `pw${uid}`;
  const bRim = `pbr${uid}`;
  const wRim = `pwr${uid}`;
  const db = `pdb${uid}`;
  const dw = `pdw${uid}`;
  // 底-右缘辉光（与 paintStone 同锚点/同外径/同停点）
  const rimCx = (R * 0.45).toFixed(2);
  const rimCy = (R * 1.12).toFixed(2);
  const rimRad = (R * 1.1).toFixed(2);
  // 外投影（feDropShadow：σ=0.15R ≈ canvas shadowBlur 0.3R）
  const dropDx = (R * 0.1).toFixed(2);
  const dropDy = (R * 0.2).toFixed(2);
  const dropStd = (R * 0.15).toFixed(2);

  const blackEls = [];
  const whiteEls = [];
  const pushStone = (arr, s, cx, cy) => {
    arr.push(
      `<g transform="translate(${cx} ${cy})">` +
        `<circle r="${r}" fill="url(#${s.color === 'white' || s.color === 'W' ? pw : pb})"/>` +
        `<circle r="${r}" fill="url(#${s.color === 'white' || s.color === 'W' ? wRim : bRim})"/>` +
      `</g>`,
    );
  };
  if (Array.isArray(stones)) {
    for (const s of stones) {
      if (s == null || s.x === null || s.x === undefined || s.y === null || s.y === undefined) continue;
      if (s.x < 0 || s.y < 0 || s.x >= n || s.y >= n) continue;
      const cx = pos(Number(s.x));
      const cy = pos(Number(s.y));
      if (s.color === 'white' || s.color === 'W') pushStone(whiteEls, s, cx, cy);
      else pushStone(blackEls, s, cx, cy);
    }
  }
  const stoneGroups =
    (blackEls.length ? `<g filter="url(#${db})">${blackEls.join('')}</g>` : '') +
    (whiteEls.length ? `<g filter="url(#${dw})">${whiteEls.join('')}</g>` : '');
  return (
    `<svg viewBox="0 0 ${view} ${view}" role="img" aria-label="${n} 路缩略棋盘预览">` +
    `<g stroke="var(--grid)" stroke-width="1">${lines.join('')}</g>` +
    `<g fill="var(--grid)">${stars.join('')}</g>` +
    `<defs>` +
    `<radialGradient id="${pb}" cx="35%" cy="35%" r="72%"><stop offset="0%" stop-color="${pal.b.hi}"/><stop offset="40%" stop-color="${pal.b.mid}"/><stop offset="100%" stop-color="${pal.b.lo}"/></radialGradient>` +
    `<radialGradient id="${pw}" cx="35%" cy="35%" r="72%"><stop offset="0%" stop-color="${pal.w.hi}"/><stop offset="50%" stop-color="${pal.w.mid}"/><stop offset="100%" stop-color="${pal.w.lo}"/></radialGradient>` +
    `<radialGradient id="${bRim}" gradientUnits="userSpaceOnUse" cx="${rimCx}" cy="${rimCy}" r="${rimRad}"><stop offset="0" stop-color="${pal.b.rim}"/><stop offset="0.3" stop-color="${pal.b.rim}"/><stop offset="1" stop-color="${pal.b.rim}" stop-opacity="0"/></radialGradient>` +
    `<radialGradient id="${wRim}" gradientUnits="userSpaceOnUse" cx="${rimCx}" cy="${rimCy}" r="${rimRad}"><stop offset="0" stop-color="${pal.w.rim}"/><stop offset="0.3" stop-color="${pal.w.rim}"/><stop offset="1" stop-color="${pal.w.rim}" stop-opacity="0"/></radialGradient>` +
    `<filter id="${db}" x="-80%" y="-80%" width="260%" height="260%"><feDropShadow dx="${dropDx}" dy="${dropDy}" stdDeviation="${dropStd}" flood-color="${pal.dropB}"/></filter>` +
    `<filter id="${dw}" x="-80%" y="-80%" width="260%" height="260%"><feDropShadow dx="${dropDx}" dy="${dropDy}" stdDeviation="${dropStd}" flood-color="${pal.dropW}"/></filter>` +
    `</defs>` +
    `<g class="stones">${stoneGroups}</g>` +
    `</svg>`
  );
}

/**
 * Content-Disposition → 下载文件名；解析失败回退。
 * 支持 ``attachment; filename="game_12.sgf"`` / filename*=UTF-8''… 形式。
 */
export function parseContentDispositionFilename(cd, fallback = 'game.sgf') {
  const fb = fallback && fallback !== '' ? fallback : 'game.sgf';
  if (!cd) return fb;
  const star = /filename\*=(?:UTF-8|utf-8)''([^;]+)/i.exec(cd);
  if (star && star[1]) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      /* 回退普通 filename */
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(cd);
  return plain && plain[1] ? plain[1] : fb;
}

/** 转义 HTML（列表项用户输入姓名等）。 */
export function escapeHtml(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ============================================================
 * DOM 组装（内部；thin，逻辑在纯函数层）
 * ============================================================ */

const ICON = (name, extra = '') => `<svg class="icon" aria-hidden="true"${extra ? ` style="${extra}"` : ''}><use href="#${name}"/></svg>`;

function rankSup(rank) {
  return rank ? `<span class="rank-sup">${escapeHtml(rank)}</span>` : '';
}

function playersTextHTML(row) {
  const tag = (t) => (t ? `<span class="ai-tag">· ${escapeHtml(t)}</span>` : '');
  return (
    `${escapeHtml(row.black.name)}${rankSup(row.black.rank)}${tag(row.black.tag)} ` +
    `<span class="vs-badge inline" aria-hidden="true"><svg><use href="#i-vs"/></svg></span> ` +
    `${escapeHtml(row.white.name)}${rankSup(row.white.rank)}${tag(row.white.tag)}`
  );
}

/** 主操作按钮样式（2026/09/14 人工反馈：[续弈] 不设为 primary；[回放] 保持 primary）。 */
export function primaryActionClass(kind) {
  return kind === 'game' ? 'btn btn-secondary' : 'btn btn-primary';
}

/** 单个列表行 HTML（数据驱动）。 */
export function rowHTML(row) {
  const favIcon = row.fav ? 'i-fav-on' : 'i-fav';
  const modeCls = row.modeAccent ? 'badge accent' : 'badge';
  const delDisabled = !row.canDelete;
  const delBtn =
    `<button class="btn btn-ghost btn-sm" type="button" data-act="del" data-id="${row.id}"` +
    `${delDisabled ? ' disabled' : ''} title="${delDisabled ? DELETE_DISABLED_TIP : '删除'}" aria-label="删除">` +
    `${ICON('i-trash', 'width:15px;height:15px;color:var(--c-blunder)')}</button>`;
  const exportBtn =
    `<button class="btn btn-ghost btn-sm" type="button" data-act="export" data-id="${row.id}" title="导出棋谱" aria-label="导出棋谱">` +
    `${ICON('i-download', 'width:15px;height:15px')}</button>`;
  return (
    `<div class="game-item" data-id="${row.id}" data-row data-selected="false">` +
    `<div class="g-main">` +
    `<div class="g-title" title="${escapeHtml(row.fullTitle)}">` +
    `<span class="${modeCls}">${row.modeLabel}</span>` +
    `<span class="ellipsis">${playersTextHTML(row)}</span>` +
    `</div>` +
    `</div>` +
    `<div class="g-meta">` +
    `<span class="m-size">${escapeHtml(row.sizeRule)}</span>` +
    `<span class="m-result">${escapeHtml(row.statusText)}</span>` +
    `<span class="m-time" title="${escapeHtml(row.relTime)}">${escapeHtml(row.relTime)}</span>` +
    `</div>` +
    `<div class="g-actions">` +
    `<button class="fav-btn${row.fav ? ' on' : ''}" type="button" data-act="fav" data-id="${row.id}" title="${row.fav ? '取消收藏' : '收藏'}" aria-label="${row.fav ? '取消收藏' : '收藏'}" aria-pressed="${row.fav}">` +
    `${ICON(favIcon)}</button>` +
    `<button class="${primaryActionClass(row.primary.kind)} btn-sm" type="button" data-act="open" data-id="${row.id}" data-kind="${row.primary.kind}">${row.primary.label}</button>` +
    exportBtn +
    delBtn +
    `<button class="btn btn-ghost btn-sm menu-more" type="button" data-act="more" data-id="${row.id}" title="更多操作" aria-label="更多操作" aria-expanded="false">` +
    `${ICON('i-more', 'width:15px;height:15px')}</button>` +
    `</div>` +
    `</div>`
  );
}

/** 分页 HTML。 */
export function pagerHTML(pager) {
  if (!pager || pager.totalPages <= 1) return '';
  const btn = (label, extra = '') =>
    `<button type="button" ${extra}>${label}</button>`;
  const items = pager.pages
    .map((p) =>
      p === '…'
        ? `<span class="page-ellipsis" aria-hidden="true">…</span>`
        : btn(String(p), p === pager.current ? `class="on" aria-current="page" aria-label="第 ${p} 页"` : `aria-label="第 ${p} 页" data-page="${p}"`),
    )
    .join('');
  return (
    `<div class="pager" role="navigation" aria-label="分页">` +
    `<button type="button" data-nav="prev" aria-label="上一页"${pager.hasPrev ? '' : ' disabled'}>‹</button>` +
    items +
    `<button type="button" data-nav="next" aria-label="下一页"${pager.hasNext ? '' : ' disabled'}>›</button>` +
    `</div>`
  );
}

/** 空态/加载/错误面板 HTML。 */
export function emptyHTML(kind) {
  if (kind.kind === 'loading') {
    return `<div class="rl-state" role="status" aria-live="polite"><div class="spin" aria-hidden="true"></div><p>正在加载对局…</p></div>`;
  }
  if (kind.kind === 'error') {
    return `<div class="rl-state" role="alert"><p>加载失败，请重试</p><button class="btn btn-secondary" type="button" data-act="reload">重新加载</button></div>`;
  }
  const cta = kind.cta
    ? `<a class="btn btn-primary" href="${kind.cta.hash}">${ICON('i-plus')}${escapeHtml(kind.cta.label)}</a>`
    : '';
  // 空态插画（§4.7）：与对弈/复盘空态同一枚 `#i-empty-go`（无对局/无符合筛选同图标，
  // 差异只由文案表达）；加载态与错误态不插画（避免与 spin / 重试按钮竞争注意力）
  return `<div class="rl-state"><svg class="art" aria-hidden="true"><use href="#i-empty-go"/></svg><div class="t">${escapeHtml(kind.title)}</div><div class="s">${escapeHtml(kind.text)}</div>${cta ? `<div class="rl-actions">${cta}</div>` : ''}</div>`;
}

/** 预览卡主体 HTML（桌面 aside 与移动抽屉共用）。
 * 结构（2026/09/13 人工反馈重排）：玩家行（图上方）→ 迷你棋盘 → 图下一行
 * （左＝模式徽章 + 对局信息段，不换行/超出省略；右＝操作按钮）。
 * @param {object} prev
 * @param {string} [ns='']  容器命名空间——同一选局会同时注入桌面预览卡与移动抽屉卡：
 *                          二者必须用不同 ns，否则 SVG 渐变 id（pb-/pw-）重复，
 *                          url(#…) 按文档序解析到首个定义；移动端首份落在
 *                          display:none 的桌面卡内 → 可见抽屉棋子渐变失效不显示。
 */
export function previewHTML(prev, ns = '') {
  if (!prev || prev.kind === 'empty') {
    return `<div class="rl-state"><div class="s">从左侧选择一个对局查看缩略棋面</div></div>`;
  }
  if (prev.kind === 'loading') {
    return `<div class="rl-state" role="status"><div class="spin" aria-hidden="true"></div><p>正在载入棋面…</p></div>`;
  }
  if (prev.kind === 'error') {
    return `<div class="rl-state" role="alert"><p>预览加载失败</p></div>`;
  }
  const player = (side) =>
    `<span class="p-side ${side === 'black' ? 'l' : 'r'}"><span class="stone-mini ${side === 'white' ? 'w' : ''}" aria-hidden="true"></span>${side === 'black' ? '黑' : '白'} ${escapeHtml(prev[side].name)}${rankSup(prev[side].rank)}${prev[side].tag ? `<span class="ai-tag">· ${escapeHtml(prev[side].tag)}</span>` : ''}</span>`;
  const reportBtn =
    prev.reportReady
      ? `<button class="btn btn-secondary" type="button" data-act="report" data-id="${prev.id}" title="对局报告">报告</button>`
      : '';
  // 信息行首位＝对局编号徽章（2026/09/21 人工决策：替换原 人人/人机 模式徽章；
  // 模式改由玩家行的 AI 侧派（`AI 5K · 标准`）表达，编号同时是搜索框 `#123` 的可见锚点）
  const infoHTML =
    `<span class="badge">#${escapeHtml(prev.id)}</span>` +
    prev.infoSegs
      .map((s) => `<span class="sep">·</span><span>${escapeHtml(s)}</span>`)
      .join('');
  return (
    `<div class="player-line preview-players">${player('black')}<span class="vs-badge" aria-hidden="true"><svg><use href="#i-vs"/></svg></span>${player('white')}</div>` +
    `<div class="board-wrap preview-board">${miniBoardSvg(prev.size, prev.stones, `-${prev.id}${ns ? `-${ns}` : ''}`)}</div>` +
    `<div class="preview-foot">` +
    `<div class="preview-info num">${infoHTML}</div>` +
    `<div class="preview-actions">` +
    `<button class="${primaryActionClass(prev.primary.kind)}" type="button" data-act="open" data-id="${prev.id}" data-kind="${prev.primary.kind}">${prev.primary.label}</button>` +
    reportBtn +
    `</div>` +
    `</div>`
  );
}

/* ============================================================
 * 控制器
 * ============================================================ */

const SEARCH_DEBOUNCE_MS = 300;
const DELETE_DONE_TEXT = '对局已删除';

/**
 * @param {HTMLElement} rootEl  #main（视图负责 className/innerHTML）
 * @param {object} props        {route, api, ls, toast, confirm, nav}
 */
export function createView(rootEl, props = {}) {
  const api = props.api;
  const ls = props.ls || null;
  const toast = props.toast || (() => {});
  const confirmDialog = props.confirm || (() => Promise.resolve(false));
  const nav = props.nav || ((hash) => { if (typeof location !== 'undefined') location.hash = hash; });
  const nowFn = props.now || (() => Date.now());

  // 初始筛选状态取自 URL route query（可分享/刷新/后退恢复；非法值归一默认），
  // 变更时经 syncListUrl 回写（replaceState，不重挂视图，2026/09/19）
  const initial = listStateFromQuery(props.route && props.route.query);
  const st = {
    tab: initial.tab,
    favOnly: initial.favOnly,
    q: initial.q,
    page: initial.page,
    // 固定 10 条/页（人类修订 R3）：页面随列表自然滚动，顶栏/右侧预览吸顶
    pageSize: PAGE_SIZE,
    total: 0,
    items: [],
    rows: [],
    loading: true,
    error: false,
    selId: null,
    selPreview: { kind: 'empty' },
    pendingSelect: null, // 复盘 [返回] 待选中对局（mount 时从 LS 读取一次）
    busy: new Set(), // 行内 in-flight（fav/del/open）
    // ≤767 底部预览抽屉收起态（grip 收起/展开，绝不关闭）；**进入页面默认收起**
    // （2026/09/14 人工反馈：不再自动弹出预览抽屉，用户点 grip 才展开）
    drawerCollapsed: true,
  };

  let destroyed = false;
  let loadSeq = 0;
  let searchTimer = null;
  let moreOpenId = null;
  // 编号定位未命中已提示的编号（同一编号不重复打扰；命中/换编号时重置）
  let focusMissedId = null;

  function q(sel) {
    return rootEl.querySelector(sel);
  }

  function filtersActive() {
    // 编号定位（#123）不是筛选（列表仍是同 tab/收藏/页码的全集）→ 不计入筛选态，
    // 否则空库 + 编号输入会误判为「无符合筛选的对局」
    return st.tab !== 'all' || st.favOnly || searchIntent(st.q).kind === 'name';
  }

  function renderStatic() {
    rootEl.className = 'layout';
    rootEl.innerHTML = `
      <div class="filterbar" data-ref="filterbar">
        <div class="segctl" data-ref="seg" role="group" aria-label="对局状态筛选">
          ${STATUS_TABS.map(
            (t) =>
              `<button type="button" class="${st.tab === t.key ? 'on' : ''}" data-tab="${t.key}"${st.tab === t.key ? ' aria-current="page"' : ''}>${t.label}</button>`,
          ).join('')}
          <button type="button" class="${st.favOnly ? 'on' : ''}" data-fav aria-pressed="${st.favOnly}" title="收藏筛选（与状态 tab 为 AND 组合）">${ICON('i-fav', 'width:14px;height:14px')}<span class="sr-only">仅看收藏</span></button>
        </div>
        <div class="search">
          <div style="position:relative">
            <input class="input" type="search" name="q" id="rl-q" data-ref="search" placeholder="按姓名或编号搜索…" autocomplete="off" spellcheck="false" style="padding-left:32px" aria-label="按姓名或对局编号搜索" value="${escapeHtml(st.q)}">
            ${ICON('i-search', 'position:absolute;left:9px;top:9px;color:var(--text-3)')}
          </div>
        </div>
      </div>
      <div class="game-list-wrap" data-ref="wrap">
        <div class="game-list">
          <div class="card rl-list-card" data-ref="list"></div>
        </div>
        <aside class="game-preview" data-ref="preview">
          <!-- 玻璃卡片（静态基线：预览全部内容包含在 .card 内） -->
          <div class="card" data-ref="previewCard"></div>
          <div class="preview-busy" data-ref="previewBusy" hidden aria-hidden="true"><i></i></div>
        </aside>
      </div>
      <!-- 移动端（≤767）底部弹出预览抽屉：无遮罩贴底；grip 小横条 收起/展开、绝不关闭。
           初始＝收起（进入页面不自动弹出；render() 经 setDrawerCollapsed 同步）。
           内容卡（.preview-sheet-card）与桌面预览卡同宽上限（384），详见 app.css。 -->
      <div class="preview-drawer-root" data-ref="drawerRoot">
        <section class="preview-sheet collapsed" data-ref="drawer" aria-label="选中对局缩略预览">
          <button type="button" class="drawer-grip" data-ref="grip"
                  aria-expanded="false" aria-label="展开预览（显示选中对局）"
                  title="轻点展开"></button>
          <div class="preview-sheet-body" data-ref="drawerBody">
            <div class="card preview-sheet-card" data-ref="drawerCard"></div>
            <div class="preview-busy" data-ref="drawerBusy" hidden aria-hidden="true"><i></i></div>
          </div>
        </section>
      </div>
    `;
  }

  /** 同步筛选条高亮（tab 'on' / 收藏 chip aria-pressed）；列表重绘不重建筛选条。 */
  function renderFilterState() {
    const seg = q('[data-ref="seg"]');
    if (!seg) return;
    seg.querySelectorAll('[data-tab]').forEach((b) => {
      const on = b.dataset.tab === st.tab;
      b.classList.toggle('on', on);
      if (on) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    const favBtn = seg.querySelector('[data-fav]');
    if (favBtn) {
      favBtn.classList.toggle('on', st.favOnly);
      favBtn.setAttribute('aria-pressed', String(st.favOnly));
    }
  }

  /** 列表忙碌态（保留式加载遮罩：既有行原地保留 + spinner，样式见 app.css .rl-list-card.is-busy）。 */
  function setListBusy(on) {
    const listEl = q('[data-ref="list"]');
    if (!listEl) return;
    listEl.classList.toggle('is-busy', Boolean(on));
    if (on) listEl.setAttribute('aria-busy', 'true');
    else listEl.removeAttribute('aria-busy');
  }

  function renderList() {
    const listEl = q('[data-ref="list"]');
    if (!listEl) return;
    const empty = deriveEmptyState({
      loading: st.loading,
      error: st.error,
      total: st.total,
      rows: st.rows,
      filtersActive: filtersActive(),
    });
    // 保留式加载（BUG-061）：等待期保留旧行 + 忙碌遮罩，就绪后原位替换——
    // 避免列表被矮 loading 块替换造成高度塌缩回弹/滚动跳动（同 BUG-006/051/052）。
    if (
      retainListAction({
        loading: empty.kind === 'loading',
        hasRows: Boolean(listEl.querySelector('[data-row]')),
      }) === 'keep'
    ) {
      setListBusy(true);
      return;
    }
    setListBusy(false);
    if (empty.kind !== 'list') {
      listEl.innerHTML = emptyHTML(empty);
      return;
    }
    const pager = derivePager({ total: st.total, page: st.page, pageSize: st.pageSize });
    listEl.innerHTML =
      st.rows.map((row) => rowHTML(row)).join('') + pagerHTML(pager);
    // 选中态高亮
    listEl.querySelectorAll('[data-row]').forEach((el) => {
      const on = Number(el.dataset.id) === st.selId;
      el.dataset.selected = String(on);
      el.classList.toggle('sel', on);
    });
    markBusy();
  }

  function markBusy() {
    rootEl.querySelectorAll('[data-act][data-id]').forEach((el) => {
      const id = Number(el.dataset.id);
      const act = el.dataset.act;
      if (st.busy.has(`${act}:${id}`)) el.disabled = true;
    });
  }

  /** 仅原位同步选中行高亮（不重建整表——切局只改预览，重建 10 行会引发整表重绘闪烁）。 */
  function syncRowSelection() {
    const listEl = q('[data-ref="list"]');
    if (!listEl) return;
    listEl.querySelectorAll('[data-row]').forEach((el) => {
      const on = Number(el.dataset.id) === st.selId;
      el.dataset.selected = String(on);
      el.classList.toggle('sel', on);
    });
  }

  /** 定位显示：选中行滚动到可见（复盘返回定位用；block:nearest 最小滚动，不跳页首）。 */
  function revealRow(id) {
    const el = rootEl.querySelector(`[data-row][data-id="${id}"]`);
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest' });
    }
  }

  /** 预览切局载入角标：保留旧内容期间叠小 spinner（absolute，不占布局高度；桌面/移动共用）。 */
  function setPreviewBusy(on) {
    rootEl.querySelectorAll('[data-ref="previewBusy"], [data-ref="drawerBusy"]').forEach((b) => {
      b.hidden = !on;
    });
  }

  function refreshPreview() {
    // 桌面卡与移动抽屉卡各自渲染（不同 ns → SVG 渐变 id 唯一，防重复 id 使棋子渐变失效）
    const prevCard = q('[data-ref="previewCard"]');
    const drawerCard = q('[data-ref="drawerCard"]');
    const kind = st.selPreview && st.selPreview.kind;
    const hasContent = (el) => !!el && el.childElementCount > 0;
    if (kind === 'loading' && (hasContent(prevCard) || hasContent(drawerCard))) {
      // 切局 loading：凡已有内容的容器都保留旧预览 + 叠角标。若替换为矮 loading 块，
      // 预览卡高度塌缩再回弹 → 桌面/移动预览区均会“闪烁”（PROMPTS L514 / L514 桌面）。
      setPreviewBusy(true);
      return;
    }
    // 首次加载（无可保留内容）仍走常规 loading 块；就绪/错误/空态直接写入
    if (prevCard) prevCard.innerHTML = previewHTML(st.selPreview);
    if (drawerCard) drawerCard.innerHTML = previewHTML(st.selPreview, 'd');
    setPreviewBusy(false);
  }

  // ---------------- ≤767 底部预览抽屉（grip 收起/展开，仿 T6.6 结算抽屉） ----------------
  // 人类修订 R3：无遮罩贴底弹出；顶部小横条＝收起/展开把手——轻点切换、按住下滑收起、
  // 上滑展开；绝不关闭；抽屉外输入透传（列表仍可滚/可点行）。**进入页面默认收起**
  // （2026/09/14），收起后点选其它行仅更新内容、保持用户当前收起/展开状态。

  /** 同步抽屉收起态：sheet.collapsed 隐藏内容区（仅剩 grip 条）；grip aria/title 联动。 */
  function setDrawerCollapsed(collapsed) {
    st.drawerCollapsed = Boolean(collapsed);
    const sheet = q('[data-ref="drawer"]');
    const grip = q('[data-ref="grip"]');
    if (sheet) sheet.classList.toggle('collapsed', st.drawerCollapsed);
    if (grip) {
      grip.setAttribute('aria-expanded', String(!st.drawerCollapsed));
      grip.setAttribute('aria-label', st.drawerCollapsed ? '展开预览（显示选中对局）' : '收起预览（露出更多列表）');
      grip.title = st.drawerCollapsed ? '轻点展开' : '轻点收起；按住下滑收起、上滑展开（不关闭）';
    }
  }

  /** grip 小横条交互：轻点＝收起/展开切换；按住下滑＝收起、上滑＝展开（绝不关闭）。 */
  function bindDrawerGrip() {
    const grip = q('[data-ref="grip"]');
    if (!grip) return;
    const sheet = q('[data-ref="drawer"]');
    let drag = null;
    let suppressClickUntil = 0;
    const onMove = (e) => {
      if (!drag) return;
      const dy = e.clientY - drag.y;
      if (Math.abs(dy) > 6) drag.moved = true;
      let ty = 0;
      if (st.drawerCollapsed) ty = Math.min(0, dy); // 收起态可上拉展开
      else ty = Math.max(0, dy); // 展开态可下拉收起
      if (sheet) sheet.style.transform = ty ? `translateY(${ty}px)` : '';
    };
    const end = (e) => {
      if (!drag) return;
      const dy = e.clientY - drag.y;
      const moved = drag.moved;
      drag = null;
      if (sheet) {
        sheet.classList.remove('dragging');
        sheet.style.transform = '';
      }
      try {
        grip.releasePointerCapture(e.pointerId);
      } catch {
        /* 无捕获环境 */
      }
      if (!moved) return; // 轻点交由 click 切换
      suppressClickUntil = Date.now() + 350;
      if (dy > 40 && !st.drawerCollapsed) setDrawerCollapsed(true);
      else if (dy < -40 && st.drawerCollapsed) setDrawerCollapsed(false);
    };
    grip.addEventListener('pointerdown', (e) => {
      drag = { y: e.clientY, moved: false };
      if (sheet) sheet.classList.add('dragging');
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
      setDrawerCollapsed(!st.drawerCollapsed);
    });
  }

  function renderAll() {
    renderList();
    refreshPreview();
  }

  // ---------------- 数据 ----------------

  async function loadList(keepSelection = true) {
    const seq = ++loadSeq;
    st.loading = true;
    st.error = false;
    renderFilterState();
    renderList();
    // URL 状态同步（筛选/搜索/页码；幂等）——loadList 是所有状态变更（含页修正）的必经点
    syncListUrl();
    try {
      // 定位跳页（同口径两源，2026/09/21 扩展）：① 复盘 [返回]（一次性，来自 LS 记录）；
      // ② 搜索框 `#123`（编号定位，随输入保持）。服务端在同过滤/同排序下算出该对局
      // 所在页（focus_page）；items 仍为当前 page 页。编号定位**不做 name 过滤**
      // （listQuery 已按 searchIntent 区分，否则 LIKE %#123% 恒 0 行）。
      const query = listQuery(st);
      const intent = searchIntent(st.q);
      const searchId = intent.kind === 'id' ? intent.id : null;
      const locateId = searchId != null ? searchId : st.pendingSelect;
      if (locateId != null) query.focus_id = locateId;
      const res = await api.get('/games', query);
      if (destroyed || seq !== loadSeq) return;
      const data = (res && res.data) || {};
      const items = Array.isArray(data.items) ? data.items : [];
      st.total = Number(data.total) || 0;
      st.items = items;
      st.rows = items.map((g) => deriveRow(g, { now: nowFn() }));
      st.loading = false;
      // 越界回退（删除后末页为空）：回退一页重取
      if (items.length === 0 && st.page > 1 && st.total > 0) {
        st.page -= 1;
        await loadList(false);
        return;
      }
      // 定位落点：命中当前页 → 选中 + 滚动露出；在其它页 → 跳到 focus_page 再定位；
      // 未命中（已删除/不在当前筛选内，focus_page=null）→ 复盘返回走常规回退（清除记录），
      // 搜索编号则保持列表原样 + 一次性 Toast（2026/09/21 人工决策）
      if (locateId != null) {
        if (st.rows.some((r) => r.id === locateId)) {
          if (searchId == null) {
            st.pendingSelect = null;
            clearReviewSelect();
          }
          focusMissedId = null;
          st.selId = locateId;
          selectById(locateId);
          renderList();
          revealRow(locateId);
          return;
        }
        const focusPage = Number(data.focus_page);
        if (Number.isInteger(focusPage) && focusPage >= 1 && focusPage !== st.page) {
          st.page = focusPage;
          await loadList(keepSelection);
          return;
        }
        if (searchId == null) {
          st.pendingSelect = null;
          clearReviewSelect();
        } else if (focusMissedId !== searchId) {
          focusMissedId = searchId;
          toast({
            level: 'warn',
            text: `未找到对局 #${searchId}（可能已删除，或不在当前筛选范围）`,
            key: 'rl-locate-miss',
          });
        }
      }
      reconcileSelection(keepSelection);
      renderList();
    } catch (err) {
      if (destroyed || seq !== loadSeq) return;
      st.loading = false;
      st.error = true;
      renderList();
    }
  }

  /** 选择跟随：保留原选中（仍在页内）；否则自动选首行 / 清空。 */
  function reconcileSelection(keepSelection) {
    const present = st.rows.some((r) => r.id === st.selId);
    if (present) {
      if (st.selPreview.kind === 'ready' && Number(st.selPreview.id) === st.selId) return;
      selectById(st.selId);
      return;
    }
    if (!keepSelection) {
      // 删除等主动变更：保留手动状态由调用方处理
    }
    if (st.rows.length) {
      selectById(st.rows[0].id);
    } else {
      st.selId = null;
      st.selPreview = { kind: 'empty' };
      refreshPreview();
    }
  }

  async function selectById(id) {
    const gameId = Number(id);
    if (!Number.isInteger(gameId)) return;
    const changed = st.selId !== gameId;
    st.selId = gameId;
    st.selPreview = { kind: 'loading' };
    if (changed) syncRowSelection(); // 高亮项原位跟随选中预览（避免整表重建闪烁）
    refreshPreview();
    try {
      const res = await api.get(`/games/${gameId}`);
      if (destroyed || st.selId !== gameId) return;
      st.selPreview = derivePreview(res && res.data);
    } catch {
      if (destroyed || st.selId !== gameId) return;
      st.selPreview = { kind: 'error' };
    }
    refreshPreview();
  }

  /**
   * URL 状态同步（2026/09/19 人工决策）：筛选/搜索/页码写入 hash query。
   * replaceState 不触发 hashchange → 不重挂视图；分享链接/刷新/后退可恢复筛选。
   */
  function syncListUrl() {
    if (typeof location === 'undefined' || typeof history === 'undefined') return;
    const hash = buildHash('review-list', {}, listQueryFromState(st));
    if (location.hash === hash) return;
    history.replaceState(null, '', hash);
  }

  // ---------------- 操作 ----------------

  function markBusyKey(act, id, on) {
    const key = `${act}:${id}`;
    if (on) st.busy.add(key);
    else st.busy.delete(key);
  }

  async function toggleFav(row) {
    if (st.busy.has(`fav:${row.id}`)) return;
    markBusyKey('fav', row.id, true);
    const target = !row.fav;
    try {
      await api.post(`/games/${row.id}/favorite`, { favorite: target });
      if (destroyed) return;
      row.fav = target;
      renderList();
    } catch {
      toast({ level: 'error', text: '收藏操作失败，请重试', key: 'fav' });
    } finally {
      markBusyKey('fav', row.id, false);
      // 请求期 renderList 曾把该按钮置 disabled——结束后重绘以允许连续收藏/取消收藏
      if (!destroyed) renderList();
    }
  }

  async function removeGame(row) {
    if (st.busy.has(`del:${row.id}`)) return;
    const ok = await confirmDialog({ ...DELETE_CONFIRM, okIcon: 'i-trash' });
    if (!ok || destroyed) return;
    markBusyKey('del', row.id, true);
    try {
      await api.delete(`/games/${row.id}`);
      if (destroyed) return;
      toast({ level: 'success', text: DELETE_DONE_TEXT, key: 'del' });
      if (st.selId === row.id) {
        st.selId = null;
        st.selPreview = { kind: 'empty' };
      }
      if (st.rows.length === 1 && st.page > 1) st.page -= 1;
      await loadList(false);
    } catch (err) {
      const code = (err && err.code) || '';
      toast({ code, message: code ? undefined : '删除失败，请重试', level: 'error', key: 'del' });
      markBusyKey('del', row.id, false);
    }
  }

  function openRow(row, kind) {
    if (kind === 'review') {
      // 回放：来源对局由复盘页加载时登记（LS `tgo.review-select`，2026/09/14），
      // 复盘 [返回] 时列表据此跨页定位并选中
      nav(`#/review/${row.id}`);
      return;
    }
    // 续弈：写入最近对局记录 → 回到对弈工作台恢复该局（同 T6.3 创建跳转语义）
    writeRecent(row.id);
    nav('#/');
  }

  function writeRecent(gameId) {
    if (ls && typeof ls.set === 'function') {
      try {
        ls.set(LS_KEYS.recent, { gameId, ts: nowFn() });
      } catch {
        /* localStorage 异常忽略 */
      }
    }
  }

  /** 读取并清除待定位对局（复盘 [返回] 回到列表时消费一次）。
   *  2026/09/14：记录由复盘页登记（任何入口），列表仅消费；跨页定位走服务端
   *  `focus_id`（见 loadList），定位完成后清除。 */
  function readReviewSelect() {
    if (!ls) return null;
    try {
      const v = ls.get(LS_KEYS.reviewSelect, null);
      return v && Number.isInteger(Number(v.gameId)) ? Number(v.gameId) : null;
    } catch {
      return null;
    }
  }
  function clearReviewSelect() {
    if (ls && typeof ls.remove === 'function') {
      try {
        ls.remove(LS_KEYS.reviewSelect);
      } catch {
        /* 忽略 */
      }
    }
  }

  function openDetail(kind) {
    const prev = st.selPreview;
    if (!prev || prev.kind !== 'ready') return;
    if (kind === 'review') {
      // 同 openRow：来源登记在复盘页进行
      nav(`#/review/${prev.id}`);
      return;
    }
    writeRecent(prev.id);
    nav('#/');
  }

  /** 导出 SGF：raw fetch → blob → 触发下载（Content-Disposition 文件名）。 */
  async function exportSgf(id) {
    if (st.busy.has(`export:${id}`)) return;
    markBusyKey('export', id, true);
    renderList();
    try {
      const base = String(props.apiBase || '/api').replace(/\/+$/, '');
      const res = await fetch(`${base}/games/${id}/sgf`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const cd = res.headers.get('Content-Disposition') || '';
      const filename = parseContentDispositionFilename(cd, `game_${id}.sgf`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // 延迟释放对象 URL（立即 revoke 可能取消进行中的下载）
      setTimeout(() => URL.revokeObjectURL(url), 1500);
    } catch {
      toast({ level: 'error', text: '导出失败，请重试', key: 'export' });
    } finally {
      markBusyKey('export', id, false);
      renderList();
    }
  }

  // ---------------- 菜单（移动端 ···） ----------------

  /** 全局关闭：清掉全部 .more-menu 浮层并复位展开态（防残留/跨实例堆积）。 */
  function closeMoreMenu() {
    if (typeof document !== 'undefined') {
      document.querySelectorAll('.more-menu').forEach((m) => m.remove());
    }
    rootEl.querySelectorAll('[data-act="more"]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
    moreOpenId = null;
  }

  function openMoreMenu(row, anchor) {
    closeMoreMenu();
    const rect = anchor.getBoundingClientRect();
    const menu = document.createElement('div');
    menu.className = 'more-menu';
    // 普通展开（非 menu 语义）：2026/09/19 人工决策——去 role=menu/menuitem/aria-haspopup，
    // 保留触发器 aria-expanded；Tab 可操作（无方向键菜单键盘约定负担）
    const delDisabled = !row.canDelete;
    menu.innerHTML =
      `<button type="button" class="btn btn-ghost" data-act="export" data-id="${row.id}">${ICON('i-download')}导出</button>` +
      `<button type="button" class="btn btn-ghost" data-act="del" data-id="${row.id}"${delDisabled ? ' disabled title="' + DELETE_DISABLED_TIP + '"' : ''}>${ICON('i-trash', 'color:var(--c-blunder)')}删除</button>`;
    document.body.appendChild(menu);
    const mw = menu.offsetWidth || 160;
    const left = Math.min(rect.left, window.innerWidth - mw - 8);
    const top = rect.bottom + 6;
    menu.style.left = `${Math.max(8, left)}px`;
    menu.style.top = `${top}px`;
    moreOpenId = row.id;
    anchor.setAttribute('aria-expanded', 'true');

    // 菜单挂于 document.body（不在 rootEl 内），直接为动作按钮接线
    menu.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (!b || b.disabled) return;
      e.stopPropagation();
      closeMoreMenu();
      if (b.dataset.act === 'export') exportSgf(row.id);
      else if (b.dataset.act === 'del') removeGame(row);
    });
  }

  // ---------------- 事件（具名处理器，destroy 时移除——rootEl 为壳常驻节点，防跨路由累积） ----------------

  /**
   * 键盘选中（2026/09/19 人工决策）：行内元素经键盘获得焦点（:focus-visible）→
   * 选中该行（与鼠标点行同效）。鼠标点击按钮得到的焦点不匹配 :focus-visible → 不误选。
   */
  function onRootFocusin(e) {
    const t = e.target;
    const rowEl = t && t.closest ? t.closest('[data-row]') : null;
    if (!rowEl) return;
    const id = Number(rowEl.dataset.id);
    if (!Number.isInteger(id) || id === st.selId) return;
    if (typeof t.matches === 'function') {
      try {
        if (!t.matches(':focus-visible')) return;
      } catch {
        /* 旧内核无 :focus-visible：按键盘意图处理 */
      }
    }
    selectById(id);
  }

  function onRootClick(e) {
    const t = e.target;
    // 收藏筛选（segctl 心形钮）
    const favFilterBtn = t.closest('[data-fav]');
    if (favFilterBtn) {
      st.favOnly = !st.favOnly;
      st.page = 1;
      loadList();
      return;
    }
    // 状态 tab
    const tabBtn = t.closest('[data-tab]');
    if (tabBtn) {
      const tab = tabBtn.dataset.tab;
      if (tab === st.tab) return;
      st.tab = tab;
      st.page = 1;
      loadList();
      return;
    }
    // 列表行选择（避开行内按钮/链接）
    const rowEl = t.closest('[data-row]');
    if (rowEl && !t.closest('button, a')) {
      const id = Number(rowEl.dataset.id);
      if (id !== st.selId) selectById(id);
      return;
    }
    // 分页（prev/next/页码）
    const navBtn = t.closest('[data-nav]');
    if (navBtn && !navBtn.disabled) {
      const pager = derivePager({ total: st.total, page: st.page, pageSize: st.pageSize });
      let next = st.page;
      if (navBtn.dataset.nav === 'prev' && pager.hasPrev) next -= 1;
      if (navBtn.dataset.nav === 'next' && pager.hasNext) next += 1;
      if (next !== st.page) {
        st.page = next;
        loadList();
      }
      return;
    }
    const pageBtn = t.closest('[data-page]');
    if (pageBtn) {
      const page = Number(pageBtn.dataset.page);
      if (Number.isInteger(page) && page !== st.page) {
        st.page = page;
        loadList();
      }
      return;
    }
    // 操作按钮（行 + 预览卡 + 空态 reload）
    const actBtn = t.closest('[data-act]');
    if (!actBtn) return;
    const act = actBtn.dataset.act;
    const id = Number(actBtn.dataset.id);
    const row = st.rows.find((r) => r.id === id) || null;
    if (act === 'more' && row) {
      // 再点同一行的 [···] = 关闭菜单（2026/09/14 人工反馈）；其它行仍为换行重开
      if (moreOpenId === id) closeMoreMenu();
      else openMoreMenu(row, actBtn);
      return;
    }
    if (act === 'fav' && row) {
      toggleFav(row);
      return;
    }
    if (act === 'open') {
      if (row) openRow(row, actBtn.dataset.kind || row.primary.kind);
      else openDetail(actBtn.dataset.kind || 'review');
      return;
    }
    if (act === 'export') {
      closeMoreMenu();
      exportSgf(id);
      return;
    }
    if (act === 'del') {
      closeMoreMenu();
      if (row) removeGame(row);
      return;
    }
    if (act === 'report') {
      // T6.9：报告＝全站弹层（列表行已按 analysis_complete 显隐入口）
      if (typeof props.openReport === 'function') {
        closeMoreMenu();
        props.openReport(id);
        return;
      }
      nav(`#/report/${id}?p=B`);
      return;
    }
    if (act === 'reload') {
      loadList();
    }
  }

  function onSearchInput(e) {
    const value = e.target.value;
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      searchTimer = null;
      if (destroyed || st.q === value) return;
      st.q = value;
      st.page = 1;
      loadList();
    }, SEARCH_DEBOUNCE_MS);
  }

  function onDocClick(e) {
    if (moreOpenId && !e.target.closest('.more-menu') && !e.target.closest('[data-act="more"]')) {
      closeMoreMenu();
    }
  }

  function onDocKeydown(e) {
    if (e.key === 'Escape') closeMoreMenu();
  }

  function onRootScroll() {
    closeMoreMenu();
  }

  function bindEvents() {
    rootEl.addEventListener('click', onRootClick);
    rootEl.addEventListener('focusin', onRootFocusin);
    const searchEl = q('[data-ref="search"]');
    if (searchEl) searchEl.addEventListener('input', onSearchInput);
    document.addEventListener('click', onDocClick);
    document.addEventListener('keydown', onDocKeydown);
    rootEl.addEventListener('scroll', onRootScroll, true);
    bindDrawerGrip();
  }

  // ---------------- 生命周期 ----------------

  function render() {
    st.pendingSelect = readReviewSelect();
    renderStatic();
    // 初始抽屉态（默认收起）同步到 DOM（静态壳默认展开态，需即时复位防首帧弹出）
    setDrawerCollapsed(st.drawerCollapsed);
    bindEvents();
    loadList();
  }

  function destroy() {
    destroyed = true;
    if (searchTimer) clearTimeout(searchTimer);
    closeMoreMenu();
    rootEl.removeEventListener('click', onRootClick);
    rootEl.removeEventListener('focusin', onRootFocusin);
    const searchEl = q('[data-ref="search"]');
    if (searchEl) searchEl.removeEventListener('input', onSearchInput);
    document.removeEventListener('click', onDocClick);
    document.removeEventListener('keydown', onDocKeydown);
    rootEl.removeEventListener('scroll', onRootScroll, true);
    rootEl.innerHTML = '';
  }

  return { render, destroy };
}

export default createView;
