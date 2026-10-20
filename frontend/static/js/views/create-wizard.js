/**
 * tGo · 创建对局向导（T6.3，C8 / UI_UX §5.3/§6.5/W-25）
 *
 * 两步向导（全局弹层，桌面 = `.dialog.wide` 居中；移动端单列 488）：
 *   步骤 1 模式与棋手：对局模式（人机/人人）+ 执色（人机）+ 黑白双行（人机时 AI 侧灰置）
 *        + 玩家档案联想（GET /api/players?name=）+ AI 风格（标准/人类/自适应）
 *        + 难度滑杆（12 档，录段位自动定位；人人/自适应时灰置）+ [快速开始]
 *   步骤 2 棋局设置：棋盘（19/13/9）+ 规则/贴目（联动默认值）+ 让子（执黑/贴 0 锁定）
 *        + 缩略预览 + 自动点评 + 默认记忆说明
 *
 * 纯函数层（deriveXxx/validate/serialize 等）与 DOM 组件同文件拆分，顶层无 DOM
 * 副作用；组件 `createWizard` 注入 {store, api, ls, toast, nav}（视图 ctx 同源），
 * `createView(rootEl, props)` 供 `#/create` 路由装载（打开向导、关闭回 `#/`）。
 */

import { rankText } from '../core/fmt.js';
import { handicapLimit } from '../core/game-model.js';

/* ============================================================
 * 常量（LEVEL.md / API §3.1.1 / 静态稿基线）
 * ============================================================ */

/** 12 档棋力段位枚举（顺序 = LEVEL.md 难度档位 1..12，与后端 RANK_LEVELS 一致）。 */
export const RANKS = Object.freeze([
  'rank_20k', 'rank_15k', 'rank_10k', 'rank_8k',
  'rank_5k', 'rank_3k', 'rank_1k', 'rank_1d',
  'rank_3d', 'rank_5d', 'rank_7d', 'rank_9d',
]);

/** 对局模式 / 棋盘 / 规则集。 */
export const MODES = Object.freeze(['human_ai', 'human_human']);
export const BOARD_SIZES = Object.freeze([19, 13, 9]);
export const RULES = Object.freeze(['chinese', 'japanese', 'aga']);
export const RULE_LABELS = Object.freeze({ chinese: '中国', japanese: '日本', aga: 'AGA' });
/** 规则 → 默认贴目（静态稿基线：中国 7.5 / 日本 6.5 / AGA 7.5）。 */
export const RULE_KOMI = Object.freeze({ chinese: 7.5, japanese: 6.5, aga: 7.5 });
/** AI 风格（UI 三分态；后端仅 standard|human + adaptive 旗标，映射见 payload）。 */
export const AI_STYLES = Object.freeze(['standard', 'human', 'adaptive']);
export const AI_STYLE_LABELS = Object.freeze({ standard: '标准', human: '人类', adaptive: '自适应' });

/** 引擎态 → 人机是否可选（DEAD/FATAL 不可用，UI_UX §6.2）。 */
export function engineModeAllowed(engineState) {
  return engineState !== 'DEAD' && engineState !== 'FATAL';
}

/** 让子选项（按尺寸上限：19 路 0,2..9；13 路 0,2..6；9 路 0,2..4，BUG-049）。 */
export function handicapOptions(boardSize) {
  const limit = handicapLimit(boardSize) || 9;
  const opts = [0];
  for (let n = 2; n <= limit; n += 1) opts.push(n);
  return opts;
}

/* ============================================================
 * 纯函数层（无头可测）
 * ============================================================ */

/** 段位枚举 → 难度档位 1..12；未知/null → null。 */
export function rankIndex(rank) {
  if (!rank) return null;
  const idx = RANKS.indexOf(rank);
  return idx === -1 ? null : idx + 1;
}

/** 难度档位 → 段位枚举（越界钳制）。 */
export function rankOfLevel(level) {
  const n = Number(level);
  const idx = Math.max(1, Math.min(12, Number.isFinite(n) ? Math.round(n) : 4)) - 1;
  return RANKS[idx];
}

/** 难度档位 → 目标段位短标（如 5 → '5K'）；越界 → '—'。 */
export function levelRankText(level) {
  const n = Number(level);
  if (!Number.isFinite(n) || n < 1 || n > 12) return '—';
  return rankText(RANKS[Math.round(n) - 1]);
}

/** 规则 → 默认贴目。 */
export function rulesKomi(rules) {
  return RULE_KOMI[rules] != null ? RULE_KOMI[rules] : RULE_KOMI.chinese;
}

/** 生成全新表单（camelCase 内部状态；与持久化/载荷单向映射）。 */
export function initialForm() {
  return {
    mode: 'human_ai',
    boardSize: 19,
    rules: 'chinese',
    komi: RULE_KOMI.chinese,
    handicap: 0,
    humanColor: 'black', // 人机：人类执子（black|white）
    style: 'standard', // standard|human|adaptive
    level: 4, // 1..12（固定难度；adaptive 忽略）
    blackName: '',
    blackRank: null,
    whiteName: '',
    whiteRank: null,
    coaching: false, // 自动点评（支招按需，创建即开关）
  };
}

/** 人机：人类执子的一侧信息。 */
export function humanPlayer(form) {
  return form.humanColor === 'white'
    ? { name: form.whiteName, rank: form.whiteRank }
    : { name: form.blackName, rank: form.blackRank };
}

/**
 * 生成创建载荷（API §3.1.1 JSON）。
 * - 人人：省略 `ai`/`color`；黑白均录（未录名 → null 由服务端落「真人」）；
 * - 人机：`color` 仅人机；让子强制人类执黑（客户端联动，服务端复核）；
 * - 自适应：ai = {style:'human', adaptive:true}（初始水平由服务端按录段位/配置）；
 * - 固定难度：ai.level = 录段位匹配档 或 滑杆档（未录段位时必须提供）。
 */
export function derivePayload(form) {
  const black = { name: form.blackName || null, rank: form.blackRank || null };
  const white = { name: form.whiteName || null, rank: form.whiteRank || null };
  const payload = {
    mode: form.mode,
    board_size: form.boardSize,
    rules: form.rules,
    komi: form.handicap > 0 ? 0 : form.komi,
    handicap: form.handicap,
    black,
    white,
    coaching: Boolean(form.coaching),
  };
  if (form.mode === 'human_ai') {
    const human = humanPlayer(form);
    const humanRankLevel = rankIndex(human.rank);
    payload.color = form.handicap > 0 || form.humanColor === 'black' ? 'B' : 'W';
    if (form.style === 'adaptive') {
      payload.ai = { style: 'human', adaptive: true };
    } else {
      payload.ai = {
        style: form.style === 'human' ? 'human' : 'standard',
        adaptive: false,
        level: humanRankLevel || clampLevel(form.level),
      };
    }
  }
  return payload;
}

