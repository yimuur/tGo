/**
 * tGo · state.js 状态树 reducer 无头单测（T5.2，node --test）
 * 用例 ID: FE-STATE-*
 * 覆盖（TASK.md T5.2 验收）：move.applied 追加 / move.undone 截断 / curve 追加 /
 * ownership 替换 / engine.status 变更 / trial 分支隔离 / global 进度累计 +
 * game.state 权威重建（清曲线/清 positions/清 trial 但保留 engine/system）。
 *
 * 载荷形状对齐 backend（API.md §4.3/§4.4 实测）：
 *   game.state   { game_id, status, game:{...games 行}, moves:[...], next_color,
 *                  turn, analysis_complete, coverage:{done,total} }
 *   move.applied { move_no, color, x, y, is_pass, black_captures?, white_captures? }
 *   move.undone  { move_no:被撤末手, new_last_move_no, steps }
 *   analysis.curve { move_no, winrate, score_lead }
 *   position.ownership { position_key, move_no, ownership? }
 *   engine.status { state, progress? }
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createInitialState,
  reduce,
  mainKey,
  trialKey,
  ENGINE_LAUNCHABLE_STATES,
  ENGINE_QUERY_STATES,
  ENGINE_RUNNING_STATES,
  engineStateClass,
} from '../static/js/core/state.js';

test('FE-STATE-34 引擎状态分类：单一分类点（集合与后端 fsm.py 同值，FE-CTR-34 锁定镜像）', () => {
  assert.equal(engineStateClass('IDLE'), 'ready');
  assert.equal(engineStateClass('ANALYZING'), 'ready');
  assert.equal(engineStateClass('analyzing'), 'ready', '大小写不敏感');
  assert.equal(engineStateClass('INIT'), 'starting');
  assert.equal(engineStateClass('STOPPED'), 'stopped');
  assert.equal(engineStateClass('DEAD'), 'recovering');
  assert.equal(engineStateClass('FATAL'), 'fatal');
  assert.equal(engineStateClass(null), 'unknown');
  assert.equal(engineStateClass(''), 'unknown');
  assert.equal(engineStateClass('BOGUS'), 'stopped', '未知态按可启动处理（幂等语义）');
  assert.deepEqual([...ENGINE_RUNNING_STATES], ['INIT', 'IDLE', 'ANALYZING']);
  assert.deepEqual([...ENGINE_QUERY_STATES], ['IDLE', 'ANALYZING']);
  assert.deepEqual([...ENGINE_LAUNCHABLE_STATES], ['STOPPED', 'INIT']);
});

/* ---------- fixture 构建 ---------- */

function gameRow(overrides = {}) {
  return {
    mode: 'human_ai',
    board_size: 19,
    rules: 'chinese',
    komi: 7.5,
    handicap: 0,
    human_color: 'B',
    status: 'active',
    black_name: '张三',
    black_rank: 'rank_1d',
    white_name: 'AI',
    white_rank: null,
    ai_style: 'human',
    ai_level: 5,
    adaptive_enabled: 1,
    coaching_enabled: 1,
    favorite: 0,
    last_move_no: 4,
    undo_count: 1,
    black_captures: 2,
    white_captures: 0,
    result: null,
    ...overrides,
  };
}

function move(move_no, color, x, y, is_pass = false) {
  return { move_no, color, x, y, is_pass };
}

/** 生成 1..n 手主谱，与 gameRow.last_move_no 保持一致。 */
function autoMoves(n) {
  const arr = [];
  for (let i = 1; i <= n; i++) {
    arr.push(move(i, i % 2 ? 'B' : 'W', 3 + (i % 5), 3 + ((i * 2) % 5)));
  }
  return arr;
}

/** 构造一条服务端 game.state 消息。 */
function stateMsg(game, moves = autoMoves(game.last_move_no), overrides = {}) {
  return {
    type: 'game.state',
    data: {
      game_id: 7,
      status: game.status,
      game,
      moves,
      next_color: 'B',
      turn: 'TURN_HUMAN',
      analysis_complete: false,
      coverage: { done: 2, total: game.last_move_no + 1 },
      ...overrides,
    },
  };
}

function bootState(game = gameRow(), moves) {
  return reduce(createInitialState(), stateMsg(game, moves));
}

/* ---------- 用例 ---------- */

test('FE-STATE-01 初始状态：game/curve/positions/trial 空、engine/system 默认', () => {
  const s = createInitialState();
  assert.equal(s.game, null);
  assert.deepEqual(s.curve, { points: [] });
  assert.deepEqual(s.positions, {});
  assert.equal(s.trial, null);
  assert.deepEqual(s.coaching, { loading: false, topMoves: [], atMoveNo: null, side: null, baseWinrate: null });
  assert.deepEqual(s.comments, []); // 对弈点评保留最近 2 手
  assert.equal(s.prediction, null);
  assert.deepEqual(s.engine, { state: null, progress: null });
  assert.equal(s.system, null);
  assert.equal(s.adminTask, null);
  assert.deepEqual(s.deepAnalysis, { running: false, positionKey: null });
  assert.deepEqual(s.globalAnalysis, { running: false, done: 0, total: 0 });
});

