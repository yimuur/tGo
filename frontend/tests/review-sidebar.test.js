/**
 * FE-RVS（review-sidebar 纯函数层）· 复盘侧栏卡派生（T6.8）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveReviewInfo,
  deriveReviewCurve,
  resolveCurveSeek,
  deriveRecommendCard,
  deriveCommentCard,
  recommendCardCopy,
  commentEmptyCopy,
  reviewCurveCopy,
  reviewInfoBodyHTML,
  reviewSettleTip,
  retainCardAction,
} from '../static/js/views/review-sidebar.js';

test('FE-RVS-01 | deriveReviewInfo 玩家/结果/分析覆盖', () => {
  const game = {
    players: { black: { name: '张三', rank: 'rank_5k' }, white: { name: 'AI', rank: null } },
    movesCount: 120,
    analysesCount: 118,
    analysisComplete: false,
    result: 'W+2.5',
  };
  const info = deriveReviewInfo(game);
  assert.equal(info.players.black.rank, '5K');
  assert.equal(info.analysisDone, 118);
  assert.equal(info.analysisTotal, 121);
  assert.equal(info.result, 'W+2.5');
  assert.equal(info.analysisComplete, false);
});

test('FE-RVS-02 | deriveReviewCurve 主谱 ready/current', () => {
  const curve = deriveReviewCurve({
    mainPoints: [
      { moveNo: 0, winrate: 50, scoreLead: 0 },
      { moveNo: 1, winrate: 55, scoreLead: 2 },
    ],
    current: 1,
    totalMoveNo: 3,
  });
  assert.equal(curve.state, 'ready');
  assert.equal(curve.pts.length, 2);
  assert.equal(curve.current, 1);
  assert.equal(curve.inTrial, false);
});

test('FE-RVS-03 | deriveReviewCurve 试下=前缀+分支（原谱未来不上图）', () => {
  const main = [
    { moveNo: 0, winrate: 50, scoreLead: 0 },
    { moveNo: 1, winrate: 55, scoreLead: 2 },
    { moveNo: 2, winrate: 60, scoreLead: 4 },
    { moveNo: 3, winrate: 40, scoreLead: -8 },
  ];
  // 从第 1 手试下：试下 1 点 = 绝对 moveNo 2（winrate 30，替换主谱未来）
  const curve = deriveReviewCurve({
    mainPoints: main,
    inTrial: true,
    enterMoveNo: 1,
    trialPts: [{ moveNo: 2, winrate: 30, scoreLead: -6 }],
    current: 2,
  });
  assert.equal(curve.inTrial, true);
  assert.equal(curve.tailClipped, true);
  const p2 = curve.pts.find((p) => p.moveNo === 2);
  assert.equal(p2.winrate, 30);
  // 2026/09/12 人工确认：进入手之后的主谱未来（原谱）不再上图（防试下/原谱混线）
  assert.ok(!curve.pts.some((p) => p.moveNo === 3), '主谱未来（moveNo 3）剔除');
  assert.deepEqual(curve.pts.map((p) => p.moveNo), [0, 1, 2]);
});

test('FE-RVS-11 | resolveCurveSeek 主谱/试下分支/试下前缀（回实战）', () => {
  // 主谱：绝对手数
  assert.deepEqual(
    resolveCurveSeek({ moveNo: 12, inTrial: false }),
    { mode: 'main', moveNo: 12 },
  );
  assert.equal(resolveCurveSeek({ moveNo: 2.4, inTrial: false }).moveNo, 2, '四舍五入');
  // 试下分支点（绝对 > 进入手）→ 相对手数
  assert.deepEqual(
    resolveCurveSeek({ moveNo: 13, inTrial: true, enterMoveNo: 10 }),
    { mode: 'trial', rel: 3 },
  );
  // 试下主谱前缀（≤ 进入手）→ rel 0＝回实战（与滑轨 0 一致）
  assert.deepEqual(
    resolveCurveSeek({ moveNo: 4, inTrial: true, enterMoveNo: 10 }),
    { mode: 'trial', rel: 0 },
  );
  assert.deepEqual(
    resolveCurveSeek({ moveNo: 10, inTrial: true, enterMoveNo: 10 }),
    { mode: 'trial', rel: 0 },
    '进入手本身 = 回实战',
  );
  // 非法
  assert.equal(resolveCurveSeek({ moveNo: null }), null);
  assert.equal(resolveCurveSeek({}), null);
});

test('FE-RVS-12 | deriveReviewCurve 试下无分支点=仅前缀（生成中，不混原谱）', () => {
  const main = [
    { moveNo: 0, winrate: 50, scoreLead: 0 },
    { moveNo: 1, winrate: 55, scoreLead: 2 },
    { moveNo: 2, winrate: 60, scoreLead: 4 },
    { moveNo: 3, winrate: 40, scoreLead: -8 },
  ];
  const curve = deriveReviewCurve({
    mainPoints: main,
    inTrial: true,
    enterMoveNo: 2,
    trialPts: [],
    current: 2,
  });
  assert.equal(curve.state, 'ready');
  assert.equal(curve.tailClipped, false);
  assert.deepEqual(curve.pts.map((p) => p.moveNo), [0, 1, 2], '仅主谱前缀');
});

test('FE-RVS-04 | deriveRecommendCard loading/empty/offline/ready/disabled（无 CTA，试下=实时）', () => {
  const empty = deriveRecommendCard({ review: { loading: true }, atKey: 'main:0' });
  assert.equal(empty.state, 'loading');

  const rec = {
    key: 'main:0',
    hasData: true,
    moves: [
      { x: 3, y: 3, winrate: 62.4, score_lead: 4.8, visits: 1200, pv: [] },
    ],
  };
  const ready = deriveRecommendCard({ review: rec, atKey: 'main:0', boardSize: 19, engineState: 'IDLE' });
  assert.equal(ready.state, 'ready');
  assert.equal(ready.entries[0].coord, 'D16');
  assert.equal(ready.entries[0].winrate, 62.4);

  const stale = deriveRecommendCard({ review: rec, atKey: 'main:5', boardSize: 19, engineState: 'IDLE' });
  assert.equal(stale.state, 'disabled');

  // 引擎可用 + 无数据 → empty（仅提示，无 [运行全局分析补全] CTA）
  const nodata = deriveRecommendCard({ review: { key: 'main:0', hasData: false, moves: [] }, atKey: 'main:0', boardSize: 19, engineState: 'IDLE', inTrial: false });
  assert.equal(nodata.state, 'empty');
  assert.equal(nodata.empty, true);
  assert.equal(nodata.canGlobal, undefined);
  // 引擎不可用 + 无数据 → offline（试下=实时语义）
  const deadEmpty = deriveRecommendCard({ review: { key: 'main:0', hasData: false, moves: [] }, atKey: 'main:0', boardSize: 19, engineState: 'DEAD', inTrial: false });
  assert.equal(deadEmpty.state, 'offline');
  assert.equal(deadEmpty.offline, true);
  // 试下分支实时语义标记
  const trialRec = deriveRecommendCard({ review: rec, atKey: 'trial:9:1', boardSize: 19, engineState: 'IDLE', inTrial: true });
  assert.equal(trialRec.inTrial, true);
});

test('FE-RVS-07 | recommendCardCopy 主谱读持久化 vs 试下实时文案', () => {
  // 主谱标题
  assert.equal(recommendCardCopy({ state: 'ready', inTrial: false }).title, 'AI 推荐（回放）');
  // 试下标题 = 实时
  assert.equal(recommendCardCopy({ state: 'ready', inTrial: true }).title, 'AI 推荐（实时）');
  // 试下 loading/foot
  const tl = recommendCardCopy({ state: 'loading', inTrial: true });
  assert.ok(tl.loading.includes('实时推荐计算中'));
  assert.ok(tl.foot.includes('自动触发'));
  // 主谱空态：无 CTA，仅提示棋盘下 [补分析]
  const me = recommendCardCopy({ state: 'empty', inTrial: false });
  assert.equal(me.body, '该手暂无分析数据');
  assert.ok(me.foot.includes('[补分析]'));
  // 试下空态（引擎可用未返回）
  const te = recommendCardCopy({ state: 'empty', inTrial: true });
  assert.ok(te.body.includes('稍候自动出现'));
  // offline：引擎不可用
  const mo = recommendCardCopy({ state: 'offline', inTrial: false });
  assert.ok(mo.body.includes('引擎不可用'));
  const to = recommendCardCopy({ state: 'offline', inTrial: true });
  assert.ok(to.body.includes('引擎不可用'));
  // ready foot
  assert.ok(recommendCardCopy({ state: 'ready' }).foot.includes('变化图预览'));
});

test('FE-RVS-08 | commentEmptyCopy 点评空态实时语义', () => {
  assert.equal(commentEmptyCopy({ loading: true }), '点评生成中…');
  assert.equal(commentEmptyCopy({ engineDown: true }), '引擎不可用 · 点评暂停');
  assert.equal(commentEmptyCopy({ inTrial: true }), '实时点评尚未生成');
  assert.equal(commentEmptyCopy({ inTrial: false }), '该手暂无点评数据');
});

test('FE-RVS-10 | reviewCurveCopy 试下实时曲线文案（引擎相关）', () => {
  // 主谱：ready foot / 空态 empty
  assert.ok(reviewCurveCopy({ ready: true, inTrial: false }).foot.includes('点击曲线定位'));
  assert.ok(reviewCurveCopy({ inTrial: false }).empty.includes('[补分析]'));
  // 试下 ready + 分支点（会话实时，自动更新）
  const rt = reviewCurveCopy({ ready: true, inTrial: true, tailClipped: true });
  assert.ok(rt.foot.includes('试下实时曲线'));
  assert.ok(rt.foot.includes('自动更新'));
  // 试下 ready 但仅主谱前缀：引擎可用=生成中 / 引擎不可用=暂停
  assert.ok(reviewCurveCopy({ ready: true, inTrial: true }).foot.includes('生成中'));
  assert.ok(reviewCurveCopy({ ready: true, inTrial: true, engineDown: true }).foot.includes('引擎不可用'));
  // 试下空态（无任何点）
  assert.ok(reviewCurveCopy({ inTrial: true }).empty.includes('生成中'));
  assert.ok(reviewCurveCopy({ inTrial: true, engineDown: true }).empty.includes('引擎不可用'));
});

test('FE-RVS-09 | reviewInfoBodyHTML 追加提示行（hint）', () => {
  const info = {
    players: { black: { name: '黑', rank: null }, white: { name: '白', rank: null } },
    result: null,
    analysisDone: 0,
    analysisTotal: 1,
    analysisComplete: false,
  };
  assert.ok(!reviewInfoBodyHTML(info).includes('info-hint'));
  const withHint = reviewInfoBodyHTML(info, '第 4 手 PASS');
  assert.ok(withHint.includes('info-hint'));
  assert.ok(withHint.includes('第 4 手 PASS'));
});

test('FE-RVS-14 | 对局信息卡数值字号统一（结果/分析覆盖 走 .kv .value，不内联覆盖；2026/09/15 人工反馈）', () => {
  const html = reviewInfoBodyHTML({
    players: { black: { name: '黑', rank: null }, white: { name: '白', rank: null } },
    result: 'B+11.5',
    analysisDone: 56,
    analysisTotal: 56,
    analysisComplete: true,
  });
  assert.ok(!html.includes('font-size'), '不得内联 font-size（应与对弈页 当前目差 同字号）');
  assert.equal((html.match(/class="value/g) || []).length, 2, '两格数值样式需同构');
});

test('FE-RVS-13 | reviewSettleTip 对局信息卡 hover：双 PASS 结算目数（无数据 → null）', () => {
  // 双 PASS 确认结算局：与结算面板同格式（整数原样 / 一位小数去尾 0）
  assert.equal(reviewSettleTip({ blackScore: 24, whiteScore: 32.5 }), '终局结算 · 黑目 24 · 白目 32.5');
  assert.equal(reviewSettleTip({ blackScore: 77.0, whiteScore: 0 }), '终局结算 · 黑目 77 · 白目 0');
  // 认输/未结算（无 scorings 行）→ 不显示提示
  assert.equal(reviewSettleTip({ blackScore: null, whiteScore: null }), null);
  assert.equal(reviewSettleTip({ blackScore: 24 }), null);
  assert.equal(reviewSettleTip(null), null);
});

test('FE-RVS-14 | retainCardAction 保留式加载判定（复盘卡片防塔陷）', () => {
  // 等待新数据 + 已有非占位内容 → 原地保留（不换矮占位再回弹）
  assert.equal(retainCardAction({ waiting: true, hasContent: true, placeholder: false }), 'keep');
  // 占位态/无内容/非等待 → 照常替换（首次加载用矮占位合法）
  assert.equal(retainCardAction({ waiting: true, hasContent: true, placeholder: true }), 'replace');
  assert.equal(retainCardAction({ waiting: true, hasContent: false }), 'replace');
  assert.equal(retainCardAction({ waiting: false, hasContent: true }), 'replace');
  assert.equal(retainCardAction({}), 'replace');
});

test('FE-RVS-05 | deriveCommentCard 五色/ΔW/ΔS 文字 + 落子方标注', () => {
  const cc = deriveCommentCard({
    comment: { color: 'W', x: 15, y: 3, grade: 'blunder', delta_winrate: -21.4, score_delta: -4.8 },
    moveDesc: { inTrial: false, labelText: '第 88 手（主谱）' },
  });
  assert.equal(cc.has, true);
  assert.equal(cc.label, '败着');
  assert.equal(cc.alt, '昏招');
  assert.ok(cc.head.startsWith('白 · 第 88 手（主谱）'));
  assert.ok(cc.sub.includes('ΔW −21.4%'));
  assert.ok(cc.sub.includes('ΔS −4.8 目')); // ΔS=目数变化（恶手为负）
  // 缺 color（兼容旧载荷）→ 不标注落子方
  const legacy = deriveCommentCard({
    comment: { x: 15, y: 3, grade: 'blunder', delta_winrate: -21.4, score_delta: -4.8 },
    moveDesc: { labelText: '第 88 手（主谱）' },
  });
  assert.ok(legacy.head.startsWith('第 88 手（主谱）'));
});

test('FE-RVS-11 | recommendCardCopy ready：白方视角脚注（视角跟随当前执色方）', () => {
  const black = recommendCardCopy({ state: 'ready', side: 'B' });
  assert.ok(black.foot.includes('点击推荐行'));
  assert.ok(!black.foot.includes('白方视角'));
  const white = recommendCardCopy({ state: 'ready', side: 'W' });
  assert.ok(white.foot.includes('白方视角'));
});

test('FE-RVS-12 | deriveRecommendCard 透传 side（渲染层不再读外层作用域，BUG-027）', () => {
  const white = deriveRecommendCard({
    review: { key: 'main:3', side: 'W', moves: [{ x: 3, y: 3, winrate: 60, score_lead: 1.2 }] },
    atKey: 'main:3',
    boardSize: 19,
    engineState: 'IDLE',
  });
  assert.equal(white.state, 'ready');
  assert.equal(white.side, 'W');
  const black = deriveRecommendCard({
    review: { key: 'main:3', side: 'B', moves: [{ x: 3, y: 3 }] },
    atKey: 'main:3',
    boardSize: 19,
    engineState: 'IDLE',
  });
  assert.equal(black.side, 'B');
  // 缺 side（旧载荷）→ null（不显示脚注）
  const legacy = deriveRecommendCard({
    review: { key: 'main:3', moves: [{ x: 3, y: 3 }] },
    atKey: 'main:3',
    boardSize: 19,
    engineState: 'IDLE',
  });
  assert.equal(legacy.side, null);
});

test('FE-RVS-06 | deriveCommentCard 无点评 → has=false', () => {
  const cc = deriveCommentCard({ comment: null, moveDesc: { labelText: '第 0 手' } });
  assert.equal(cc.has, false);
});

test('FE-RVS-15 | 结果文案：已结束且无终局结果（导入棋谱）＝「未结算」；其余无结果＝「未结束」', () => {
  const unsettled = deriveReviewInfo({ status: 'finished', result: null, players: {} });
  assert.equal(unsettled.status, 'finished');
  assert.equal(unsettled.result, null);
  let body = reviewInfoBodyHTML(unsettled);
  assert.ok(body.includes('未结算'), '导入棋谱（finished 无结果）信息卡结果位必须显示「未结算」');
  assert.ok(!body.includes('未结束'), '导入棋谱不得再显示「未结束」');
  // 进行中（active/scoring）无结果 → 保持「未结束」
  for (const st of ['active', 'scoring']) {
    body = reviewInfoBodyHTML(deriveReviewInfo({ status: st, result: null, players: {} }));
    assert.ok(body.includes('未结束'), `${st} 无结果必须保持「未结束」`);
    assert.ok(!body.includes('未结算'), `${st} 不得误示「未结算」`);
  }
  // 有结果（含认输）照常显示结果原文
  const settled = reviewInfoBodyHTML(deriveReviewInfo({ status: 'finished', result: 'W+1.5', players: {} }));
  assert.ok(settled.includes('W+1.5'));
});