function clampLevel(level) {
  const n = Number(level);
  return Number.isFinite(n) ? Math.max(1, Math.min(12, Math.round(n))) : 4;
}

/** 人类模型缺失时的统一提示（2026/09/18 人工口径：同条件的路径文案统一）。
 *  服务端对「人类风格/自适应但未挂载人类模型」的创建请求返回 INVALID_PAYLOAD +
 *  `人类模型不可用：仅标准风格可用（人类模型缺失降级）`——向导提交被拒时按
 *  `HUMAN_MODEL_REJECT_MARK` 识别并**改走 toast**（warning），不再落卡片底部内联错误区。 */
export const HUMAN_MODEL_HINT_TEXT = '人类模型缺失：AI 仅「标准」风格可用';
/** 服务端同条件拒绝文案的识别片段（game_service._validate_create；用于把该条错误路由到 toast）。 */
export const HUMAN_MODEL_REJECT_MARK = '人类模型不可用';

/** 前端字段校验 → { field: message }。 */
export function validateForm(form, env = {}) {
  const errors = {};
  const humanOk = env.humanModelAvailable !== false;
  const engineOk = env.engineAvailable !== false;

  if (form.mode === 'human_ai' && !engineOk) {
    errors.mode = '引擎不可用，请改用「人人」模式或稍后重试';
  }
  if (form.mode === 'human_ai' && form.style !== 'standard' && !humanOk) {
    errors.style = HUMAN_MODEL_HINT_TEXT;
  }
  // 固定难度（非自适应）：未录段位时必须给档位（服务端口径同）
  if (form.mode === 'human_ai' && form.style !== 'adaptive') {
    const human = humanPlayer(form);
    if (!rankIndex(human.rank) && !clampLevel(form.level)) {
      errors.level = '请选择难度档位（未录入段位时需手动选择）';
    }
  }
  if (!Number.isFinite(Number(form.komi)) || Number(form.komi) < 0) {
    errors.komi = '贴目须为非负数字';
  }
  if ((form.blackName || '').length > 64) errors.blackName = '姓名过长（≤64 字）';
  if ((form.whiteName || '').length > 64) errors.whiteName = '姓名过长（≤64 字）';
  return errors;
}

/** 校验错误字段有序列表（用于焦点跳转首错）。 */
export const FORM_FIELD_ORDER = [
  'mode', 'blackName', 'blackRank', 'whiteName', 'whiteRank',
  'style', 'level', 'boardSize', 'rules', 'komi', 'handicap', 'coaching',
];

/** 首个错误字段。 */
export function firstErrorField(errors) {
  for (const key of FORM_FIELD_ORDER) {
    if (errors[key]) return key;
  }
  const keys = Object.keys(errors);
  return keys.length ? keys[0] : null;
}

/**
 * 表单 → localStorage 预填（最近一次创建参数 / 「再来一局」复用）。
 * 持久化仅存纯值，缺失键回退默认（向前兼容）。
 */
export function serializePrefill(form) {
  return JSON.parse(JSON.stringify(form));
}

/** 规范化持久化载荷为合法表单（类型/枚举越界回落默认，防脏数据）。 */
export function normalizePrefill(raw, fallback) {
  const base = fallback || initialForm();
  if (!raw || typeof raw !== 'object') return base;
  const pick = (key, valid, def) => {
    const v = raw[key];
    if (Array.isArray(valid)) return valid.includes(v) ? v : def;
    return v === undefined || v === null ? def : v;
  };
  const boardSize = pick('boardSize', BOARD_SIZES, base.boardSize);
  // 让子上限随棋盘尺寸钳制（旧版本持久化可能残留越界组合，BUG-049）
  const hLimit = handicapLimit(boardSize) || 9;
  const rawHandicap = Number(raw.handicap);
  const handicap = rawHandicap === 0 || (rawHandicap >= 2 && rawHandicap <= 9)
    ? Math.min(rawHandicap || 0, hLimit)
    : Math.min(Number(base.handicap) || 0, hLimit);
  return {
    mode: pick('mode', MODES, base.mode),
    boardSize,
    rules: pick('rules', RULES, base.rules),
    komi: Number.isFinite(Number(raw.komi)) && Number(raw.komi) >= 0 ? Number(raw.komi) : rulesKomi(pick('rules', RULES, base.rules)),
    handicap,
    humanColor: raw.humanColor === 'white' ? 'white' : 'black',
    style: pick('style', AI_STYLES, base.style),
    level: clampLevel(raw.level != null ? raw.level : base.level),
    blackName: typeof raw.blackName === 'string' ? raw.blackName : base.blackName,
    blackRank: typeof raw.blackRank === 'string' ? raw.blackRank : null,
    whiteName: typeof raw.whiteName === 'string' ? raw.whiteName : base.whiteName,
    whiteRank: typeof raw.whiteRank === 'string' ? raw.whiteRank : null,
    coaching: Boolean(raw.coaching),
  };
}

/** 快速开始表单（W-25：AI 风格+自适应难度，默认棋盘/规则/贴目/执色、分先/点评关）。
 * 若用户已切「人类执白」，保留该执色与白方档案（自适应初始水平取自执子方段位）。 */
export function quickStartForm(form) {
  const human = humanPlayer(form);
  const keepWhite = form.humanColor === 'white';
  return {
    ...initialForm(),
    mode: 'human_ai',
    style: 'adaptive',
    humanColor: keepWhite ? 'white' : 'black',
    blackName: keepWhite ? '' : human.name,
    blackRank: keepWhite ? null : human.rank,
    whiteName: keepWhite ? human.name : '',
    whiteRank: keepWhite ? human.rank : null,
  };
}

/** 档案联想过滤（GET /api/players 结果；name 模糊、最多 limit 条（默认 5，2026/09/19 人工反馈「限定最大 5 条下拉」），保服务端顺序）。 */
export function matchPlayers(players, query, limit = 5) {
  const q = String(query || '').trim().toLowerCase();
  const list = Array.isArray(players) ? players : [];
  if (!q) return list.slice(0, limit);
  return list.filter((p) => String((p && p.name) || '').toLowerCase().includes(q)).slice(0, limit);
}

