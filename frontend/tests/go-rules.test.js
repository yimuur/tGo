/**
 * tGo · 前端围棋规则（落子预校验）无头单测（2026/09/12，node --test）
 * 用例 ID: FE-RULES-*
 * 覆盖：回放（吃子/让子/PASS 结束劫争）+ checkMove 校验矩阵（越界/占点/劫点/
 * 自杀/提子解禁）+ 原因文案 + 探针只读性；语义对齐后端 go_rules.py
 * （见 backend/tests/test_go_rules.py TestKo/TestCapture/TestSuicide）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ILLEGAL_REASON,
  illegalMoveText,
  replayRulesPosition,
  checkMove,
  checkMoveOnGame,
  lastMoveCaptures,
} from '../static/js/core/go-rules.js';

/** 归一 move 便捷（camelCase，与状态树一致）。 */
function mv(moveNo, color, x, y, isPass = false) {
  return { moveNo, color, x, y, isPass };
}

/** 真实劫形（19 路，镜像后端 test_go_rules._real_ko_position 的着法序）。 */
const REAL_KO_SEQ = [
  mv(1, 'black', 8, 9),
  mv(2, 'white', 9, 7),
  mv(3, 'black', 10, 9),
  mv(4, 'white', 8, 8),
  mv(5, 'black', 9, 10),
  mv(6, 'white', 10, 8),
  mv(7, 'white', 9, 9), // W 单子：仅 (9,8) 一气
  mv(8, 'black', 9, 8), // B 提 W(9,9) → 劫点 (9,9)
];

/** 倒扑（snapback）形（9 路，镜像后端 `test_go_rules._snapback_position` 的着法序）。 */
const SNAPBACK_SEQ = [
  mv(1, 'black', 0, 0),
  mv(2, 'white', 1, 0), // W 单子：仅 (1,1) 一气
  mv(3, 'black', 2, 0),
  mv(4, 'white', 3, 0),
  mv(5, 'black', 0, 1),
  mv(6, 'white', 0, 2),
  mv(7, 'black', 2, 1),
  mv(8, 'white', 3, 1),
  mv(9, 'black', 1, 2),
  mv(10, 'white', 2, 2),
  mv(11, 'black', 8, 8), // 脱先填充（保持轮次）
  mv(12, 'white', 1, 3),
  mv(13, 'black', 1, 1), // B 提 W(1,0) → 劫点 (1,0)；B 六子串仅剩一气 (1,0)
];

test('FE-RULES-01 初始空盘无劫点', () => {
  const s = replayRulesPosition({ size: 9, moves: [] });
  assert.equal(s.size, 9);
  assert.equal(s.grid[4][4], null);
  assert.equal(s.koPoint, null);
});

test('FE-RULES-02 吃子回放：单子被提', () => {
  // B(4,4), W(5,4)... 构造：W 单子 (0,0) 被 B(1,0)+B(0,1) 提（角上）
  const s = replayRulesPosition({
    size: 9,
    moves: [mv(1, 'white', 0, 0), mv(2, 'black', 1, 0), mv(3, 'white', 8, 8), mv(4, 'black', 0, 1)],
  });
  assert.equal(s.grid[0][0], null); // W 被提
  assert.deepEqual(s.koPoint, { x: 0, y: 0 }); // 恰提一子 → 劫点
});

test('FE-RULES-03 让子初始石回放', () => {
  const s = replayRulesPosition({ size: 19, handicap: 2, moves: [] });
  assert.equal(s.grid[3][15], 'black'); // 右上 (15,3)
  assert.equal(s.grid[15][3], 'black'); // 左下 (3,15)
});

test('FE-RULES-04 真实劫形：劫点设置与回提禁入', () => {
  const s = replayRulesPosition({ size: 19, moves: REAL_KO_SEQ });
  assert.deepEqual(s.koPoint, { x: 9, y: 9 });
  assert.deepEqual(s.koStone, { x: 9, y: 8 }); // 造成劫点的落子点（回提判定对照）
  const verdict = checkMove(s, 9, 9, 'white');
  assert.equal(verdict.legal, false);
  assert.equal(verdict.reason, ILLEGAL_REASON.KO);
});