test('FE-STATE-02 game.state 权威重建：参数/玩家/序列/提子/悔棋/覆盖', () => {
  const g = gameRow();
  const moves = [move(1, 'B', 3, 15), move(2, 'W', 15, 3), move(3, 'B', 3, 3), move(4, 'W', 15, 15)];
  const s = bootState(g, moves);

  assert.equal(s.game.gameId, 7);
  assert.equal(s.game.status, 'active');
  assert.deepEqual(s.game.params, {
    mode: 'human_ai', boardSize: 19, rules: 'chinese', komi: 7.5,
    handicap: 0, humanColor: 'B', aiStyle: 'human', aiLevel: 5,
    adaptiveEnabled: true, coachingEnabled: true, favorite: false,
  });
  assert.deepEqual(s.game.players, {
    black: { name: '张三', rank: 'rank_1d' },
    // 人机 AI 侧显示派生（2026/09/10）：名称 `AI` + 难度段位短标 + 风格标签
    white: { name: 'AI', rank: '5K', tag: '匹配' },
  });
  assert.equal(s.game.turn, 'TURN_HUMAN');
  assert.equal(s.game.nextColor, 'B');
  assert.deepEqual(s.game.captures, { black: 2, white: 0 });
  assert.equal(s.game.undoCount, 1);
  assert.equal(s.game.moves.length, 4);
  assert.equal(s.game.lastMoveNo, 4);
  assert.equal(s.game.analysisComplete, false);
  assert.deepEqual(s.game.coverage, { done: 2, total: 5 });
});

test('FE-STATE-03 move.applied 追加主谱并更新提子数', () => {
  let s = bootState();
  s = reduce(s, {
    type: 'move.applied',
    data: { move_no: 5, color: 'B', x: 9, y: 9, is_pass: false, black_captures: 3, white_captures: 1 },
  });
  assert.equal(s.game.moves.length, 5);
  const last = s.game.moves[s.game.moves.length - 1];
  assert.deepEqual(last, { moveNo: 5, color: 'B', x: 9, y: 9, isPass: false });
  assert.equal(s.game.lastMoveNo, 5);
  assert.deepEqual(s.game.captures, { black: 3, white: 1 });
});

test('FE-STATE-04 move.applied PASS（x/y null）追加、同手号去重替换', () => {
  let s = bootState();
  s = reduce(s, { type: 'move.applied', data: move(5, 'W', null, null, true) });
  assert.equal(s.game.lastMoveNo, 5);
  assert.ok(s.game.moves[4].isPass);
  assert.equal(s.game.moves[4].x, null);

  // 同 move_no 再次下发（重试/幂等）→ 替换不追加
  const before = s.game.moves.length;
  s = reduce(s, { type: 'move.applied', data: move(5, 'W', 10, 10, false) });
  assert.equal(s.game.moves.length, before);
  assert.equal(s.game.moves[4].x, 10);
});

test('FE-STATE-05 move.undone 按 new_last_move_no 截断序列/曲线/主谱缓存', () => {
  let s = bootState();
  // 预置 6 手
  for (let n = 5; n <= 6; n++) {
    s = reduce(s, { type: 'move.applied', data: move(n, n % 2 ? 'B' : 'W', n, n) });
  }
  assert.equal(s.game.lastMoveNo, 6);
  // 填两条曲线点 + 两个 main 缓存
  s = reduce(s, { type: 'analysis.curve', data: { move_no: 6, winrate: 60, score_lead: 4.2 } });
  s = reduce(s, { type: 'analysis.curve', data: { move_no: 5, winrate: 55, score_lead: 3.1 } });
  s = reduce(s, { type: 'position.ownership', data: { position_key: mainKey(6), move_no: 6, ownership: [0.5] } });
  s = reduce(s, { type: 'position.ownership', data: { position_key: mainKey(4), move_no: 4, ownership: [0.1] } });

  s = reduce(s, {
    type: 'move.undone',
    data: { move_no: 6, new_last_move_no: 4, steps: 2 },
  });
  assert.equal(s.game.lastMoveNo, 4);
  assert.equal(s.game.moves.length, 4);
  // 悔棋后曲线/主谱缓存只保留 ≤ new_last_move_no（第 5/6 手分析不再属于主谱）
  assert.deepEqual(s.curve.points, []);
  assert.ok(s.positions[mainKey(6)] === undefined);
  assert.ok(s.positions[mainKey(5)] === undefined);
  assert.ok(s.positions[mainKey(4)] !== undefined);
});

test('FE-STATE-06 game.finished 落结果与状态', () => {
  let s = bootState();
  s = reduce(s, {
    type: 'game.finished',
    data: { result: 'B+2.5', black_score: 184.5, white_score: 182 },
  });
  assert.equal(s.game.result, 'B+2.5');
  assert.equal(s.game.blackScore, 184.5);
  assert.equal(s.game.status, 'finished');
});

test('FE-STATE-07 analysis.curve 追加/同手号覆盖并保序', () => {
  let s = bootState();
  // 曲线点必须在权威末手范围内（FE-STATE-28 起的不变量）→ 先补齐 5/6 手
  s = reduce(s, { type: 'move.applied', data: move(5, 'B', 9, 9) });
  s = reduce(s, { type: 'move.applied', data: move(6, 'W', 9, 10) });
  s = reduce(s, { type: 'analysis.curve', data: { move_no: 4, winrate: 54.2, score_lead: 3.1 } });
  s = reduce(s, { type: 'analysis.curve', data: { move_no: 5, winrate: 60, score_lead: 5.5 } });
  s = reduce(s, { type: 'analysis.curve', data: { move_no: 5, winrate: 61.5, score_lead: 6 } }); // 覆盖
  assert.deepEqual(s.curve.points.map((p) => p.moveNo), [4, 5]);
  assert.equal(s.curve.points[1].winrate, 61.5);
  // 空值容忍（后端未算完可能推送 null）
  s = reduce(s, { type: 'analysis.curve', data: { move_no: 6, winrate: null, score_lead: null } });
  assert.equal(s.curve.points.length, 3);
  assert.equal(s.curve.points[2].winrate, null);
});