/** 缩略棋盘 SVG（预览；深浅主题随 CSS var --grid/--board-bg）。 */
export function tinyBoardSVG(size) {
  const n = Math.max(2, Math.min(19, Number(size) || 19));
  const inset = 4;
  const span = 56 - inset * 2;
  const pos = (i) => (inset + (span * i) / (n - 1)).toFixed(2);
  const lines = [];
  for (let i = 0; i < n; i += 1) {
    lines.push(`<path d="M${pos(i)} ${inset}V${inset + span}"/><path d="M${inset} ${pos(i)}H${inset + span}"/>`);
  }
  // 星位（与 board.hoshiIndices 语义一致：天元 + 边星/四角星）
  const starRows = n >= 19 ? [3, 9, 15] : n === 13 ? [3, 6, 9] : n === 9 ? [2, 4, 6] : [2];
  const stars = [];
  for (const r of starRows) {
    for (const c of starRows) {
      stars.push(`<circle cx="${pos(c)}" cy="${pos(r)}" r="1.1"/>`);
    }
  }
  return (
    `<svg viewBox="0 0 56 56" role="img" aria-label="${n} 路棋盘预览">` +
    `<g stroke="var(--grid)" stroke-width=".5">${lines.join('')}</g>` +
    `<g fill="var(--grid)">${stars.join('')}</g></svg>`
  );
}

/** 步骤 2 预览文案（`19 路 · 中国 · 贴 7.5 · 分先`）。 */
export function previewText(form) {
  const size = `${form.boardSize} 路`;
  const rule = RULE_LABELS[form.rules] || form.rules;
  const komi = form.handicap > 0 ? 0 : form.komi;
  const desc = form.handicap > 0 ? `让 ${form.handicap} 子` : '分先';
  const parts = [size, rule, `贴 ${Number(komi)}`, desc];
  return parts.join(' · ');
}

/** 参与方显示（未录名默认「真人」；段位附短标）。 */
export function playerText(player) {
  const name = (player && player.name) || '真人';
  return player && player.rank ? `${name} ${rankText(player.rank)}` : name;
}

/** 步骤 2 预览·第一页信息行（`人机 · 黑 张三 5K vs AI 5K（标准）`）。
 *  2026/09/15 人工反馈：追加 AI 方难度展示（自适应无固定档位 → 仅标风格）。 */
export function previewPlayers(form) {
  const black = { name: form.blackName, rank: form.blackRank };
  const white = { name: form.whiteName, rank: form.whiteRank };
  if (form.mode === 'human_human') {
    return `人人 · 黑 ${playerText(black)} vs 白 ${playerText(white)}`;
  }
  const human = form.humanColor === 'white' ? white : black;
  const side = form.humanColor === 'white' ? '白' : '黑';
  const styleLabel = AI_STYLE_LABELS[form.style] || '标准';
  const aiLevel = form.style === 'adaptive' ? '' : ` ${levelRankText(form.level)}`;
  return `人机 · ${side} ${playerText(human)} vs AI${aiLevel}（${styleLabel}）`;
}

/* ============================================================
 * 组件（浏览器；依赖经注入便于 demo 替换）
 * ============================================================ */

const SUGGEST_MS = 200;

/**
 * 创建向导实例。
 * @param {object} deps {store, api, ls, toast, nav, onCreated, getState?}
 * @returns {{open(prefill?):Promise<void>, close():void, isOpen:boolean, destroy():void,
 *           refreshEnv():Promise<object>}}
 */