test('FE-RULES-05 他处落子解除劫点', () => {
  const s = replayRulesPosition({
    size: 19,
    moves: [...REAL_KO_SEQ, mv(9, 'white', 0, 0)],
  });
  assert.equal(s.koPoint, null);
});

test('FE-RULES-06 PASS 结束劫争：劫点解除、回提合法', () => {
  const s = replayRulesPosition({
    size: 19,
    moves: [...REAL_KO_SEQ, { moveNo: 9, color: 'white', x: null, y: null, isPass: true }],
  });
  assert.equal(s.koPoint, null);
  assert.deepEqual(checkMove(s, 9, 9, 'white'), { legal: true });
});

test('FE-RULES-07 提多子不产生劫点', () => {
  // W(0,0)+W(0,1) 两子串被黑 (1,0)/(1,1)/(0,2) 包围提掉 → 恰提 2 子、无劫点
  const s = replayRulesPosition({
    size: 9,
    moves: [
      mv(1, 'white', 0, 0),
      mv(2, 'black', 1, 0),
      mv(3, 'white', 0, 1),
      mv(4, 'black', 1, 1),
      mv(5, 'white', 8, 8),
      mv(6, 'black', 0, 2), // 提 2 子 → 无劫点
    ],
  });
  assert.equal(s.grid[0][0], null);
  assert.equal(s.grid[1][0], null);
  assert.equal(s.koPoint, null);
});

test('FE-RULES-08 checkMove：越界与占点', () => {
  const s = replayRulesPosition({ size: 9, moves: [mv(1, 'black', 4, 4)] });
  assert.equal(checkMove(s, -1, 0, 'white').reason, ILLEGAL_REASON.OUT_OF_BOUNDS);
  assert.equal(checkMove(s, 9, 0, 'white').reason, ILLEGAL_REASON.OUT_OF_BOUNDS);
  assert.equal(checkMove(s, 4, 4, 'white').reason, ILLEGAL_REASON.OCCUPIED);
});

test('FE-RULES-09 checkMove：自杀禁入', () => {
  // W 四邻包围 (4,4)（9 路）：W(3,4)/(5,4)/(4,3)/(4,5)
  const s = replayRulesPosition({
    size: 9,
    moves: [mv(1, 'white', 3, 4), mv(2, 'white', 5, 4), mv(3, 'white', 4, 3), mv(4, 'white', 4, 5)],
  });
  const verdict = checkMove(s, 4, 4, 'black');
  assert.equal(verdict.legal, false);
  assert.equal(verdict.reason, ILLEGAL_REASON.SUICIDE);
});

test('FE-RULES-10 checkMove：提子解禁（非自杀）', () => {
  // 同上，但黑落 (4,4) 前先把 W(3,4) 打成单气 → 落点提子后合法
  const s = replayRulesPosition({
    size: 9,
    moves: [
      mv(1, 'white', 3, 4),
      mv(2, 'black', 2, 4),
      mv(3, 'white', 5, 4),
      mv(4, 'black', 3, 3),
      mv(5, 'white', 4, 3),
      mv(6, 'black', 3, 5),
      mv(7, 'white', 4, 5),
      // W(3,4) 仅剩一气 (4,4)；黑落 (4,4) 提 W(3,4)，自身仍连提后成气 → 合法
    ],
  });
  const verdict = checkMove(s, 4, 4, 'black');
  assert.equal(verdict.legal, true);
});

test('FE-RULES-11 探针只读：checkMove 不修改 state', () => {
  const s = replayRulesPosition({ size: 9, moves: [mv(1, 'black', 4, 4)] });
  const before = JSON.stringify(s);
  checkMove(s, 3, 3, 'white');
  checkMove(s, 4, 4, 'white');
  assert.equal(JSON.stringify(s), before);
});

test('FE-RULES-12 原因文案（对齐后端 GoRulesError）', () => {
  assert.equal(illegalMoveText(ILLEGAL_REASON.KO), '打劫（劫点禁入）');
  assert.equal(illegalMoveText(ILLEGAL_REASON.SUICIDE), '禁入点（自杀）');
  assert.equal(illegalMoveText(ILLEGAL_REASON.OCCUPIED), '该点已有棋子');
  assert.equal(illegalMoveText(ILLEGAL_REASON.OUT_OF_BOUNDS), '坐标越界');
  assert.equal(illegalMoveText('unknown'), '非法落子');
});

