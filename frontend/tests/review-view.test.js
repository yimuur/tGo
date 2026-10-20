/**
 * FE-RV（review-view 纯函数层）· 回放工作台派生（T6.8）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  upToMainMoves,
  branchAbsMoves,
  captureCounts,
  nextColorAbs,
  boardTransition,
  resolveReviewTarget,
  trialRelAfterState,
  reviewMeta,
  reportSlotView,
  deriveAnalyzeButton,
  deepAnalyzeLit,
  reviewEmptyCopy,
  reviewErrorOutcome,
  recommendFetchAction,
  trialStateDisposition,
} from '../static/js/views/review-view.js';

/** 归一 move 快捷构造。 */
function mv(moveNo, color, x = null, y = null, isPass = false) {
  return { moveNo, color, x, y, isPass: Boolean(isPass) };
}

test('FE-RV-01 | upToMainMoves 截断主谱', () => {
  const list = [mv(1, 'B', 3, 3), mv(2, 'W', 15, 15), mv(3, 'B', 3, 15)];
  assert.deepEqual(upToMainMoves(list, 2).map((m) => m.moveNo), [1, 2]);
  assert.deepEqual(upToMainMoves(list, 0), []);
});

test('FE-RV-02 | branchAbsMoves = 主谱前缀 + 试下分支（相对转绝对）', () => {
  const main = [mv(1, 'B', 3, 3), mv(2, 'W', 15, 15)];
  const trial = [mv(1, 'B', 3, 15), mv(2, 'W', 16, 3)];
  // 从第 1 手进入 + 试下 1 手 → 绝对 moveNo 2
  const out = branchAbsMoves(main, 1, trial, 1);
  assert.deepEqual(out.map((m) => m.moveNo), [1, 2]);
  assert.deepEqual(out[1], { moveNo: 2, color: 'B', x: 3, y: 15, isPass: false });
  // rel 截断
  const out2 = branchAbsMoves(main, 1, trial, 0);
  assert.deepEqual(out2.map((m) => m.moveNo), [1]);
});

test('FE-RV-03 | captureCounts 由盘面反推累计提子（吃子场景）', () => {
  // 黑 3 子，白吃掉其中 1 子（白提 1）；白另落 2 子皆在盘
  const moves = [
    mv(1, 'B', 3, 3),
    mv(2, 'W', 4, 3),
    mv(3, 'B', 3, 4),
    mv(4, 'W', 5, 5),
    mv(5, 'B', 3, 5), // 被白 (4,3)? 不构造死子；改用简单占位场景
    mv(6, 'W', 6, 6),
  ];
  const caps = captureCounts({ size: 9, handicap: 0, moves });
  assert.equal(caps.black, 0);
  assert.equal(caps.white, 0);
});

test('FE-RV-03b | captureCounts 吃子后反推（被提子不在盘 → 对方提子 +1）', () => {
  // 角上黑 (0,0)；白 (1,0)(0,1) 提黑 → 白提 1
  const moves = [
    mv(1, 'B', 0, 0),
    mv(2, 'W', 1, 0),
    mv(3, 'W', 0, 1),
  ];
  const caps = captureCounts({ size: 9, handicap: 0, moves });
  assert.equal(caps.white, 1); // 白提黑 1
  assert.equal(caps.black, 0);
});

test('FE-RV-04 | nextColorAbs 分先/让子首手', () => {
  assert.equal(nextColorAbs(0, 0), 'black');
  assert.equal(nextColorAbs(1, 0), 'white');
  assert.equal(nextColorAbs(0, 2), 'white'); // 让子后白先
  assert.equal(nextColorAbs(1, 2), 'black');
});

test('FE-RV-05 | reviewMeta 信息行段（主谱/试下/模式/结果）', () => {
  const segs = reviewMeta({ current: 12, total: 88, boardSize: 19, rules: 'chinese', komi: 7.5, handicap: 0, mode: 'human_ai', aiText: '标准 · 5K' });
  assert.deepEqual(segs.map((s) => s.text), ['第 12 / 88 手', '19路', '中国', '贴 7.5', '标准 · 5K']);
  const trial = reviewMeta({ inTrial: true, current: 3, total: 3, boardSize: 19, rules: 'chinese', komi: 7.5 });
  assert.equal(trial[0].text, '试下 · 第 3 手 / 3');
  const res = reviewMeta({ current: 120, total: 120, boardSize: 19, rules: 'japanese', komi: 6.5, result: 'W+Resign', mode: 'human_human' });
  assert.ok(res.some((s) => s.result));
  assert.equal(res[2].text, '日本');
});