test('FE-STATE-28 analysis.curve 超限点丢弃：悔棋截断后迟到的旧点不得回流', () => {
  let s = bootState(); // last = 4
  s = reduce(s, { type: 'move.applied', data: move(5, 'B', 9, 9) });
  s = reduce(s, { type: 'move.applied', data: move(6, 'W', 9, 10) });
  s = reduce(s, { type: 'analysis.curve', data: { move_no: 6, winrate: 60, score_lead: 4 } });
  assert.deepEqual(s.curve.points.map((p) => p.moveNo), [6]);
  // 悔棋回到 #4：曲线截断
  s = reduce(s, { type: 'move.undone', data: { move_no: 6, new_last_move_no: 4, steps: 2 } });
  assert.deepEqual(s.curve.points, []);
  // 被撤局面的分析推送迟到（引擎回包/200ms 节流竞态）→ 不得回流进曲线
  s = reduce(s, { type: 'analysis.curve', data: { move_no: 6, winrate: 58, score_lead: 3.8 } });
  s = reduce(s, { type: 'analysis.curve', data: { move_no: 5, winrate: 55, score_lead: 2.5 } });
  assert.deepEqual(s.curve.points, []);
  // 权威范围内的点仍正常追加（含当前末手）
  s = reduce(s, { type: 'analysis.curve', data: { move_no: 4, winrate: 50, score_lead: 0.5 } });
  assert.deepEqual(s.curve.points.map((p) => p.moveNo), [4]);
});

test('FE-STATE-08 position.ownership 按键替换；缺数据置 null', () => {
  let s = bootState();
  const key = mainKey(2);
  s = reduce(s, { type: 'position.ownership', data: { position_key: key, move_no: 2, ownership: [0.9, -0.8] } });
  assert.deepEqual(s.positions[key].ownership, [0.9, -0.8]);
  // 再次推送（新数据替换旧数据）
  s = reduce(s, { type: 'position.ownership', data: { position_key: key, move_no: 2, ownership: [0.1] } });
  assert.deepEqual(s.positions[key].ownership, [0.1]);
  // ownership 缺省 → 表示无数据，占位 null（不残留旧值）
  s = reduce(s, { type: 'position.ownership', data: { position_key: key, move_no: 2 } });
  assert.equal(s.positions[key].ownership, null);
});

test('FE-STATE-09 engine.status 更新（含 progress）；engine 与 system 跨 game.state 保留', () => {
  let s = bootState();
  s = reduce(s, { type: 'engine.status', data: { state: 'ANALYZING', progress: 5 } });
  assert.deepEqual(s.engine, { state: 'ANALYZING', progress: 5 });
  s = reduce(s, { type: 'system.status', data: { host: 'tgo', os: 'win', memory_usage: 62, backend: 'opencl' } });
  // 再来一条 game.state（新对局/恢复），engine/system 属全局不应被清
  const s2 = reduce(s, stateMsg(gameRow({ last_move_no: 0 }), []));
  assert.equal(s2.engine.state, 'ANALYZING');
  assert.equal(s2.system.host, 'tgo');
});

test('FE-STATE-10 trial 分支隔离：trial.play/undo 不污染主谱', () => {
  let s = bootState(gameRow({ last_move_no: 4 }), [move(1, 'B', 3, 15), move(2, 'W', 15, 3), move(3, 'B', 3, 3), move(4, 'W', 15, 15)]);
  const mainBefore = s.game.moves.length;

  s = reduce(s, { type: 'trial.enter', data: { id: 't1', fromMoveNo: 4 } });
  assert.ok(s.trial);
  assert.equal(s.trial.fromMoveNo, 4);

  s = reduce(s, { type: 'trial.play', data: { x: 9, y: 9, isPass: false } });
  s = reduce(s, { type: 'trial.play', data: { x: 10, y: 10, isPass: false } });
  assert.equal(s.trial.moves.length, 2);

  // 试下撤销一步
  s = reduce(s, { type: 'trial.undo' });
  assert.equal(s.trial.moves.length, 1);

  // 主谱完全不受影响
  assert.equal(s.game.moves.length, mainBefore);
  assert.equal(s.game.lastMoveNo, 4);

  // 退出后主谱仍在
  s = reduce(s, { type: 'trial.exit' });
  assert.equal(s.trial, null);
  assert.equal(s.game.moves.length, mainBefore);
});

test('FE-STATE-11 global 进度累计：progress 推进、done 停止', () => {
  let s = bootState();
  s = reduce(s, { type: 'analysis.progress', data: { kind: 'global', done: 3, total: 10 } });
  assert.equal(s.globalAnalysis.running, true);
  assert.deepEqual([s.globalAnalysis.done, s.globalAnalysis.total], [3, 10]);

  s = reduce(s, { type: 'analysis.progress', data: { kind: 'global', done: 7, total: 10 } });
  assert.deepEqual([s.globalAnalysis.done, s.globalAnalysis.total], [7, 10]);

  s = reduce(s, { type: 'global_analysis.done', data: { done: 10, total: 10 } });
  assert.equal(s.globalAnalysis.running, false);
  assert.deepEqual([s.globalAnalysis.done, s.globalAnalysis.total], [10, 10]);
});

test('FE-STATE-32 global.reset：复位全局分析进行态（M-14；进度/完成值保留）', () => {
  let s = bootState();
  s = reduce(s, { type: 'analysis.progress', data: { kind: 'global', done: 4, total: 10 } });
  assert.equal(s.globalAnalysis.running, true);
  // 复位 = 终止进行态（停按钮呼吸）；保留已推进的进度值
  s = reduce(s, { type: 'global.reset' });
  assert.deepEqual(s.globalAnalysis, { running: false, done: 4, total: 10 });
  // 幂等：重复复位无副作用
  assert.deepEqual(reduce(s, { type: 'global.reset' }).globalAnalysis, { running: false, done: 4, total: 10 });
  // 完成消息仍可携带最终进度（复位不阻断完成语义）
  s = reduce(s, { type: 'global_analysis.done', data: { done: 10, total: 10 } });
  assert.deepEqual(s.globalAnalysis, { running: false, done: 10, total: 10 });
});