export function createWizard(deps = {}) {
  const doc = deps.doc || (typeof document !== 'undefined' ? document : null);
  const store = deps.store;
  const api = deps.api;
  const ls = deps.ls;
  const toast = deps.toast || (() => {});
  const nav = deps.nav || ((hash) => { if (location) location.hash = hash; });
  const onCreated = deps.onCreated || (() => {});
  // 可选：覆盖默认「关闭并回 #/」的取消行为（app.js 覆盖层模式用它原地收起）
  const onCancel = typeof deps.onCancel === 'function' ? deps.onCancel : null;
  const getEngineState = deps.getEngineState
    || (() => (store && store.getState ? (store.getState().engine || {}).state : null));

  if (!doc) {
    return { open: async () => {}, close() {}, destroy() {}, get isOpen() { return false; }, async refreshEnv() { return {}; } };
  }

  let mask = null;
  let form = initialForm();
  let step = 1;
  let env = { engineAvailable: true, humanModelAvailable: true, engineState: null };
  let submitting = false;
  let lastErrorField = null;
  let suggestTimer = null;
  let suggestions = [];
  const nodes = {};
  let escHandler = null;

  // ---------- 环境（引擎态来自 store；人类模型存在性 GET /admin/models） ----------

  async function refreshEnv() {
    const engineState = getEngineState();
    env = {
      engineState,
      engineAvailable: engineModeAllowed(engineState),
      humanModelAvailable: true,
    };
    if (api) {
      try {
        const res = await api.get('/admin/models');
        const data = res && res.data;
        if (data && Array.isArray(data.models)) {
          const hasHuman = Boolean(data.humanModelAvailable) || data.models.some((m) => m.human);
          env.humanModelAvailable = hasHuman;
        }
      } catch {
        /* 服务不可达：保持默认（提交错误经 Toast 呈现） */
      }
    }
    applyEnvToUI();
    return env;
  }

  // ---------- 渲染 ----------

  function skeleton() {
    return `
<div class="dialog-mask create-wizard" data-wizard>
  <div class="dialog wide" role="dialog" aria-modal="true" aria-label="创建对局" tabindex="-1" data-wizard-dialog>
    <h2>创建对局</h2>
    <div class="wizard-steps" role="group" aria-label="创建步骤">
      <span class="wstep-tab on" data-step-tab="1" aria-current="step"><span class="no">1</span>模式与棋手</span>
      <span class="sep muted" aria-hidden="true" style="align-self:center">→</span>
      <span class="wstep-tab" data-step-tab="2"><span class="no">2</span>棋局设置</span>
    </div>

    <!-- 步骤 1 -->
    <section data-step-panel="1">
      <div class="create-grid">
        <div>
          <div class="field">
            <label id="lbl-mode">对局模式</label>
            <div class="segctl" role="group" aria-labelledby="lbl-mode" data-seg="mode">
              <button type="button" data-v="human_ai">人机</button>
              <button type="button" data-v="human_human">人人</button>
            </div>
            <div class="hint" data-mode-hint>人机：AI 在对方回合自动落子（引擎就绪后）</div>
          </div>

          <div class="field" data-color-field>
            <label id="lbl-color">执子色</label>
            <div class="segctl" role="group" aria-labelledby="lbl-color" data-seg="color">
              <button type="button" data-v="black">黑（先行）</button>
              <button type="button" data-v="white">白</button>
            </div>
            <div class="hint" data-color-hint>人类执子颜色；让子棋自动锁定执黑</div>
          </div>

          <div class="field">
            <label for="p-name-black" id="lbl-player-black">姓名 / 段位（执黑）</label>
            <div class="form-row">
              <input class="input grow" id="p-name-black" autocomplete="off" placeholder="如：张三…" maxlength="64">
              <select class="select" id="p-rank-black" aria-label="黑方段位" style="width:110px">
                <option value="">无</option>
                ${RANKS.map((r) => `<option value="${r}">${rankText(r)}</option>`).join('')}
              </select>
            </div>
            <div class="suggest-wrap" data-suggest="black"></div>
          </div>

          <div class="field" data-player-white>
            <label for="p-name-white" id="lbl-player-white">姓名 / 段位（执白）</label>
            <div class="form-row">
              <input class="input grow" id="p-name-white" autocomplete="off" placeholder="如：李四…" maxlength="64">
              <select class="select" id="p-rank-white" aria-label="白方段位" style="width:110px">
                <option value="">无</option>
                ${RANKS.map((r) => `<option value="${r}">${rankText(r)}</option>`).join('')}
              </select>
            </div>
            <div class="suggest-wrap" data-suggest="white"></div>
          </div>
        </div>

        <div>
          <div class="field" data-style-field>
            <label id="lbl-style">AI 风格</label>
            <div class="segctl" role="group" aria-labelledby="lbl-style" data-seg="style">
              <button type="button" data-v="standard">标准</button>
              <button type="button" data-v="human">人类</button>
              <button type="button" data-v="adaptive">自适应</button>
            </div>
            <div class="hint" data-style-hint>自适应：AI 随对局动态匹配棋力（需人类模型）</div>
          </div>

          <div class="field" data-diff-field>
            <label for="difficulty-range" class="diff-label">AI 难度<span class="diff-val num" data-diff-val></span></label>
            <input type="range" class="range" id="difficulty-range" min="1" max="12" step="1" aria-label="AI 难度（12 档）">
            <div class="diff-scale" aria-hidden="true"><span>入门</span><span>业余</span><span>职业</span></div>
          </div>
        </div>
      </div>

      <div class="wizard-foot">
        <button type="button" class="btn btn-ghost" data-act="cancel">取消</button>
        <div style="display:flex;gap:12px;align-items:center">
          <span class="hint" data-quick-hint style="max-width:150px;text-align:right">与自适应 AI 对战</span>
          <button type="button" class="btn btn-secondary" data-act="quick">快速开始</button>
          <button type="button" class="btn btn-primary" data-act="next">下一步</button>
        </div>
      </div>
    </section>

    <!-- 步骤 2 -->
    <section data-step-panel="2" style="display:none">
      <div class="create-grid">
        <div>
          <div class="field">
            <label id="lbl-board">棋盘</label>
            <div class="segctl" role="group" aria-labelledby="lbl-board" data-seg="board">
              ${BOARD_SIZES.map((s) => `<button type="button" data-v="${s}">${s} 路</button>`).join('')}
            </div>
          </div>
          <div class="field">
            <label id="lbl-rules">规则 / 贴目</label>
            <div class="form-row">
              <select class="select grow" id="sel-rules" aria-label="规则">
                ${RULES.map((r) => `<option value="${r}">${RULE_LABELS[r]}</option>`).join('')}
              </select>
              <input class="input" id="inp-komi" type="number" min="0" step="0.5" aria-label="贴目" style="width:84px">
            </div>
            <div class="hint" data-rules-hint>切换默认贴目：中国 7.5 / 日本 6.5 / AGA 7.5</div>
          </div>
          <div class="field">
            <label for="sel-handicap">让子</label>
            <select class="select" id="sel-handicap" aria-label="让子">
              ${handicapOptions(form.boardSize).map((n) => `<option value="${n}">${n === 0 ? '0（分先）' : n}</option>`).join('')}
            </select>
            <div class="hint" data-komi-warn>让子棋：自动 人类执黑、白先（贴目自动锁定 0）</div>
          </div>
        </div>
        <div>
          <div class="field">
            <label>预览</label>
            <div class="preview-mini" style="align-items:flex-start">
              <div class="tiny-board" data-preview-board></div>
              <div style="min-width:0">
                <div class="muted" style="font-size:12px" data-preview-text></div>
                <div class="muted" style="font-size:12px;margin-top:2px;color:var(--accent)" data-preview-players></div>
              </div>
            </div>
          </div>
          <div class="field">
            <label id="lbl-coach">自动点评</label>
            <div class="checkline">
              <button type="button" class="switch" role="switch" aria-checked="false" data-coach>
                <span class="sr-only">自动点评</span>
              </button>
              <span class="muted" style="font-size:12px">启用 AI 评价</span>
            </div>
          </div>
          <div class="field" style="margin-bottom:0">
            <div class="muted" style="font-size:12px">「再来一局」预填上次参数</div>
          </div>
        </div>
      </div>

      <div class="wizard-foot">
        <button type="button" class="btn btn-ghost" data-act="cancel">取消</button>
        <div style="display:flex;gap:10px">
          <button type="button" class="btn btn-secondary" data-act="back">返回</button>
          <button type="button" class="btn btn-primary" data-act="submit">开始对局</button>
        </div>
      </div>
    </section>

    <div class="hint" role="alert" data-form-error></div>
  </div>
</div>`;
  }

  function $list(sel) {
    return mask ? Array.from(mask.querySelectorAll(sel)) : [];
  }

  // ---------- 收集/同步表单与 DOM ----------

  function collectFromDom() {
    // 灰置（禁用）的 AI 侧不参与收集，避免把占位/残留名写入载荷
    const sideVal = (side) => {
      const input = nodes[`name${side}`];
      if (!input || input.disabled) return { name: '', rank: null };
      return {
        name: input.value.trim(),
        rank: nodes[`rank${side}`] && nodes[`rank${side}`].value ? nodes[`rank${side}`].value : null,
      };
    };
    const b = sideVal('Black');
    const w = sideVal('White');
    form = {
      ...form,
      blackName: b.name,
      blackRank: b.rank,
      whiteName: w.name,
      whiteRank: w.rank,
      rules: nodes.rules ? nodes.rules.value : form.rules,
      komi: nodes.komi ? Number(nodes.komi.value) : form.komi,
      handicap: nodes.handicap ? Number(nodes.handicap.value) : form.handicap,
    };
  }

  function syncFormFromDom() {
    collectFromDom();
    // 段位 → 难度自动匹配（AI 固定难度下、当前录入为执子侧时）
    if (form.mode === 'human_ai' && form.style !== 'adaptive') {
      const human = humanPlayer(form);
      const lvl = rankIndex(human.rank);
      if (lvl) {
        form.level = lvl;
        if (nodes.diff) nodes.diff.value = String(lvl);
      }
    }
    updateDerivedUI();
  }

  /** 玩家行可用性（人机时 AI 侧灰置；人人双录；灰置不隐藏、不参与载荷）。 */
  function setPlayerEnabled(side, enabled) {
    const up = side === 'white' ? 'White' : 'Black';
    const input = nodes[`name${up}`];
    const select = nodes[`rank${up}`];
    if (!input) return;
    const row = input.closest('.field');
    if (row) row.classList.toggle('is-disabled', !enabled);
    input.disabled = !enabled;
    if (select) select.disabled = !enabled;
    if (!enabled) {
      // 该侧转为 AI：清除占位/残留，避免误导与误载
      if (input.value) input.value = '';
      if (select) select.value = '';
      input.placeholder = side === 'white' ? '白方由 AI 执子' : '黑方由 AI 执子';
    } else {
      input.placeholder = side === 'white' ? '如：李四…' : '如：张三…';
      // 该侧从 AI 切回可用（切人人/改执色）：清除 AI 档位展示值，避免被当作玩家段位收集
      if (select && select.dataset.aiDisplay === '1') {
        select.value = '';
        delete select.dataset.aiDisplay;
      }
    }
  }

  /** AI 侧段位栏跟随难度滑杆显示（2026/09/15 人工反馈：人机 AI 侧此前恒显「无」）。
   *  仅展示：人机 + 固定难度（标准/人类）→ 置为当前档位对应段位；自适应无固定档位
   *  → 保持「无」。该侧处于禁用态且不参与载荷（collectFromDom 对被禁用侧返回空），
   *  用 `dataset.aiDisplay` 记账，切回可用时由 setPlayerEnabled 清除。 */
  function syncAiRankDisplay() {
    if (form.mode !== 'human_ai') return;
    const select = form.humanColor === 'black' ? nodes.rankWhite : nodes.rankBlack;
    if (!select) return;
    if (form.style !== 'adaptive') {
      select.value = rankOfLevel(form.level);
      select.dataset.aiDisplay = '1';
    } else {
      select.value = '';
      delete select.dataset.aiDisplay;
    }
  }

  /** 快速开始可用性（人机 + 引擎可用 + 人类模型可用，否则灰置）。 */
  function updateQuickGating() {
    const ai = form.mode === 'human_ai';
    const canQuick = ai && env.engineAvailable && env.humanModelAvailable && !submitting;
    const reason = !ai
      ? '快速开始仅限人机对弈'
      : !env.engineAvailable
        ? '引擎不可用'
        : !env.humanModelAvailable
          ? '需人类模型（自适应）'
          : '';
    if (nodes.quick) {
      nodes.quick.disabled = !canQuick;
      nodes.quick.title = reason;
    }
    if (nodes.quickHint) nodes.quickHint.classList.toggle('is-disabled', !canQuick);
  }

  /** 让子数随棋盘上限钳制（9/13/19 路 → 4/6/9 子，BUG-049；切换棋盘时静默降档）。 */
  function clampHandicapToBoard() {
    const limit = handicapLimit(form.boardSize) || 9;
    if (form.handicap > limit) form.handicap = limit;
  }

  /** 按当前棋盘上限重建让子下拉选项（集合未变则跳过，避免重建丢失选中态）。 */
  function rebuildHandicapOptions() {
    if (!nodes.handicap) return;
    const opts = handicapOptions(form.boardSize);
    const sig = opts.join(',');
    if (nodes.handicap.dataset.optsSig === sig) return;
    nodes.handicap.dataset.optsSig = sig;
    nodes.handicap.innerHTML = opts
      .map((n) => `<option value="${n}">${n === 0 ? '0（分先）' : n}</option>`)
      .join('');
  }

  function updateDerivedUI() {
    if (!mask) return;
    const ai = form.mode === 'human_ai';
    const pvp = !ai;
    const forced = form.handicap > 0;
    if (forced && form.humanColor !== 'black') form.humanColor = 'black';
    const humanColor = form.humanColor;

    // 模式 tab
    markSeg(nodes.modeSeg, form.mode);
    // 执色：人机可调；人人灰置（不隐藏）；让子锁定人类执黑
    if (nodes.colorSeg) {
      nodes.colorSeg.querySelectorAll('button').forEach((btn) => {
        const disabled = pvp || (forced && btn.dataset.v === 'white');
        btn.disabled = disabled;
        btn.title = pvp ? '人人模式由两侧棋手分别执黑/执白' : disabled ? '让子棋锁定人类执黑' : '';
      });
    }
    markSeg(nodes.colorSeg, form.humanColor);
    if (nodes.colorHint) {
      nodes.colorHint.textContent = pvp
        ? '人人：黑 / 白 由两侧棋手分别承担（无需执色）'
        : forced
          ? '让子棋：人类执黑放置让子、AI 执白、贴目 0'
          : '人类执子颜色；让子棋自动锁定执黑';
    }
    // 玩家行：人机时 AI 侧灰置（不隐藏）；人人双录可用
    setPlayerEnabled('black', pvp || humanColor === 'black');
    setPlayerEnabled('white', pvp || humanColor === 'white');
    // AI 侧段位栏跟随难度档位显示（2026/09/15）
    syncAiRankDisplay();
    if (nodes.lblBlack) nodes.lblBlack.textContent = pvp || humanColor === 'black' ? '姓名 / 段位（执黑）' : '姓名 / 段位（执黑 · AI）';
    if (nodes.lblWhite) nodes.lblWhite.textContent = pvp || humanColor === 'white' ? '姓名 / 段位（执白）' : '姓名 / 段位（执白 · AI）';

    // AI 风格：人机可用；人人灰置（不隐藏）
    if (nodes.styleSeg) {
      nodes.styleSeg.querySelectorAll('button').forEach((btn) => {
        const needHuman = btn.dataset.v === 'human' || btn.dataset.v === 'adaptive';
        const disabled = pvp || (needHuman && !env.humanModelAvailable);
        btn.disabled = disabled;
        btn.title = pvp ? '人人模式无 AI' : needHuman && !env.humanModelAvailable ? '人类模型缺失，不可用' : '';
      });
    }
    markSeg(nodes.styleSeg, form.style);
    if (nodes.styleHint) {
      const initText = rankText(humanPlayer(form).rank) || '5K';
      nodes.styleHint.textContent = pvp
        ? '人人模式：不涉及 AI 风格 / 难度'
        : form.style === 'adaptive'
          ? `自适应：AI 随对局动态匹配棋力（初始 ${initText}）`
          : form.style === 'human'
            ? '人类风格：拟人棋风'
            : '标准风格：以最高棋力对弈';
    }

    // 难度滑杆：非人机或自适应 → 灰置（不隐藏）
    const diffUsable = ai && form.style !== 'adaptive';
    if (nodes.diff) {
      nodes.diff.value = String(clampLevel(form.level));
      nodes.diff.disabled = !diffUsable;
    }
    if (nodes.diffVal) nodes.diffVal.textContent = diffUsable ? levelRankText(form.level) : '—';

    markSeg(nodes.boardSeg, form.boardSize);
    if (nodes.rules) nodes.rules.value = form.rules;
    clampHandicapToBoard();
    rebuildHandicapOptions();
    if (nodes.handicap) nodes.handicap.value = String(form.handicap);
    if (nodes.komi) {
      nodes.komi.disabled = forced;
      nodes.komi.value = forced ? '0' : String(form.komi);
    }
    // 让子提示行常驻：仅强调色切换（防弹窗高度跳动）
    if (nodes.komiWarn) {
      nodes.komiWarn.classList.toggle('on', forced);
      nodes.komiWarn.textContent = forced ? '让子棋不贴目（贴目自动锁定 0）' : '让子棋：自动 人类执黑、白先（贴目自动锁定 0）';
    }
    if (nodes.coach) {
      nodes.coach.setAttribute('aria-checked', String(form.coaching));
      nodes.coach.classList.toggle('on', form.coaching);
    }
    if (nodes.rulesHint) nodes.rulesHint.textContent = '切换默认贴目：中国 7.5 / 日本 6.5 / AGA 7.5';
    // 预览：棋局设置 + 第一页棋手/模式信息
    if (nodes.previewBoard) nodes.previewBoard.innerHTML = tinyBoardSVG(form.boardSize);
    if (nodes.previewText) nodes.previewText.textContent = previewText(form);
    if (nodes.previewPlayers) nodes.previewPlayers.textContent = previewPlayers(form);
    // 模式提示
    if (nodes.modeHint) {
      nodes.modeHint.textContent = ai
        ? '人机：AI 在对方回合自动落子'
        : '人人：双方可在任一设备轮流落子';
    }
    updateSegGating();
  }

  function updateSegGating() {
    const aiDisabled = !env.engineAvailable;
    if (nodes.modeSeg) {
      nodes.modeSeg.querySelectorAll('button').forEach((btn) => {
        if (btn.dataset.v === 'human_ai') {
          btn.disabled = aiDisabled;
          btn.title = aiDisabled ? '引擎不可用' : '';
        }
      });
    }
    updateQuickGating();
  }

  function markSeg(container, value) {
    if (!container) return;
    container.querySelectorAll('button').forEach((btn) => {
      const on = String(btn.dataset.v) === String(value);
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-pressed', String(on));
    });
  }

  function applyEnvToUI() {
    if (!mask) return;
    const aiDisabled = !env.engineAvailable;
    // 引擎不可用：打开时若默认人机 → 切人人（并灰置人机按钮）；提示经 Toast 一次性告知
    //（内联错误区仅留给表单校验，空态不占位）
    if (aiDisabled && form.mode === 'human_ai') {
      form.mode = 'human_human';
      toast({ level: 'warning', text: '引擎不可用：已切换为「人人」模式', key: 'engine-unavailable-human' });
    }
    if (!env.humanModelAvailable && form.style !== 'standard') {
      form.style = 'standard';
    }
    updateDerivedUI();
    updateSegGating();
  }

  function showInlineError(message) {
    if (!nodes.formError) return;
    nodes.formError.textContent = message || '';
  }

  /** 可在段选组（segctl）/对话框内定位的焦点目标选择器。 */
  const FOCUSABLE_SEL = 'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])';

  function focusFirstError() {
    const errors = validateForm(form, env);
    const field = firstErrorField(errors);
    if (!field) return null;
    lastErrorField = field;
    const el = nodeForField(field);
    // 段选组（mode/style/boardSize）本体不可聚焦 → 聚焦组内首个可聚焦控件；
    // 再退化为对话框本体（tabindex=-1，可见焦点环由 :focus-visible 提供）
    const target = el && typeof el.querySelector === 'function'
      ? ((el.matches && el.matches(FOCUSABLE_SEL)) ? el : el.querySelector(FOCUSABLE_SEL))
      : el;
    if (target && typeof target.focus === 'function') {
      target.focus();
    } else if (mask) {
      const dialog = mask.querySelector('.dialog');
      if (dialog && typeof dialog.focus === 'function') dialog.focus();
    }
    return errors;
  }

  function nodeForField(field) {
    if (!mask) return null;
    const map = {
      mode: nodes.modeSeg,
      blackName: nodes.nameBlack,
      blackRank: nodes.rankBlack,
      whiteName: nodes.nameWhite,
      whiteRank: nodes.rankWhite,
      style: nodes.styleSeg,
      level: nodes.diff,
      boardSize: nodes.boardSeg,
      rules: nodes.rules,
      komi: nodes.komi,
      handicap: nodes.handicap,
      coaching: nodes.coach,
    };
    return map[field] || null;
  }

  // ---------- 玩家档案联想 ----------

  async function fetchSuggestions(side, query) {
    if (!api) return [];
    const res = await api.get('/players', { name: query || '', limit: 20 });
    return Array.isArray(res && res.data) ? res.data : [];
  }

  async function refreshSuggestions(side) {
    const input = nodes[`name${side === 'white' ? 'White' : 'Black'}`];
    if (!input) return;
    if (!mask) return; // 向导已关闭（在途焦点/点击/输入事件）：不渲染
    const box = mask.querySelector(`[data-suggest="${side}"]`);
    const query = input.value.trim();
    try {
      const list = await fetchSuggestions(side, query);
      suggestions = matchPlayers(list, query);
    } catch {
      suggestions = [];
    }
    renderSuggestBox(box, side, suggestions);
  }

  function renderSuggestBox(box, side, items) {
    if (!box) return;
    box.innerHTML = '';
    if (!items.length) return;
    const ul = doc.createElement('ul');
    ul.className = 'suggest-list';
    ul.setAttribute('role', 'listbox');
    for (const item of items) {
      const li = doc.createElement('li');
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = 'suggest-item';
      btn.setAttribute('role', 'option');
      btn.textContent = item.rank ? `${item.name} · ${rankText(item.rank)}` : item.name;
      // 选中必须绑定 **pointerdown**（早于输入框 blur 的延迟清理）：若等 click，
      // 慢点击/触摸长按（>120ms）时联想框已被 blur 清理移除，click 永不触发
      // → 「选中档案却无法录入人名/段位」（2026/09/15 人工反馈）。
      // preventDefault 阻止焦点转移：输入框不失焦，联想框保持到选中完成。
      btn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        pickSuggestion(side, item);
      });
      // 键盘激活兜底（鼠标/触摸路径已在 pointerdown 完成选中，节点此时通常已移除）
      btn.addEventListener('click', () => pickSuggestion(side, item));
      li.appendChild(btn);
      ul.appendChild(li);
    }
    box.appendChild(ul);
  }

  function pickSuggestion(side, item) {
    // 选中即结束联想：清掉在途 debounce，防止选中后旧请求把联想框又渲染回来
    if (suggestTimer) clearTimeout(suggestTimer);
    suggestTimer = null;
    const input = nodes[`name${side === 'white' ? 'White' : 'Black'}`];
    const select = nodes[`rank${side === 'white' ? 'White' : 'Black'}`];
    if (input) input.value = item.name || '';
    if (select) select.value = item.rank || '';
    const box = mask.querySelector(`[data-suggest="${side}"]`);
    if (box) box.innerHTML = '';
    suggestions = [];
    if (side === 'white') form.whiteName = item.name || '';
    else form.blackName = item.name || '';
    syncFormFromDom();
  }

  // ---------- 提交 ----------

  function prefillFromLs() {
    if (ls && typeof ls.get === 'function') {
      const raw = ls.get('tgo.create-prefill', null);
      if (raw) form = normalizePrefill(raw, initialForm());
    }
  }

  async function submit(payloadOverride) {
    if (submitting) return;
    collectFromDom();
    const errors = validateForm(form, env);
    if (Object.keys(errors).length) {
      showInlineError(Object.values(errors)[0]);
      focusFirstError();
      return;
    }
    submitting = true;
    setSubmittingUI(true);
    try {
      const payload = payloadOverride || derivePayload(form);
      const res = await api.post('/games', payload);
      const gameId = res && res.data && Number(res.data.game_id);
      if (!gameId) throw new Error('创建失败：服务端未返回 game_id');
      // 最近创建参数预填 + 最近对局记录（供「再来一局」/刷新恢复）
      if (ls && typeof ls.set === 'function') {
        ls.set('tgo.create-prefill', serializePrefill(form));
        ls.set('tgo.recent', { gameId, ts: Date.now() });
      }
      onCreated(gameId, form);
      toast({ level: 'success', text: '对局已创建，准备战斗！', key: 'create-ok' });
      close();
      nav('#/');
      window.dispatchEvent(new CustomEvent('tgo:game-created', { detail: { gameId } }));
    } catch (err) {
      submitting = false;
      setSubmittingUI(false);
      const code = (err && err.code) || '';
      const message = (err && err.message) || '';
      // 人类模型缺失（服务端拒绝人类风格/自适应创建）→ toast 呈现，不再落卡片底部
      // 内联错误区（2026/09/18 人工口径；文案同 validateForm 的降级说明）
      if (code === 'INVALID_PAYLOAD' && message.includes(HUMAN_MODEL_REJECT_MARK)) {
        toast({ level: 'warning', text: HUMAN_MODEL_HINT_TEXT, key: 'human-model-missing' });
      } else if (code === 'INVALID_PAYLOAD' || code === 'PLAYER_INVALID_RANK') {
        showInlineError(message || '参数不合法，请检查表单');
      } else {
        toast({ code: code || 'INTERNAL_ERROR', message: message || '创建失败', level: 'error' });
      }
    }
  }

  function setSubmittingUI(busy) {
    $list('[data-act="submit"], [data-act="quick"], [data-act="next"]').forEach((btn) => {
      btn.disabled = busy;
    });
    if (!busy) updateQuickGating();
  }

  // ---------- 步骤导航 ----------

  function goStep(next) {
    step = next;
    $list('[data-step-panel]').forEach((panel) => {
      panel.style.display = panel.dataset.stepPanel === String(step) ? '' : 'none';
    });
    $list('[data-step-tab]').forEach((tab) => {
      const on = tab.dataset.stepTab === String(step);
      tab.classList.toggle('on', on);
      // 步骤指示器（非 tablist）——当前步用 aria-current 向后读屏传达
      if (on) tab.setAttribute('aria-current', 'step');
      else tab.removeAttribute('aria-current');
    });
    showInlineError('');
  }

  function nextStep() {
    collectFromDom();
    const errors = validateForm(form, env);
    if (Object.keys(errors).length) {
      showInlineError(Object.values(errors)[0]);
      focusFirstError();
      return;
    }
    goStep(2);
  }

  async function quickStart() {
    if (submitting) return;
    collectFromDom();
    if (form.mode !== 'human_ai') {
      showInlineError('快速开始仅支持人机对弈（与自适应 AI 对战）');
      return;
    }
    const errors = validateForm({ ...form, style: 'adaptive' }, env);
    if (Object.keys(errors).length) {
      showInlineError(Object.values(errors)[0]);
      return;
    }
    // 快速开始 = 重置默认参数 + 保留执子方档案；同步回表单/DOM 后统一提交
    form = quickStartForm(form);
    syncFormToDom();
    updateDerivedUI();
    await submit();
  }

  /** 将内部 form 同步回输入控件（快速开始重置 / 预填后等场景）。 */
  function syncFormToDom() {
    const setSide = (side) => {
      const up = side === 'white' ? 'White' : 'Black';
      const input = nodes[`name${up}`];
      const select = nodes[`rank${up}`];
      if (input) input.value = form[side === 'white' ? 'whiteName' : 'blackName'] || '';
      if (select) select.value = form[side === 'white' ? 'whiteRank' : 'blackRank'] || '';
    };
    setSide('black');
    setSide('white');
  }

  // ---------- 生命周期 ----------

  function open(prefill) {
    if (mask) return Promise.resolve();
    mask = doc.createElement('div');
    mask.innerHTML = skeleton();
    doc.body.appendChild(mask);
    bind();
    form = prefill ? normalizePrefill(prefill, initialForm()) : initialForm();
    if (!prefill) prefillFromLs();
    syncFormToDom();
    step = 1;
    goStep(1);
    updateDerivedUI();
    // refreshEnv 内 applyEnvToUI 会处理引擎不可用 → 人机灰置/切人人 + Toast 提示
    return refreshEnv();
  }

  function close() {
    if (!mask) return;
    if (suggestTimer) clearTimeout(suggestTimer);
    suggestTimer = null;
    if (escHandler) doc.removeEventListener('keydown', escHandler, true);
    escHandler = null;
    mask.remove();
    mask = null;
    lastErrorField = null;
  }

  function destroy() {
    close();
  }

  function bind() {
    nodes.mask = mask;
    nodes.modeSeg = mask.querySelector('[data-seg="mode"]');
    nodes.colorSeg = mask.querySelector('[data-seg="color"]');
    nodes.styleSeg = mask.querySelector('[data-seg="style"]');
    nodes.boardSeg = mask.querySelector('[data-seg="board"]');
    nodes.colorField = mask.querySelector('[data-color-field]');
    nodes.styleField = mask.querySelector('[data-style-field]');
    nodes.diffField = mask.querySelector('[data-diff-field]');
    nodes.playerWhite = mask.querySelector('[data-player-white]');
    nodes.nameBlack = mask.querySelector('#p-name-black');
    nodes.rankBlack = mask.querySelector('#p-rank-black');
    nodes.nameWhite = mask.querySelector('#p-name-white');
    nodes.rankWhite = mask.querySelector('#p-rank-white');
    nodes.diff = mask.querySelector('#difficulty-range');
    nodes.diffVal = mask.querySelector('[data-diff-val]');
    nodes.rules = mask.querySelector('#sel-rules');
    nodes.komi = mask.querySelector('#inp-komi');
    nodes.handicap = mask.querySelector('#sel-handicap');
    nodes.coach = mask.querySelector('[data-coach]');
    nodes.komiWarn = mask.querySelector('[data-komi-warn]');
    nodes.rulesHint = mask.querySelector('[data-rules-hint]');
    nodes.modeHint = mask.querySelector('[data-mode-hint]');
    nodes.colorHint = mask.querySelector('[data-color-hint]');
    nodes.styleHint = mask.querySelector('[data-style-hint]');
    nodes.previewBoard = mask.querySelector('[data-preview-board]');
    nodes.previewText = mask.querySelector('[data-preview-text]');
    nodes.previewPlayers = mask.querySelector('[data-preview-players]');
    nodes.formError = mask.querySelector('[data-form-error]');
    nodes.quick = mask.querySelector('[data-act="quick"]');
    nodes.quickHint = mask.querySelector('[data-quick-hint]');
    nodes.lblBlack = mask.querySelector('#lbl-player-black');
    nodes.lblWhite = mask.querySelector('#lbl-player-white');

    // 分段按钮（事件委托）
    mask.addEventListener('click', (e) => {
      const segBtn = e.target.closest('[data-seg] button');
      if (segBtn && !segBtn.disabled) {
        const seg = segBtn.closest('[data-seg]').dataset.seg;
        const v = segBtn.dataset.v;
        if (seg === 'mode') {
          form.mode = v;
          if (v === 'human_human') form.humanColor = 'black';
        } else if (seg === 'color') {
          form.humanColor = v;
        } else if (seg === 'style') {
          form.style = v;
        } else if (seg === 'board') {
          form.boardSize = Number(v);
        }
        syncFormFromDom();
        return;
      }
      const act = e.target.closest('[data-act]');
      if (!act || act.disabled) return;
      const key = act.dataset.act;
      if (key === 'cancel') { handleCancel(); return; }
      if (key === 'next') { nextStep(); return; }
      if (key === 'back') { goStep(1); return; }
      if (key === 'submit') { submit(); return; }
      if (key === 'quick') { quickStart(); return; }
    });

    // 文字输入（执黑/执白）→ 档案联想
    ['Black', 'White'].forEach((suffix) => {
      const side = suffix === 'White' ? 'white' : 'black';
      const input = nodes[`name${suffix}`];
      // 单击/聚焦即拉取历史档案下拉（空输入 = 最近使用优先；2026/09/15 人工反馈：
      // 此前仅 input 事件触发 → 单击输入框无下拉，必须敲一个字符才出现）
      const showList = () => {
        if (suggestTimer) clearTimeout(suggestTimer);
        suggestTimer = null;
        refreshSuggestions(side);
      };
      input.addEventListener('focus', showList);
      input.addEventListener('click', showList);
      input.addEventListener('input', () => {
        if (suggestTimer) clearTimeout(suggestTimer);
        const query = input.value.trim();
        suggestTimer = setTimeout(() => {
          suggestTimer = null;
          refreshSuggestions(side);
        }, query ? SUGGEST_MS : 0);
        syncFormFromDom();
      });
      input.addEventListener('blur', () => {
        // 防点选联想项时误隐藏：延迟清空（选中已在 pointerdown 完成，不依赖此时序）
        setTimeout(() => {
          if (!mask) return; // 关闭/切页后定时器仍可能到达：此时 DOM 已销毁
          const box = mask.querySelector(`[data-suggest="${side}"]`);
          if (box) box.innerHTML = '';
        }, 120);
      });
    });

    // 段位下拉 → 难度自动匹配
    ['Black', 'White'].forEach((suffix) => {
      const select = nodes[`rank${suffix}`];
      select.addEventListener('change', () => syncFormFromDom());
    });

    // 难度滑杆 / 规则 / 贴目 / 让子
    nodes.diff.addEventListener('input', () => {
      form.level = Number(nodes.diff.value);
      updateDerivedUI();
    });
    nodes.rules.addEventListener('change', () => {
      form.rules = nodes.rules.value;
      if (form.handicap === 0) {
        form.komi = rulesKomi(form.rules);
      }
      updateDerivedUI();
    });
    nodes.komi.addEventListener('input', () => {
      collectFromDom();
      updateDerivedUI();
    });
    nodes.handicap.addEventListener('change', () => {
      const h = Number(nodes.handicap.value);
      form.handicap = h;
      if (h > 0) {
        form.humanColor = 'black';
        form.komi = 0;
      } else {
        form.komi = rulesKomi(form.rules);
      }
      updateDerivedUI();
    });
    nodes.coach.addEventListener('click', () => {
      form.coaching = !form.coaching;
      updateDerivedUI();
    });

    // Esc 关闭（保存于打开态）
    escHandler = (e) => {
      if (e.key === 'Escape') handleCancel();
    };
    doc.addEventListener('keydown', escHandler, true);

    // 焦点首元素
    setTimeout(() => {
      const first = mask.querySelector('#p-name-black, [data-seg="mode"] button');
      if (first) first.focus();
    }, 0);
  }

  function handleCancel() {
    if (!mask) return;
    showInlineError('');
    close();
    if (onCancel) onCancel();
    else nav('#/');
  }

  return {
    open,
    close,
    destroy,
    refreshEnv,
    get isOpen() {
      return Boolean(mask);
    },
    get form() {
      return form;
    },
    get env() {
      return env;
    },
  };
}

/**
 * 路由视图工厂（#/create）：保留供旧装载器/测试使用；产品入口由 app.js 以
 * 「覆盖层」方式直接打开 `createWizard`（背景页不卸载，2026/10/21）。
 * props 来自 app.js viewCtx（store/api/ls/toast/nav/confirm）。
 */
export function createView(rootEl, props = {}) {
  const wizard = createWizard(props);
  return {
    render() {
      rootEl.className = '';
      rootEl.innerHTML = '';
      wizard.open();
    },
    destroy() {
      wizard.destroy();
    },
    get isOpen() {
      return wizard.isOpen;
    },
  };
}

export default createView;