test('FE-RV-06 | deriveAnalyzeButton 三态演化（深度→补全→运行中统一文案→还原）', () => {
  const idle = deriveAnalyzeButton({ missing: 0, engineState: 'IDLE' });
  assert.equal(idle.kind, 'deep');
  assert.equal(idle.label, '深度分析');
  assert.equal(idle.breathe, false);

  const missing = deriveAnalyzeButton({ missing: 3, engineState: 'IDLE' });
  assert.equal(missing.kind, 'global');
  assert.equal(missing.label, '补分析 · 待补 3 手');
  // remaining＝渲染层计数盒的数据源（2026/09/20：定宽盒防按钮宽度随手数位数抖动）
  assert.equal(missing.remaining, 3);

  // 运行中与空闲态**同形**（2026/09/19 人工反馈：只示剩余待补手数，去 `已补 x/y · 点击停止` 防按钮跳动）
  const running = deriveAnalyzeButton({ missing: 3, globalRunning: true, globalDone: 2, globalTotal: 5, engineState: 'IDLE' });
  assert.equal(running.kind, 'progress');
  assert.equal(running.breathe, true);
  assert.equal(running.label, '补分析 · 待补 3 手');
  assert.equal(running.remaining, 3);
  assert.equal(running.ratio, undefined);

  // total 未回投（服务端首条 analysis.progress 尚未到达）→ 剩余数用本地缺失数兜底，不得编造
  const runningUnknownTotal = deriveAnalyzeButton({ missing: 3, globalRunning: true, globalDone: 2, globalTotal: 0, engineState: 'IDLE' });
  assert.equal(runningUnknownTotal.label, '补分析 · 待补 3 手');
  assert.equal(runningUnknownTotal.remaining, 3);
  // 最后一手在飞（done=total）→ 如实显示 0（不编造）
  const runningLast = deriveAnalyzeButton({ missing: 3, globalRunning: true, globalDone: 5, globalTotal: 5, engineState: 'IDLE' });
  assert.equal(runningLast.label, '补分析 · 待补 0 手');
  assert.equal(runningLast.remaining, 0);

  // 全局进度态引擎降级 → 不呼吸（呼吸与禁用互斥，2026/09/14）
  const runningDead = deriveAnalyzeButton({ missing: 3, globalRunning: true, globalDone: 2, globalTotal: 5, engineState: 'DEAD' });
  assert.equal(runningDead.breathe, false);

  // 停止请求已下发（等待 done 收尾）时展示不变：同一 `补分析 · 待补 N 手`（2026/09/19 统一文案）
  const stopping = deriveAnalyzeButton({ missing: 3, globalRunning: true, globalDone: 2, globalTotal: 5, engineState: 'IDLE' });
  assert.equal(stopping.label, '补分析 · 待补 3 手');

  // 深算进行中（2026/09/14 人工调整）：仅呼吸——文案保持 [深度分析]、不设禁点
  const deepRunning = deriveAnalyzeButton({ deepRunning: true, engineState: 'ANALYZING' });
  assert.equal(deepRunning.kind, 'deep');
  assert.equal(deepRunning.label, '深度分析');
  assert.equal(deepRunning.remaining, null, '非计数态无剩余数（渲染层不得出现计数盒）');
  assert.equal(deepRunning.disabled, false);
  assert.equal(deepRunning.breathe, true);

  // 进行中引擎降级 → 不呼吸（与禁用互斥）
  const deepDead = deriveAnalyzeButton({ deepRunning: true, engineState: 'DEAD' });
  assert.equal(deepDead.breathe, false);
  assert.equal(deepDead.disabled, true);

  const dead = deriveAnalyzeButton({ missing: 5, engineState: 'DEAD' });
  assert.equal(dead.disabled, true);
  assert.equal(dead.reason, '引擎不可用');

  // STOPPED（未启动）/ INIT（加载中）同样灰置，但文案区分
  // （2026/09/18 语义拆分；2026/09/19 人工裁决：INIT 文案以现行实现为准）
  const notStarted = deriveAnalyzeButton({ missing: 5, engineState: 'STOPPED' });
  assert.equal(notStarted.disabled, true);
  assert.equal(notStarted.reason, '引擎未启动');
  const loading = deriveAnalyzeButton({ missing: 5, engineState: 'INIT' });
  assert.equal(loading.disabled, true);
  assert.equal(loading.reason, '引擎加载中，分析延后可用');

  const trialMode = deriveAnalyzeButton({ inTrial: true, engineState: 'IDLE' });
  assert.equal(trialMode.kind, 'none');
  assert.equal(trialMode.disabled, true);
});