test('FE-STATE-12 deep_analysis.result / coaching.top5 写入对应切片', () => {
  let s = bootState();
  const key = mainKey(2);
  s = reduce(s, {
    type: 'deep_analysis.result',
    data: { position_key: key, result: { winrate: 70, moves: [{ x: 3, y: 3 }] } },
  });
  assert.equal(s.deepAnalysis.running, false);
  assert.deepEqual(s.positions[key].result, { winrate: 70, moves: [{ x: 3, y: 3 }] });

  s = reduce(s, { type: 'coaching.pending', data: {} });
  assert.equal(s.coaching.loading, true);
  s = reduce(s, {
    type: 'coaching.top5',
    data: { moves: [{ x: 3, y: 3, winrate: 55 }, { x: 15, y: 15, winrate: 44 }] },
  });
  assert.equal(s.coaching.loading, false);
  assert.equal(s.coaching.topMoves.length, 2);
});

test('FE-STATE-29 coaching.reset：引擎类错误复位支招进行态（停止呼吸/可重试；2026/09/13）', () => {
  let s = bootState();
  s = reduce(s, { type: 'coaching.pending', data: { move_no: 4 } });
  assert.equal(s.coaching.loading, true);
  assert.equal(s.coaching.atMoveNo, 4);
  // 复位：清空进行态与候选（停止呼吸；卡片回退可重试/降级提示）
  s = reduce(s, { type: 'coaching.reset' });
  assert.deepEqual(s.coaching, { loading: false, topMoves: [], atMoveNo: null, side: null, baseWinrate: null });
});

test('FE-STATE-31 deep.reset：复位深算进行态但不携带结果（BUG-091 误报「深度分析完成」根因）', () => {
  let s = bootState();
  const key = mainKey(3);
  s = reduce(s, { type: 'deep.pending', data: { positionKey: key } });
  assert.deepEqual(s.deepAnalysis, { running: true, positionKey: key });
  // 复位 = 终止进行态（停止按钮呼吸）；不得写 positions[key].result
  s = reduce(s, { type: 'deep.reset' });
  assert.deepEqual(s.deepAnalysis, { running: false, positionKey: null });
  assert.equal(s.positions[key], undefined);
  // 幂等：重复复位（已复位）无副作用
  assert.deepEqual(reduce(s, { type: 'deep.reset' }).deepAnalysis, { running: false, positionKey: null });
  // 旧路径兜底语义保留：空载荷 deep_analysis.result 仍为复位（无结果写入）
  s = reduce(reduce(s, { type: 'deep.pending', data: {} }), { type: 'deep_analysis.result', data: {} });
  assert.deepEqual(s.deepAnalysis, { running: false, positionKey: null });
});

test('FE-STATE-13 game.state 同会话重放：trial 重置、缓存按权威 last_move_no 收敛', () => {
  // T6.5 修订：服务端每手广播 game.state；同一对局会话内曲线/领地缓存**保留**
  // （按权威 last_move_no 裁剪），避免实时曲线随每手重置为单点。
  let s = bootState(gameRow({ last_move_no: 2 }), [move(1, 'B', 3, 15), move(2, 'W', 15, 3)]);
  s = reduce(s, { type: 'trial.enter', data: { id: 't9', fromMoveNo: 2 } });
  s = reduce(s, { type: 'trial.play', data: { x: 9, y: 9 } });
  s = reduce(s, { type: 'analysis.curve', data: { move_no: 2, winrate: 50, score_lead: 0 } });
  s = reduce(s, { type: 'analysis.curve', data: { move_no: 1, winrate: 55, score_lead: 1 } });
  s = reduce(s, { type: 'position.ownership', data: { position_key: mainKey(2), move_no: 2, ownership: [1] } });

  const after = reduce(s, stateMsg(gameRow({ last_move_no: 2 }), [move(1, 'B', 3, 15), move(2, 'W', 15, 3)]));
  assert.equal(after.trial, null); // 试下会话仍重置
  assert.deepEqual(
    after.curve.points.map((p) => p.moveNo),
    [1, 2],
  ); // 同会话曲线保留
  assert.ok(after.positions[mainKey(2)] !== undefined);
  assert.equal(after.game.moves.length, 2);

  // 悔棋/回退后的 game.state（last_move_no=1）：缓存裁剪至权威上限
  const rewind = reduce(
    after,
    stateMsg(gameRow({ last_move_no: 1 }), [move(1, 'B', 3, 15)]),
  );
  assert.deepEqual(rewind.curve.points.map((p) => p.moveNo), [1]);
  assert.ok(rewind.positions[mainKey(2)] === undefined);
});

test('FE-STATE-22 game.state 跨对局/首次连接：曲线/positions 整清', () => {
  // 切换对局（gameId 变化）或此前无对局（首次连接）→ 分析缓存视为过期整清
  // （复盘/恢复场景：等待 REST 回填或实时补齐）。
  let s = bootState(gameRow({ last_move_no: 4 })); // gameId=7
  s = reduce(s, { type: 'analysis.curve', data: { move_no: 4, winrate: 50, score_lead: 0 } });
  s = reduce(s, { type: 'position.ownership', data: { position_key: mainKey(4), move_no: 4, ownership: [1] } });
  // 新对局 gameId=9
  const otherGame = gameRow({ last_move_no: 2 });
  const other = reduce(
    s,
    {
      type: 'game.state',
      data: {
        game_id: 9,
        status: 'active',
        game: { ...otherGame, id: 9 },
        moves: [move(1, 'B', 3, 15), move(2, 'W', 15, 3)],
        next_color: 'B',
      },
    },
  );
  assert.equal(other.game.gameId, 9);
  assert.deepEqual(other.curve.points, []);
  assert.deepEqual(other.positions, {});
});