test('FE-RULES-13 checkMoveOnGame：由状态树 game 切片校验', () => {
  const game = {
    params: { boardSize: 9, handicap: 0 },
    moves: [mv(1, 'black', 4, 4)],
  };
  assert.equal(checkMoveOnGame(game, 3, 3, 'white').legal, true);
  assert.equal(checkMoveOnGame(game, 4, 4, 'white').reason, ILLEGAL_REASON.OCCUPIED);
});

test('FE-RULES-14 PASS 回放不改棋面', () => {
  const s = replayRulesPosition({
    size: 9,
    moves: [mv(1, 'black', 4, 4), { moveNo: 2, color: 'white', x: null, y: null, isPass: true }],
  });
  assert.equal(s.grid[4][4], 'black');
  assert.equal(s.grid.flat().filter(Boolean).length, 1);
});

test('FE-RULES-15 lastMoveCaptures：单子被提 = 1（吃子音效判定）', () => {
  // W(0,0) 被 B(1,0)+B(0,1) 提（末手 B(0,1)）
  const moves = [mv(1, 'white', 0, 0), mv(2, 'black', 1, 0), mv(3, 'white', 8, 8), mv(4, 'black', 0, 1)];
  assert.equal(lastMoveCaptures({ size: 9, moves }), 1);
  // 空谱 / PASS 末手 → 0
  assert.equal(lastMoveCaptures({ size: 9, moves: [] }), 0);
  assert.equal(lastMoveCaptures({ size: 9, moves: [...moves, { moveNo: 5, color: 'white', x: null, y: null, isPass: true }] }), 0);
  assert.equal(lastMoveCaptures({}), 0);
});

test('FE-RULES-16 lastMoveCaptures：未提子 = 0（含让子初始石）', () => {
  const moves = [mv(1, 'white', 4, 4), mv(2, 'black', 5, 5)];
  assert.equal(lastMoveCaptures({ size: 9, moves }), 0);
  // 让子局（黑初始石）末手提子仍按同一口径
  const h = [mv(1, 'white', 0, 0), mv(2, 'black', 1, 0), mv(3, 'white', 8, 8), mv(4, 'black', 0, 1)];
  assert.equal(lastMoveCaptures({ size: 9, handicap: 2, moves: h }), 1);
});

test('FE-RULES-17 lastMoveCaptures：提多子 / 末手未生效（异常存档）', () => {
  // W 两子 (0,0)(1,0) 被 B(0,1)+(2,0)+B(1,1) 提 → 提 2 子
  const multi = [
    mv(1, 'white', 0, 0), mv(2, 'white', 1, 0),
    mv(3, 'black', 2, 0), mv(4, 'white', 8, 8),
    mv(5, 'black', 0, 1), mv(6, 'white', 7, 8),
    mv(7, 'black', 1, 1), // 收气 → W(0,0)(1,0) 均无气，被提 2
  ];
  assert.equal(lastMoveCaptures({ size: 9, moves: multi }), 2);
  // 越界末手（异常存档）：落子未生效 → 0（不得按 +1 误报）
  assert.equal(lastMoveCaptures({ size: 9, moves: [...multi, mv(8, 'white', 99, 99)] }), 0);
});

test('FE-RULES-18 倒扑（snapback）：劫点回提多子合法（非打劫）', () => {
  const s = replayRulesPosition({ size: 9, moves: SNAPBACK_SEQ });
  assert.deepEqual(s.koPoint, { x: 1, y: 0 });
  assert.deepEqual(s.koStone, { x: 1, y: 1 });
  // B(1,1) 提 W(1,0) 后 B 六子串仅一气 (1,0)：W 回提提回六子 → 不复现前局面 → 合法
  assert.deepEqual(checkMove(s, 1, 0, 'white'), { legal: true });
  // 回提后：B 六子被提、无新劫点（提多子）
  const after = replayRulesPosition({ size: 9, moves: [...SNAPBACK_SEQ, mv(14, 'white', 1, 0)] });
  assert.equal(after.grid[0][0], null);
  assert.equal(after.grid[1][1], null);
  assert.equal(after.koPoint, null);
});