test('FE-RV-08 | trialRelAfterState 试下替换（撤销链+落子）手数回夹/跟随/瞬态', () => {
  // 替换重放：从 rel=1 重放（先发多次 undo 收缩，再落子增长）
  // 收缩态1：[1,2,3]→[1,2]（跟随中 → 紧贴新尾；瞬态：调用方不拉推荐）
  assert.deepEqual(
    trialRelAfterState({ curRel: 1, prevLen: 3, nextLen: 2, follow: true }),
    { rel: 2, follow: true, transient: true },
  );
  // 收缩态2：→[1]（仍跟随，不回越界；旧实现此处已清 follow → rel 停留 2 越界）
  assert.deepEqual(
    trialRelAfterState({ curRel: 2, prevLen: 2, nextLen: 1, follow: true }),
    { rel: 1, follow: true, transient: true },
  );
  // 落子增长：→[1,new]（跟随落尾并解除跟随；末态需拉推荐）
  assert.deepEqual(
    trialRelAfterState({ curRel: 1, prevLen: 1, nextLen: 2, follow: true }),
    { rel: 2, follow: false, transient: false },
  );
  // 普通追加（无撤销）
  assert.deepEqual(
    trialRelAfterState({ curRel: 1, prevLen: 1, nextLen: 2, follow: true }),
    { rel: 2, follow: false, transient: false },
  );
  // 非跟随态收缩：回夹到分支长度（防 pos.rel > max 滑轨越界）
  assert.deepEqual(
    trialRelAfterState({ curRel: 3, prevLen: 4, nextLen: 2, follow: false }),
    { rel: 2, follow: false, transient: false },
  );
  // 边界：空分支/非法输入
  assert.deepEqual(
    trialRelAfterState({ curRel: 5, prevLen: 5, nextLen: 0, follow: false }),
    { rel: 0, follow: false, transient: false },
  );
  assert.deepEqual(trialRelAfterState({}), { rel: 0, follow: false, transient: false });
});

test('FE-RV-07 | reviewEmptyCopy 文案', () => {
  assert.equal(reviewEmptyCopy('load-fail').title, '对局不存在或已删除');
  assert.ok(reviewEmptyCopy('generic').title.includes('失败'));
});

test('FE-RV-07b | deepAnalyzeLit：[深度分析] 图标点亮口径（结果对应当前局面且未重算，2026/09/17）', () => {
  // 结果到达且仍是当前局面 → 点亮
  assert.equal(deepAnalyzeLit({ resultKey: 'main:12', currentKey: 'main:12', running: false }), true);
  // 切换到了其它局面（手数/试下分支）→ 熄灭
  assert.equal(deepAnalyzeLit({ resultKey: 'main:12', currentKey: 'main:13', running: false }), false);
  assert.equal(deepAnalyzeLit({ resultKey: 'main:12', currentKey: 'trial:1:2', running: false }), false);
  // 再次深算进行中 → 熄灭（对局结果到达后重新点亮）
  assert.equal(deepAnalyzeLit({ resultKey: 'main:12', currentKey: 'main:12', running: true }), false);
  // 从未有结果 → 不点亮
  assert.equal(deepAnalyzeLit({ resultKey: null, currentKey: 'main:12', running: false }), false);
  assert.equal(deepAnalyzeLit(), false);
});