test('FE-STATE-14 未知消息类型返回原引用（不触发通知）', () => {
  const s = bootState();
  const next = reduce(s, { type: 'whatever.new', data: {} });
  assert.equal(next, s);
});

test('FE-STATE-15 position key 辅助函数', () => {
  assert.equal(mainKey(0), 'main:0');
  assert.equal(trialKey('t1', 0), 'trial:t1:0');
  assert.equal(trialKey('t1', 3), 'trial:t1:3');
});

test('FE-STATE-16 game.state 白名单载荷（无内部字段）可完整解析', () => {
  // T6.1：服务端 GameInfo 白名单不再下发 parent_game_id/*_player_id 等内部字段，
  // 前端解析只依赖公开字段（undo_count/提子数/难度等仍在）。
  const g = gameRow({
    adaptive_enabled: 0, coaching_enabled: 0, favorite: 1,
    undo_count: 2, black_captures: 3, white_captures: 1, ai_level: 12,
  });
  // 模拟服务端白名单输出：剔除内部列不影响解析
  const publicGame = (({ id, ...rest }) => rest)(g);
  const s = bootState(publicGame, []);
  assert.equal(s.game.status, 'active');
  assert.equal(s.game.params.aiLevel, 12);
  assert.equal(s.game.params.adaptiveEnabled, false);
  assert.equal(s.game.params.favorite, true);
  assert.deepEqual(s.game.captures, { black: 3, white: 1 });
  assert.equal(s.game.undoCount, 2);
});

test('FE-STATE-17 analysis.curve 百分比载荷（ISSUE-050 输出）原样存储', () => {
  // T6.1：曲线 winrate 为黑方视角百分比（×100），前端状态层不换算、原样存储
  let s = bootState();
  s = reduce(s, { type: 'analysis.curve', data: { move_no: 1, winrate: 54.2, score_lead: 3.5 } });
  s = reduce(s, { type: 'analysis.curve', data: { move_no: 2, winrate: 12.34, score_lead: -8 } });
  assert.deepEqual(
    s.curve.points.map((p) => [p.moveNo, p.winrate, p.scoreLead]),
    [[1, 54.2, 3.5], [2, 12.34, -8]],
  );
});

test('FE-STATE-18 engine.status progress=null 保持 null（不 Number(null)→0）', () => {
  // T6.2 回归：INIT 无 benchmark / benchmark 结束均下发 progress:null，
  // 若被 Number(null) 强转 0 会误判为“GPU 调优 0%”。
  let s = bootState();
  s = reduce(s, { type: 'engine.status', data: { state: 'INIT', progress: null } });
  assert.equal(s.engine.state, 'INIT');
  assert.equal(s.engine.progress, null);
  s = reduce(s, { type: 'engine.status', data: { state: 'IDLE' } });
  assert.equal(s.engine.progress, null);
  // 真实进度仍为数字
  s = reduce(s, { type: 'engine.status', data: { state: 'INIT', progress: 33 } });
  assert.equal(s.engine.progress, 33);
  assert.equal(typeof s.engine.progress, 'number');
});

test('FE-STATE-23 engine.status humanModelAvailable（可选字段）：携带即更新，缺失保留', () => {
  // API §4.4：engine.status 可选携带 humanModelAvailable（B2 人类模型不可用提示）
  let s = bootState();
  s = reduce(s, { type: 'engine.status', data: { state: 'IDLE', progress: null, humanModelAvailable: false } });
  assert.equal(s.engine.humanModelAvailable, false);
  // 后续增量广播（未携带）→ 保留既有值，不被清除
  s = reduce(s, { type: 'engine.status', data: { state: 'ANALYZING' } });
  assert.equal(s.engine.state, 'ANALYZING');
  assert.equal(s.engine.humanModelAvailable, false);
  // 人类模型恢复（引擎重建）→ 更新为 true
  s = reduce(s, { type: 'engine.status', data: { state: 'IDLE', humanModelAvailable: true } });
  assert.equal(s.engine.humanModelAvailable, true);
  // 初始未收到该字段 → 不引入键（未知语义：由服务端最终阻断）
  const fresh = reduce(bootState(), { type: 'engine.status', data: { state: 'IDLE' } });
  assert.equal('humanModelAvailable' in fresh.engine, false);
});

test('FE-STATE-30 engine.status reason（可选字段）：携带即更新、显式 null 清除、缺失保留', () => {
  // API §3.3：/admin/engines 无引擎管理器（标准模型缺失）时携带 reason；
  // 「连续崩溃 FATAL」与「标准模型缺失 FATAL」靠该字段区分（BUG-090）
  let s = reduce(bootState(), {
    type: 'engine.status',
    data: { state: 'FATAL', progress: null, reason: 'standard_model_missing' },
  });
  assert.equal(s.engine.reason, 'standard_model_missing');
  // 增量广播（字段缺失）→ 保留既有值
  s = reduce(s, { type: 'engine.status', data: { state: 'FATAL', progress: null } });
  assert.equal(s.engine.reason, 'standard_model_missing');
  // REST 快照显式 null（引擎管理器在）→ 清除旧值（否则崩溃 FATAL 会被误呈现为缺模型）
  s = reduce(s, { type: 'engine.status', data: { state: 'FATAL', progress: null, reason: null } });
  assert.equal(s.engine.reason, null);
  // 初始未收到该字段 → 不引入键
  const fresh = reduce(bootState(), { type: 'engine.status', data: { state: 'IDLE' } });
  assert.equal('reason' in fresh.engine, false);
});

