/**
 * tGo · 前端围棋规则（落子预校验，2026/09/12）
 *
 * 与后端 `app/services/go_rules.py` **同语义**的纯函数实现——对弈/复盘试下落子
 * 前本地校验：非法即时红 ✕ + 原因 Toast、**不发送**服务器（省往返、零延迟）；
 * 服务端仍为唯一裁决者（本层与其逐点一致，避免「前端允许、服务端拒绝」分歧）。
 *
 * 规则（镜像后端）：
 *   - 吃子：四邻域连通棋串，无气即被提；
 *   - 禁入点：落子后本棋串无气（且未提子）→ 非法；
 *   - 打劫：简单劫——恰好提一子后，被提点为劫点，**紧接的下一手**若在劫点回提
 *     「恰好只提回对方上一手所下之子」（＝复现上一手前局面）则非法；提回多子
 *     （倒扑/回提整串）或不提该子 → 合法（2026/09/16 后端同步修订）；
 *     其余落子清空劫点，**PASS 同样结束劫争**（正式规则，2026/09/12 后端同步修订）。
 *
 * 职责分离：本模块带规则状态（劫点）；**渲染用**棋面回放见 `game-model.replayStones`。
 */

import { handicapPoints } from './game-model.js';

/** 非法原因（`checkMove` 返回；文案对齐后端 `GoRulesError`）。 */
export const ILLEGAL_REASON = Object.freeze({
  OUT_OF_BOUNDS: 'out_of_bounds',
  OCCUPIED: 'occupied',
  KO: 'ko',
  SUICIDE: 'suicide',
});

/** 原因 → 人类可读文案（弹 Toast；不含建议后缀，UI 层自行拼接）。 */
export function illegalMoveText(reason) {
  switch (reason) {
    case ILLEGAL_REASON.OUT_OF_BOUNDS:
      return '坐标越界';
    case ILLEGAL_REASON.OCCUPIED:
      return '该点已有棋子';
    case ILLEGAL_REASON.KO:
      return '打劫（劫点禁入）';
    case ILLEGAL_REASON.SUICIDE:
      return '禁入点（自杀）';
    default:
      return '非法落子';
  }
}

const DIRECTIONS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/** B/W（及小写）→ 'black'|'white'（与 game-model 棋盘色语义一致）。 */
function normalizeColor(c) {
  return c === 'white' || c === 'W' || c === 'w' ? 'white' : 'black';
}

/** 落子序列项是否为 PASS（缺坐标亦视为 PASS——与 replayStones 同容错）。 */
function isPassMove(m) {
  return Boolean(m && (m.isPass || m.x === null || m.x === undefined || m.y === null || m.y === undefined));
}

/** 同色棋串 + 气（空点邻域）集合（与后端 `GoBoard._group` 同语义）。 */
function groupAndLiberties(grid, sx, sy, n) {
  const color = grid[sy][sx];
  const stones = [];
  const liberties = new Set();
  const seen = new Set();
  const stack = [[sx, sy]];
  while (stack.length) {
    const [x, y] = stack.pop();
    const k = `${x},${y}`;
    if (seen.has(k)) continue;
    seen.add(k);
    stones.push([x, y]);
    for (const [dx, dy] of DIRECTIONS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
      const c = grid[ny][nx];
      if (c == null) liberties.add(`${nx},${ny}`);
      else if (c === color && !seen.has(`${nx},${ny}`)) stack.push([nx, ny]);
    }
  }
  return { stones, liberties };
}

/**
 * 由「让子 + 落子序列」回放规则状态（棋面 + 劫点）。
 *
 * PASS 逐手回放（结束劫争）；恰提一子的落子设劫点、其余清空——与后端
 * `build_board`/`_build_board` 回放完全一致。非法存档落子（SGF 导入异常等）
 * 仅做自杀回滚兜底（同 `replayStones`，不阻断 UI）。
 *
 * @param {object} [opts]
 * @param {number} [opts.size=19]     路数 9|13|19
 * @param {number} [opts.handicap=0]  让子数（黑子，星位）
 * @param {Array<{color,x,y,isPass}>} [opts.moves] 归一 move（camelCase）
 * @returns {{size:number, grid:Array<Array<'black'|'white'|null>>,
 *   koPoint:{x:number,y:number}|null, koStone:{x:number,y:number}|null}}
 *   `koPoint`＝劫点（被提单子位置）；`koStone`＝造成劫点的上一手落子点（回提合法性对照）
 */
export function replayRulesPosition({ size = 19, handicap = 0, moves = [] } = {}) {
  const n = Number(size) || 19;
  const grid = Array.from({ length: n }, () => Array(n).fill(null));
  for (const { x, y } of handicapPoints(n, handicap)) {
    if (x >= 0 && y >= 0 && x < n && y < n) grid[y][x] = 'black';
  }

  let koPoint = null;
  let koStone = null;
  for (const m of Array.isArray(moves) ? moves : []) {
    if (isPassMove(m)) {
      koPoint = null; // PASS 结束劫争（正式规则）
      koStone = null;
      continue;
    }
    const x = Number(m.x);
    const y = Number(m.y);
    if (x < 0 || y < 0 || x >= n || y >= n) {
      koPoint = null;
      koStone = null;
      continue;
    }
    const color = normalizeColor(m.color);
    const opp = color === 'black' ? 'white' : 'black';
    grid[y][x] = color;
    const captured = [];
    for (const [dx, dy] of DIRECTIONS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
      if (grid[ny][nx] !== opp) continue;
      const g = groupAndLiberties(grid, nx, ny, n);
      if (g.liberties.size === 0) {
        for (const [gx, gy] of g.stones) {
          grid[gy][gx] = null;
          captured.push([gx, gy]);
        }
      }
    }
    // 自杀兜底（服务端已禁；异常存档仅回滚该子，不设劫点）
    const own = groupAndLiberties(grid, x, y, n);
    if (own.liberties.size === 0 && captured.length === 0) {
      grid[y][x] = null;
      koPoint = null;
      koStone = null;
    } else if (captured.length === 1) {
      koPoint = { x: captured[0][0], y: captured[0][1] };
      koStone = { x, y }; // 本手落子点（回提合法性对照）
    } else {
      koPoint = null;
      koStone = null;
    }
  }
  return { size: n, grid, koPoint, koStone };
}