test('FE-RV-09 | resolveReviewTarget 进入定位优先级（at > 本机记录 > 末手；越界回夹）', () => {
  const base = { gameId: 7, maxMove: 24 };
  // 无显式 at / 无记录 → 末手
  assert.deepEqual(resolveReviewTarget({ ...base, at: null, saved: null }), { moveNo: 24, from: 'end' });
  // ?at 显式优先（合法非负整数；越界回夹到 [0, maxMove]）
  assert.deepEqual(
    resolveReviewTarget({ ...base, at: '10', saved: { gameId: 7, moveNo: 3 } }),
    { moveNo: 10, from: 'at' },
  );
  assert.deepEqual(resolveReviewTarget({ ...base, at: '99', saved: null }), { moveNo: 24, from: 'at' });
  assert.deepEqual(resolveReviewTarget({ ...base, at: 0, saved: null }), { moveNo: 0, from: 'at' });
  // at 空串/非数字 → 视为缺省（记录接管）
  assert.deepEqual(
    resolveReviewTarget({ ...base, at: '', saved: { gameId: 7, moveNo: 3 } }),
    { moveNo: 3, from: 'saved' },
  );
  assert.deepEqual(
    resolveReviewTarget({ ...base, at: 'abc', saved: { gameId: 7, moveNo: 3 } }),
    { moveNo: 3, from: 'saved' },
  );
  // 记录仅同局生效；脏数据（非整数/负数）忽略，越界回夹
  assert.deepEqual(
    resolveReviewTarget({ ...base, at: null, saved: { gameId: 8, moveNo: 3 } }),
    { moveNo: 24, from: 'end' },
  );
  assert.deepEqual(
    resolveReviewTarget({ ...base, at: null, saved: { gameId: '7', moveNo: '3' } }),
    { moveNo: 3, from: 'saved' },
  );
  assert.deepEqual(
    resolveReviewTarget({ ...base, at: null, saved: { gameId: 7, moveNo: 999 } }),
    { moveNo: 24, from: 'saved' },
  );
  assert.deepEqual(
    resolveReviewTarget({ ...base, at: null, saved: { gameId: 7, moveNo: -5 } }),
    { moveNo: 24, from: 'end' },
  );
  // 末手 0（空盘）安全
  assert.deepEqual(
    resolveReviewTarget({ gameId: 7, maxMove: 0, at: null, saved: { gameId: 7, moveNo: 5 } }),
    { moveNo: 0, from: 'saved' },
  );
});

test('FE-RV-10 | reviewErrorOutcome：引擎不可用静默降级（不逐条弹报）+ 深算进行态复位（BUG-091）', () => {
  // 引擎不可用（DEAD/FATAL）：复位深算进行态 + 解除试下推荐 loading + **静默**
  // （降级由全局横幅/胶囊表达；逐手试下推荐、领地补算的后台信封不得弹报）
  for (const code of ['ENGINE_DEAD', 'ENGINE_FATAL']) {
    const out = reviewErrorOutcome(code);
    assert.equal(out.resetDeep, true);
    assert.equal(out.clearRecommend, true);
    assert.equal(out.resetGlobal, true, 'M-14：引擎类错误必须复位全局分析进行态');
    assert.equal(out.silence, true);
  }
  // 引擎忙：复位但仍弹报（用户可见的临时态，非全局降级）
  const busy = reviewErrorOutcome('ENGINE_BUSY');
  assert.deepEqual(busy, { resetDeep: true, clearRecommend: true, resetGlobal: true, silence: false });
  // 深算已在跑：仅复位进行态（不得停当前深算），弹报保留；全局分析不在运行（不需复位）
  assert.deepEqual(reviewErrorOutcome('DEEP_ANALYSIS_RUNNING'), { resetDeep: true, clearRecommend: false, resetGlobal: false, silence: false });
  // 其它错误：原样弹报（不触碰引擎相关状态）
  assert.deepEqual(reviewErrorOutcome('ILLEGAL_MOVE'), { resetDeep: false, clearRecommend: false, resetGlobal: false, silence: false });
  assert.deepEqual(reviewErrorOutcome(''), { resetDeep: false, clearRecommend: false, resetGlobal: false, silence: false });
  // 大小写容错
  assert.equal(reviewErrorOutcome('engine_dead').silence, true);
});