test('FE-STATE-31 engine.status detail（可选字段，BUG-097）：携带即更新、显式 null 清除、缺失保留', () => {
  // API §3.3：启动失败/装配归因的说明（stderr 摘要等）随 reason 一并下发
  let s = reduce(bootState(), {
    type: 'engine.status',
    data: {
      state: 'DEAD',
      progress: null,
      reason: 'startup_failed',
      detail: 'Uncaught exception: No OpenCL devices were found',
    },
  });
  assert.equal(s.engine.detail, 'Uncaught exception: No OpenCL devices were found');
  // 增量广播（字段缺失）→ 保留既有值
  s = reduce(s, { type: 'engine.status', data: { state: 'DEAD', progress: null } });
  assert.equal(s.engine.detail, 'Uncaught exception: No OpenCL devices were found');
  // 显式 null（恢复/无原因）→ 清除旧值
  s = reduce(s, {
    type: 'engine.status',
    data: { state: 'IDLE', progress: null, reason: null, detail: null },
  });
  assert.equal(s.engine.reason, null);
  assert.equal(s.engine.detail, null);
  // 初始未收到该字段 → 不引入键
  const fresh = reduce(bootState(), { type: 'engine.status', data: { state: 'IDLE' } });
  assert.equal('detail' in fresh.engine, false);
});

test('FE-STATE-19 move.applied 清空支招结果（T6.5：防旧局面 TOP5 残留）', () => {
  let s = bootState();
  // 发起支招请求（记录目标手数）并收到结果（含 side/base，2026/09/11）
  s = reduce(s, { type: 'coaching.pending', data: { move_no: 5 } });
  assert.equal(s.coaching.loading, true);
  assert.equal(s.coaching.atMoveNo, 5);
  s = reduce(s, {
    type: 'coaching.top5',
    data: {
      move_no: 5,
      side: 'W',
      base_winrate: 41.5,
      moves: [{ x: 3, y: 3, winrate: 60, score_lead: 2, visits: 400, pv: [] }],
    },
  });
  assert.equal(s.coaching.loading, false);
  assert.equal(s.coaching.topMoves.length, 1);
  assert.equal(s.coaching.atMoveNo, 5);
  assert.equal(s.coaching.side, 'W');
  assert.equal(s.coaching.baseWinrate, 41.5);
  // 下一手落子 → 旧推荐清空（atMoveNo/side/base 归 null）
  s = reduce(s, { type: 'move.applied', data: move(6, 'B', 9, 9, false) });
  assert.deepEqual(s.coaching, {
    loading: false, topMoves: [], atMoveNo: null, side: null, baseWinrate: null,
  });
});

test('FE-STATE-20 move.undone 清空支招结果（同 T6.5 过期语义）', () => {
  let s = bootState(); // last_move_no=4
  s = reduce(s, { type: 'coaching.pending', data: { move_no: 4 } });
  s = reduce(s, {
    type: 'coaching.top5',
    data: { moves: [{ x: 3, y: 3, winrate: 60, score_lead: 2, visits: 400, pv: [] }] },
  });
  assert.equal(s.coaching.topMoves.length, 1);
  s = reduce(s, { type: 'move.undone', data: { move_no: 4, new_last_move_no: 3, steps: 1 } });
  assert.deepEqual(s.coaching, {
    loading: false, topMoves: [], atMoveNo: null, side: null, baseWinrate: null,
  });
});

test('FE-STATE-20b analysis.comment → 最近 2 手点评切片（每手标准分析派送）', () => {
  // 夹具对齐 H-6 不变量：点评手数必须 ≤ 权威末手（生产链路中点评必然晚于 game.state 到达）
  let s = bootState(gameRow({ last_move_no: 6 }), autoMoves(6));
  s = reduce(s, {
    type: 'analysis.comment',
    data: {
      move_no: 4, color: 'W', x: 15, y: 15, grade: 'mistake',
      delta_winrate: -9.2, score_delta: -2.8,
    },
  });
  assert.deepEqual(s.comments, [{
    moveNo: 4, color: 'W', x: 15, y: 15, grade: 'mistake',
    deltaWinrate: -9.2, scoreDelta: -2.8,
  }]);
  // 第 5 手 → 保留最近 2 手（旧→新）
  s = reduce(s, {
    type: 'analysis.comment',
    data: { move_no: 5, color: 'B', x: 3, y: 3, grade: 'good', delta_winrate: 1.0, score_delta: -0.5 },
  });
  assert.deepEqual(s.comments.map((c) => c.moveNo), [4, 5]);
  // 第 6 手 → 裁掉第 4 手（仅保留最近 2 手）
  s = reduce(s, {
    type: 'analysis.comment',
    data: { move_no: 6, color: 'W', x: 17, y: 2, grade: 'brilliant', delta_winrate: 4.0, score_delta: 0.8 },
  });
  assert.deepEqual(s.comments.map((c) => c.moveNo), [5, 6]);
  // 同手重复推送 → 幂等 upsert（不重复、值更新）
  s = reduce(s, {
    type: 'analysis.comment',
    data: { move_no: 6, color: 'W', x: 17, y: 2, grade: 'good', delta_winrate: 0.2, score_delta: -0.2 },
  });
  assert.deepEqual(s.comments.map((c) => c.moveNo), [5, 6]);
  assert.equal(s.comments.at(-1).grade, 'good');
  // 缺 move_no 的异常载荷 → 忽略（保持原值）
  s = reduce(s, { type: 'analysis.comment', data: { grade: 'mistake' } });
  assert.equal(s.comments.length, 2);
  // 回落（悔棋）：超出新末手的点评移除，其余保留
  s = reduce(s, { type: 'move.undone', data: { move_no: 6, new_last_move_no: 5, steps: 1 } });
  assert.deepEqual(s.comments.map((c) => c.moveNo), [5]);
  // game.state 权威收敛：末手 4 → 第 5 手点评清除
  const next = { ...gameRow({ last_move_no: 4 }), status: 'active' };
  s = reduce(s, stateMsg(next, autoMoves(4)));
  assert.deepEqual(s.comments, []);
});