/**
 * 末手提子数（吃子音效判定，2026/09/15）。
 *
 * 口径：落子后棋盘总子数较落子前的变化 —— 末手落 1 子并提 k 子 → 总数减少 k-1，
 * 故 `提子数 = count(前) + 1 - count(后)`。PASS / 空谱 / 落子未生效（异常存档
 * 自杀回滚、越界）→ 0（不视为吃子）。
 *
 * @param {object} [opts] 同 `replayRulesPosition`（moves 为含末手的完整序列）
 * @returns {number} 被提子数（≥0）
 */
export function lastMoveCaptures({ size = 19, handicap = 0, moves = [] } = {}) {
  const list = Array.isArray(moves) ? moves : [];
  const last = list[list.length - 1];
  if (!last || isPassMove(last)) return 0;
  const countStones = (st) => st.grid.reduce(
    (total, row) => total + row.reduce((n, c) => n + (c ? 1 : 0), 0),
    0,
  );
  const before = replayRulesPosition({ size, handicap, moves: list.slice(0, -1) });
  const after = replayRulesPosition({ size, handicap, moves: list });
  const x = Number(last.x);
  const y = Number(last.y);
  // 末手未落在盘上（自杀回滚/越界）→ 落子未生效，不得按 +1 误报吃子
  if (!after.grid[y] || !after.grid[y][x]) return 0;
  return Math.max(0, countStones(before) + 1 - countStones(after));
}

/**
 * 只读探针：`(x,y)` 落 `color` 是否合法（不修改 `state`）。
 *
 * 顺序与后端 `GoBoard._compute_capture` 一致：越界 → 占点 → 劫点（复现前局面）→
 * 禁入点（提子后本棋串仍无气）。
 *
 * @param {{size:number, grid:Array<Array<string|null>>,
 *   koPoint:object|null, koStone:object|null}} state
 *        `replayRulesPosition` 返回值
 * @param {number} x
 * @param {number} y
 * @param {string} color 'black'|'white'|'B'|'W'
 * @returns {{legal:true} | {legal:false, reason:string}}
 */
export function checkMove(state, x, y, color) {
  const n = Number(state && state.size) || 19;
  const grid = state && state.grid ? state.grid : [];
  const cx = Number(x);
  const cy = Number(y);
  if (!Number.isInteger(cx) || !Number.isInteger(cy) || cx < 0 || cy < 0 || cx >= n || cy >= n) {
    return { legal: false, reason: ILLEGAL_REASON.OUT_OF_BOUNDS };
  }
  if (grid[cy] && grid[cy][cx] != null) {
    return { legal: false, reason: ILLEGAL_REASON.OCCUPIED };
  }

  const me = normalizeColor(color);
  const opp = me === 'black' ? 'white' : 'black';
  // 模拟盘（不改原盘）：放子 → 提对方无气串 → 本串仍有气（或提过子）则合法
  const sim = grid.map((row) => row.slice());
  sim[cy][cx] = me;
  const captured = [];
  for (const [dx, dy] of DIRECTIONS) {
    const nx = cx + dx;
    const ny = cy + dy;
    if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
    if (sim[ny][nx] !== opp) continue;
    const g = groupAndLiberties(sim, nx, ny, n);
    if (g.liberties.size === 0) {
      for (const [gx, gy] of g.stones) {
        sim[gy][gx] = null;
        captured.push([gx, gy]);
      }
    }
  }
  // 打劫：回提恰只提回上一手所下之子 ⇔ 结果局面＝上一手之前局面 ⇔ 非法
  // （提回多子＝倒扑/回提整串 → 局面不复现 → 合法）
  const ko = state && state.koPoint;
  const koStone = state && state.koStone;
  if (
    ko && ko.x === cx && ko.y === cy
    && koStone && captured.length === 1
    && captured[0][0] === koStone.x && captured[0][1] === koStone.y
  ) {
    return { legal: false, reason: ILLEGAL_REASON.KO };
  }
  const own = groupAndLiberties(sim, cx, cy, n);
  if (own.liberties.size === 0 && captured.length === 0) {
    return { legal: false, reason: ILLEGAL_REASON.SUICIDE };
  }
  return { legal: true };
}

/**
 * 便捷：由状态树 `game` 切片回放并校验（对弈视图 hook 用）。
 *
 * @param {object} game store.game（含 params/moves）
 * @param {number} x
 * @param {number} y
 * @param {string} color 应落子方（'B'|'W'|'black'|'white'）
 * @returns {{legal:true} | {legal:false, reason:string}}
 */
export function checkMoveOnGame(game, x, y, color) {
  const params = (game && game.params) || {};
  const state = replayRulesPosition({
    size: params.boardSize || 19,
    handicap: params.handicap || 0,
    moves: (game && game.moves) || [],
  });
  return checkMove(state, x, y, color);
}