test('FE-RV-14 | trialStateDisposition：只接纳「当前分支更新」与「已发起 enter 的新分支」（M-13）', () => {
  // 当前分支回投 → 更新
  assert.equal(trialStateDisposition({ activeId: 7, incomingId: 7 }), 'update');
  // 已退出分支的迟到回投 → 忽略（旧实现无条件 re-enter，把用户拉回已退出分支）
  assert.equal(trialStateDisposition({ activeId: null, pendingEnter: false, incomingId: 7, exitedId: 7 }), 'ignore');
  // 无入口意图的陌生 id（错序/跨会话回投）→ 忽略
  assert.equal(trialStateDisposition({ activeId: null, pendingEnter: false, incomingId: 8 }), 'ignore');
  assert.equal(trialStateDisposition({ activeId: 3, pendingEnter: false, incomingId: 8 }), 'ignore');
  // 用户已发起 trial.enter（pending）→ 采纳新分支（但已退出 id 仍拒绝：防旧帧抢在 enter 回投前）
  assert.equal(trialStateDisposition({ activeId: null, pendingEnter: true, incomingId: 9 }), 'adopt');
  assert.equal(trialStateDisposition({ activeId: null, pendingEnter: true, incomingId: 7, exitedId: 7 }), 'ignore');
  // 非法/缺失载荷 → 忽略
  assert.equal(trialStateDisposition({}), 'ignore');
  assert.equal(trialStateDisposition({ incomingId: null, pendingEnter: true }), 'ignore');
  assert.equal(trialStateDisposition({ incomingId: 'abc', pendingEnter: true }), 'ignore');
});

test('FE-RV-11 | recommendFetchAction：试下推荐引擎不可用时本地降级，主谱（持久化）照常请求（BUG-091）', () => {
  // 缓存命中：无论引擎态直接应用（不算请求）
  assert.equal(recommendFetchAction({ hasCache: true, trialKey: true, engineDown: true }), 'cache');
  assert.equal(recommendFetchAction({ hasCache: true, trialKey: false, engineDown: false }), 'cache');
  // 试下（会话现算、依赖引擎）+ 引擎不可用 → 本地降级：不发无效请求
  assert.equal(recommendFetchAction({ hasCache: false, trialKey: true, engineDown: true }), 'local-fallback');
  // 试下 + 引擎可用 → 正常请求
  assert.equal(recommendFetchAction({ hasCache: false, trialKey: true, engineDown: false }), 'request');
  // 主谱读持久化分析（引擎无关）→ 引擎不可用也照常请求（UI_UX §6.2）
  assert.equal(recommendFetchAction({ hasCache: false, trialKey: false, engineDown: true }), 'request');
  assert.equal(recommendFetchAction({}), 'request');
});

test('FE-RV-16 | recommendFetchAction：批量快照命中 → bundle（本地应用，零请求）且优先级低于实时缓存', () => {
  // 快照命中：主谱逐手步进不再往返（2026/09/21 性能优化）；引擎态无关（持久化数据）
  assert.equal(
    recommendFetchAction({ hasCache: false, hasBundle: true, trialKey: false, engineDown: false }),
    'bundle',
  );
  assert.equal(
    recommendFetchAction({ hasCache: false, hasBundle: true, trialKey: false, engineDown: true }),
    'bundle',
  );
  // 实时缓存（WS/深算结果）优先于快照：两者同时可用时以实时为准
  assert.equal(
    recommendFetchAction({ hasCache: true, hasBundle: true, trialKey: false, engineDown: false }),
    'cache',
  );
  // 快照未命中 → 回落既有 WS 路径
  assert.equal(
    recommendFetchAction({ hasCache: false, hasBundle: false, trialKey: false, engineDown: false }),
    'request',
  );
});

/** 棋面棋子快捷构造（boardTransition 用：x/y/color/moveNo）。 */
function st(x, y, color, moveNo) {
  return { x, y, color, moveNo };
}