test('FE-STATE-33 analysis.comment 迟到守卫（H-6）：超过权威末手的点评丢弃', () => {
  let s = bootState(); // 末手 4
  // 悔棋截断后，后端点评重试（~3.2s 窗口）仍可能推送被撤手数 → 照单全收会让圆点/气泡复活
  s = reduce(s, {
    type: 'analysis.comment',
    data: { move_no: 5, color: 'B', x: 3, y: 3, grade: 'good' },
  });
  assert.deepEqual(s.comments, []);
  // 界内推送照常写入
  s = reduce(s, {
    type: 'analysis.comment',
    data: { move_no: 4, color: 'W', x: 15, y: 15, grade: 'mistake' },
  });
  assert.deepEqual(s.comments.map((c) => c.moveNo), [4]);
  // 未装载对局（game=null）不设限（与 applyCurve 同口径）
  const empty = reduce(createInitialState(), {
    type: 'analysis.comment',
    data: { move_no: 9, grade: 'good' },
  });
  assert.deepEqual(empty.comments.map((c) => c.moveNo), [9]);
});

test('FE-STATE-20c scoring.prediction → 结算预判切片（双 PASS / 认输）', () => {
  let s = bootState();
  s = reduce(s, {
    type: 'scoring.prediction',
    data: {
      game_id: 7, move_no: 4, engine: true, finished: true,
      dead_points: [[3, 3], [4, 4]], result: 'B+3.5',
      black_score: 40, white_score: 36.5, lead: 3.5,
    },
  });
  assert.equal(s.prediction.engine, true);
  assert.equal(s.prediction.result, 'B+3.5');
  assert.deepEqual(s.prediction.deadPoints, [{ x: 3, y: 3 }, { x: 4, y: 4 }]);
  // 引擎不可用降级载荷
  s = reduce(s, {
    type: 'scoring.prediction',
    data: { game_id: 7, move_no: 4, engine: false, reason: 'engine_unavailable', dead_points: [] },
  });
  assert.equal(s.prediction.engine, false);
  assert.equal(s.prediction.reason, 'engine_unavailable');
});

test('FE-STATE-24 WS 快照无 analyses_count → 回退 coverage.done（复盘信息卡 0/N 修复，BUG-027）', () => {
  const g = gameRow({ last_move_no: 3 });
  // WS 连接即推送快照：无 moves_count/analyses_count，仅 coverage
  let s = reduce(createInitialState(), stateMsg(g, autoMoves(3), { coverage: { done: 4, total: 4 } }));
  assert.equal(s.game.analysesCount, 4);
  assert.equal(s.game.movesCount, 3);
  // REST 详情：显式 analyses_count 优先
  s = reduce(s, stateMsg(g, autoMoves(3), { moves_count: 3, analyses_count: 2, coverage: { done: 4, total: 4 } }));
  assert.equal(s.game.analysesCount, 2);
  // 两者均缺 → 0
  s = reduce(s, stateMsg(g, autoMoves(3), { coverage: null }));
  assert.equal(s.game.analysesCount, 0);
});

test('FE-STATE-20d review.recommend 归一：side（当前执色方视角）写入切片（BUG-027）', () => {
  let s = bootState();
  s = reduce(s, {
    type: 'review.recommend',
    data: {
      position_key: 'main:3', side: 'W', has_data: true,
      moves: [{ x: 3, y: 3 }], comment: null, root: null,
    },
  });
  assert.equal(s.review.side, 'W');
  assert.equal(s.review.key, 'main:3');
  // 旧载荷（无 side / 非法值）→ null（不回退为黑，防错标视角）
  s = reduce(s, {
    type: 'review.recommend',
    data: { position_key: 'main:5', has_data: false, moves: [] },
  });
  assert.equal(s.review.side, null);
});

test('FE-STATE-21 curve.set 批量回填：REST snake_case 归一 + 排序去非法（T6.5）', () => {
  let s = bootState();
  // REST GET /games/{id}/curve 返回 [{move_no, winrate, score_lead}]
  s = reduce(s, {
    type: 'curve.set',
    data: { points: [
      { move_no: 3, winrate: 60.5, score_lead: 4 },
      { move_no: 1, winrate: 52, score_lead: -1 },
      { move_no: 2, winrate: null, score_lead: null },
      { move_no: 'x', winrate: 10, score_lead: 0 }, // 非法剔除
    ] },
  });
  assert.deepEqual(
    s.curve.points.map((p) => [p.moveNo, p.winrate, p.scoreLead]),
    [[1, 52, -1], [2, null, null], [3, 60.5, 4]],
  );
});

test('FE-STATE-25 trial.truncate 镜像截断：清该分支 rel > 界 的 positions（领地/深算缓存）', () => {
  let s = createInitialState();
  s = reduce(s, { type: 'position.ownership', data: { position_key: 'trial:7:1', move_no: 1, ownership: [1] } });
  s = reduce(s, { type: 'position.ownership', data: { position_key: 'trial:7:3', move_no: 3, ownership: [3] } });
  s = reduce(s, { type: 'position.ownership', data: { position_key: 'trial:8:3', move_no: 3, ownership: [8] } });
  s = reduce(s, { type: 'position.ownership', data: { position_key: 'main:5', move_no: 5, ownership: [5] } });
  s = reduce(s, { type: 'trial.truncate', data: { trialId: 7, rel: 1 } });
  assert.ok(s.positions['trial:7:1'], '≤rel 保留');
  assert.equal(s.positions['trial:7:3'], undefined, '>rel 清除');
  assert.ok(s.positions['trial:8:3'], '其它分支不受影响');
  assert.ok(s.positions['main:5'], '主谱不受影响');
});

test('FE-STATE-26 trial.truncate 同步失效 review：越界 key 的 root 清空（防陈旧曲线值二次生长）', () => {
  const payload = (key, winrate) => ({
    type: 'review.recommend',
    data: {
      position_key: key,
      moves: [{ x: 3, y: 3, winrate }],
      variations: [],
      comment: { grade: 'good' },
      root: { winrate, score_lead: 1 },
      side: 'W',
      has_data: true,
    },
  });
  // 越界 key（rel 3 > 截断界 1）→ 失效
  let s = reduce(createInitialState(), payload('trial:7:3', 90));
  s = reduce(s, { type: 'trial.truncate', data: { trialId: 7, rel: 1 } });
  assert.equal(s.review.key, 'trial:7:3', 'key 保留（同 key 复用前不误导当前局面）');
  assert.equal(s.review.root, null, 'root 清空 → 曲线点不落图');
  assert.deepEqual(s.review.moves, []);
  assert.equal(s.review.comment, null);
  assert.equal(s.review.hasData, false);
  assert.equal(s.review.loading, false);

  // 边界 rel == 截断界 → 保留（该手仍在分支内）
  let keep = reduce(createInitialState(), payload('trial:7:1', 40));
  keep = reduce(keep, { type: 'trial.truncate', data: { trialId: 7, rel: 1 } });
  assert.deepEqual(keep.review.root, { winrate: 40, score_lead: 1 });

  // 其它分支 / 主谱 key → 不受影响
  let other = reduce(createInitialState(), payload('trial:8:3', 55));
  other = reduce(other, { type: 'trial.truncate', data: { trialId: 7, rel: 1 } });
  assert.deepEqual(other.review.root, { winrate: 55, score_lead: 1 });
  let main = reduce(createInitialState(), payload('main:3', 61));
  main = reduce(main, { type: 'trial.truncate', data: { trialId: 7, rel: 1 } });
  assert.deepEqual(main.review.root, { winrate: 61, score_lead: 1 });
});

test('FE-STATE-27 review.pending：同 key 保留旧载荷，key 变化必须清空（防陈旧 root 画出错值）', () => {
  const payload = (key, winrate, side) => ({
    type: 'review.recommend',
    data: {
      position_key: key,
      moves: [{ x: 3, y: 3, winrate }],
      variations: [{ pv: ['D4'] }],
      comment: { grade: 'good' },
      root: { winrate, score_lead: 4 },
      side,
      has_data: true,
    },
  });
  // 同 key 重拉（深算完成）→ 保留旧载荷，仅 loading
  let same = reduce(createInitialState(), payload('trial:7:2', 88, 'W'));
  same = reduce(same, { type: 'review.pending', data: { key: 'trial:7:2' } });
  assert.equal(same.review.loading, true);
  assert.deepEqual(same.review.root, { winrate: 88, score_lead: 4 }, '同 key 保留（卡片不闪空）');
  assert.equal(same.review.side, 'W');
  assert.equal(same.review.hasData, false);

  // key 变化（试下落子到新局面）→ root/moves/comment/side 全清（否则被曲线点派生当有效值）
  let moved = reduce(createInitialState(), payload('trial:7:1', 99.9, 'W'));
  moved = reduce(moved, { type: 'review.pending', data: { key: 'trial:7:2' } });
  assert.equal(moved.review.key, 'trial:7:2');
  assert.equal(moved.review.loading, true);
  assert.equal(moved.review.root, null, '新局面无数据 → 曲线点不落图');
  assert.deepEqual(moved.review.moves, []);
  assert.deepEqual(moved.review.variations, []);
  assert.equal(moved.review.comment, null);
  assert.equal(moved.review.side, null);
  assert.equal(moved.review.hasData, false);

  // 无 key（缺省沿用当前键）→ 视为同 key 保留
  let noKey = reduce(createInitialState(), payload('main:5', 30, 'B'));
  noKey = reduce(noKey, { type: 'review.pending', data: {} });
  assert.equal(noKey.review.key, 'main:5');
  assert.deepEqual(noKey.review.root, { winrate: 30, score_lead: 4 });
});

test('FE-STATE-32 game.state.ai_pending（可选字段，R2）：携带即映射、缺失/旧服务端为 null', () => {
  const g = gameRow();
  // 旧服务端（无字段）→ null（不阻断，前端按「思考中」呈现）
  assert.equal(bootState(g).game.aiPending, null);
  assert.equal(
    reduce(createInitialState(), stateMsg(g, undefined, { ai_pending: null })).game.aiPending,
    null,
  );
  // 携带原因 → {code, message} 原样映射（胶囊文案/title 消费）
  const s = reduce(createInitialState(), stateMsg(g, undefined, {
    ai_pending: { code: 'ENGINE_BUSY', message: 'AI 落子引擎查询失败: 查询超时' },
  }));
  assert.deepEqual(s.game.aiPending, {
    code: 'ENGINE_BUSY',
    message: 'AI 落子引擎查询失败: 查询超时',
  });
  // 后续权威 game.state（应手成功）→ 字段回落 null
  const s2 = reduce(s, stateMsg(g, undefined, { ai_pending: null }));
  assert.equal(s2.game.aiPending, null);
});