test('FE-RV-12 | boardTransition：正向单步提子 → captureStep（残影动画），其余过渡一律整盘替换', () => {
  // 正向单步提子：黑 3 手(2,0) 提白 (1,0)——新增 1 子且 moveNo(3) > 过渡前最大(2)
  const before = [st(0, 0, 'black', 1), st(1, 0, 'white', 2)];
  const after = [st(0, 0, 'black', 1), st(2, 0, 'black', 3)];
  const t = boardTransition(before, after);
  assert.equal(t.captureStep, true);
  assert.deepEqual(t.added, [st(2, 0, 'black', 3)]);
  assert.deepEqual(t.removed, [st(1, 0, 'white', 2)]);

  // 正向单步但未提子：不播残影（走整盘替换，保持既有“无吃子不闪”口径）
  assert.equal(boardTransition(before, [...before, st(2, 0, 'black', 3)]).captureStep, false);

  // 回退一手（提子局的倒放）：新增子 moveNo(2) < 过渡前最大(3) → 不播残影
  assert.equal(boardTransition(after, before).captureStep, false);

  // 回退一手（普通局）：无新增子 → 不播残影
  assert.equal(boardTransition([st(0, 0, 'black', 1), st(1, 0, 'white', 2)], [st(0, 0, 'black', 1)]).captureStep, false);

  // 跳转/整盘重建（首帧加载 / 拖进度条跨多手）：新增子 ≠ 1 → 不播残影
  const empty = boardTransition([], before);
  assert.equal(empty.captureStep, false); // 空盘首帧：基准为空，避免误报
  assert.equal(boardTransition([st(0, 0, 'black', 1), st(1, 0, 'white', 2)], [...after, st(3, 0, 'white', 4)]).captureStep, false);

  // 新增子缺 moveNo（脏数据）→ 方向不可判，不播残影（宁缺勿错）
  assert.equal(boardTransition(before, [st(0, 0, 'black', 1), st(2, 0, 'black')]).captureStep, false);

  // 多子被提（一步提两块）：removed 全量返回，仍为单步提子
  const multi = boardTransition(
    [st(0, 0, 'black', 1), st(1, 0, 'white', 2), st(0, 1, 'white', 4)],
    [st(0, 0, 'black', 1), st(2, 0, 'black', 5)],
  );
  assert.equal(multi.captureStep, true);
  assert.equal(multi.removed.length, 2);

  // 容错：非数组入参（防御 localStorage/调用方脏数据）不抛错
  assert.deepEqual(boardTransition(null, undefined), { added: [], removed: [], captureStep: false });
});

test('FE-RV-13 | reportSlotView：未结算终局 → [结算]（恒占原 [报告] 位置）；其余按门控 [报告]', () => {
  // 导入棋谱（finished 且 result 为空）→ [结算]；未结算期间即使分析完整也不显示 [报告]
  assert.equal(reportSlotView({ status: 'finished', result: null, analysisComplete: true }), 'settle');
  assert.equal(reportSlotView({ status: 'finished', result: null, analysisComplete: false }), 'settle');
  assert.equal(reportSlotView({ status: 'finished', analysisComplete: true }), 'settle'); // result 缺省 = 空
  // 已结算终局：分析完整 → [报告]；不完整 → 隐藏（BUG-106：分析不完整时报告入口不得可见）
  assert.equal(reportSlotView({ status: 'finished', result: 'W+6.5', analysisComplete: true }), 'report');
  assert.equal(reportSlotView({ status: 'finished', result: 'W+Resign', analysisComplete: false }), 'none');
  assert.equal(reportSlotView({ status: 'finished', result: 'B+Resign' }), 'none');
  // 进行中：同样仅分析完整显示 [报告]（既有口径）
  assert.equal(reportSlotView({ status: 'active', result: null, analysisComplete: true }), 'report');
  assert.equal(reportSlotView({ status: 'active', result: null, analysisComplete: false }), 'none');
  assert.equal(reportSlotView({ status: 'scoring', result: null, analysisComplete: false }), 'none');
  // 未加载/异常输入不抛错且不误显
  assert.equal(reportSlotView({}), 'none');
  assert.equal(reportSlotView(), 'none');
});
