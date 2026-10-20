/**
 * tGo · review-list-view.js 棋谱列表纯函数层无头单测（T6.7，node --test）
 * 用例 ID: FE-RLIST-*
 * 覆盖（TASK.md T6.7 验收·纯逻辑）：
 *   - listQuery：状态 tab → 服务端参数（进行中=created/active/scoring 数组 OR）、
 *     收藏 AND、姓名搜索裁剪、编号搜索（`#123` 不产生 name——定位由 focus_id 承担）、
 *     分页 page/page_size；
 *   - searchIntent：`#123` → 定位意图；其余文本 → 姓名搜索；空白/`#`/非法编号 → none；
 *   - deriveRow：模式徽章/标题（AI 侧段位按 ai_level 派生）/大小规则/结果或进行中
 *     文案/相对时间/收藏/删除可见性（仅 finished）/主操作（回放|续弈）；
 *   - normalizeMoves / derivePreview：吃子回放石子数、预览 info 段、报告入口判定
 *     （analysis_complete && finished）；
 *   - deriveEmptyState：loading/error/none（还没有对局）/filter（无符合）；
 *   - pagerWindow / derivePager：窗口/省略号/钳制/越界；
 *   - miniBoardSvg：网格线/星位/云子数量与越界忽略；
 *   - parseContentDispositionFilename：SGF 下载文件名处理；
 *   - retainListAction：保留式加载判定（切换 tab/筛选/搜索/分页不塌缩闪烁，BUG-061）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  PAGE_SIZE,
  STATUS_TABS,
  ACTIVE_STATUSES,
  DELETE_DISABLED_TIP,
  statusToParam,
  searchIntent,
  listQuery,
  listStateFromQuery,
  listQueryFromState,
  deriveRow,
  normalizeMoves,
  derivePreview,
  deriveEmptyState,
  retainListAction,
  pagerWindow,
  derivePager,
  miniBoardSvg,
  parseContentDispositionFilename,
  rowHTML,
  previewHTML,
  escapeHtml,
} from '../static/js/views/review-list-view.js';

/** 构造列表项 GameInfo（API §3.1 白名单字段子集）。 */
function makeGame(overrides = {}) {
  const g = {
    id: 1,
    mode: 'human_ai',
    board_size: 19,
    rules: 'chinese',
    komi: 7.5,
    handicap: 0,
    human_color: 'B',
    status: 'finished',
    result: 'B+7.5',
    black_name: '张三',
    black_rank: 'rank_1d',
    white_name: 'AI',
    white_rank: null,
    ai_style: 'standard',
    ai_level: 5,
    adaptive_enabled: false,
    coaching_enabled: false,
    favorite: false,
    last_move_no: 120,
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-05T00:00:00Z',
    finished_at: '2026-09-05T00:00:00Z',
    black_captures: 2,
    white_captures: 3,
    undo_count: 0,
    ...overrides,
  };
  return g;
}

const NOW = Date.parse('2026-09-06T00:00:00Z');

/* ============================================================
 * listQuery（筛选/收藏 AND/搜索/分页参数）
 * ============================================================ */

test('FE-RLIST-01 listQuery：状态 tab → status 参数（active=多值 OR）', () => {
  assert.equal(statusToParam('all'), null);
  assert.deepEqual(statusToParam('active'), [...ACTIVE_STATUSES]);
  assert.equal(statusToParam('finished'), 'finished');
  assert.deepEqual(listQuery({ tab: 'all', page: 1 }), { page: 1, page_size: 10 });
  const activeQ = listQuery({ tab: 'active' });
  assert.deepEqual(activeQ.status, ['created', 'active', 'scoring']);
  assert.deepEqual(listQuery({ tab: 'finished' }).status, 'finished');
  assert.equal(STATUS_TABS.length, 3);
});

test('FE-RLIST-02 listQuery：收藏 AND + 姓名搜索裁剪 + 分页', () => {
  const q = listQuery({ tab: 'finished', favOnly: true, q: '  张三 ', page: 3, pageSize: 20 });
  assert.equal(q.favorite, true);
  assert.equal(q.name, '张三');
  assert.equal(q.status, 'finished');
  assert.equal(q.page, 3);
  // 空白姓名/收藏 off 时省略
  const q2 = listQuery({ tab: 'all', favOnly: false, q: '   ', page: 1 });
  assert.equal('name' in q2, false);
  assert.equal('favorite' in q2, false);
  // 编号搜索（`#123`）不产生 name 过滤（定位由调用方附 focus_id —— LIke %#123% 恒 0 行）
  const byId = listQuery({ tab: 'all', q: '# 123 ' });
  assert.equal('name' in byId, false);
  assert.equal(byId.page, 1);
  // page 越界钳制
  assert.equal(listQuery({ page: 0 }).page, 1);
  assert.equal(listQuery({ page: -3 }).page, 1);
});

test('FE-RLIST-22 searchIntent：`#编号`＝定位跳页；其余＝姓名搜索；空白/半成品/非法 → none', () => {
  // 2026/09/21 人工决策：编号搜索按「定位跳页」（服务端 focus_id → 翻页并选中），不筛选
  assert.deepEqual(searchIntent('#123'), { kind: 'id', id: 123 });
  assert.deepEqual(searchIntent('  # 42 '), { kind: 'id', id: 42 }); // `#` 与数字间允许空白
  assert.deepEqual(searchIntent('123'), { kind: 'name', name: '123' }); // 无 `#` 仍按姓名/任意文本
  assert.deepEqual(searchIntent(' 张三 '), { kind: 'name', name: '张三' });
  // 半成品（刚输入 `#`）与非法编号（0/越界，服务端 focus_id 约束 ge=1）→ 不搜索不定位
  assert.deepEqual(searchIntent('#'), { kind: 'none' });
  assert.deepEqual(searchIntent('#0'), { kind: 'none' });
  assert.deepEqual(searchIntent('#99999999999999999999'), { kind: 'none' });
  assert.deepEqual(searchIntent(''), { kind: 'none' });
  assert.deepEqual(searchIntent(null), { kind: 'none' });
  // `#12a` 不是纯编号 → 按文本搜索（有结果/空态都由服务端 LIKE 给出反馈）
  assert.deepEqual(searchIntent('#12a'), { kind: 'name', name: '#12a' });
});

/* ============================================================
 * deriveRow（列表行派生）
 * ============================================================ */

test('FE-RLIST-03 deriveRow：人机标题（AI 侧段位/风格按对局参数派生）+ finished 回放', () => {
  const row = deriveRow(makeGame(), { now: NOW });
  assert.equal(row.id, 1);
  assert.equal(row.modeLabel, '人机');
  assert.equal(row.modeAccent, true);
  assert.deepEqual(row.black, { name: '张三', rank: '1D', tag: '' });
  // AI 侧无 rank 快照 → ai_level 派生；风格标签=标准
  assert.deepEqual(row.white, { name: 'AI', rank: '5K', tag: '标准' });
  assert.equal(row.finished, true);
  assert.equal(row.canDelete, true);
  assert.equal(row.statusText, '已结束 · 黑胜 7.5 目');
  assert.equal(row.sizeRule, '19路 · 中国');
  assert.equal(row.primary.label, '回放');
  assert.equal(row.primary.kind, 'review');
  assert.equal(row.fav, false);
});

test('FE-RLIST-04 deriveRow：进行中 → 续弈；删除禁（W-16）；人人标题', () => {
  const active = deriveRow(
    makeGame({ status: 'active', last_move_no: 34, result: null, mode: 'human_human', black_name: '张三', white_name: '王太太', black_rank: null, white_rank: 'rank_1k' }),
    { now: NOW },
  );
  assert.equal(active.finished, false);
  assert.equal(active.canDelete, false);
  assert.equal(active.statusText, '进行中 · 第 34 手');
  assert.equal(active.primary.label, '续弈');
  assert.equal(active.primary.kind, 'game');
  assert.equal(active.modeLabel, '人人');
  assert.equal(active.modeAccent, false);
  assert.equal(active.black.rank, ''); // 无段位 → 无角标
  assert.deepEqual(active.white, { name: '王太太', rank: '1K', tag: '' });
  // created 未开局
  const created = deriveRow(makeGame({ status: 'created', last_move_no: 0 }), { now: NOW });
  assert.equal(created.statusText, '进行中 · 尚未开局');
  // created + 0 手可删（W-16 修订 2026/09/13）；有落子的进行中仍禁删
  assert.equal(created.canDelete, true);
  assert.equal(DELETE_DISABLED_TIP.includes('不可删除'), true);
});

test('FE-RLIST-05 deriveRow：AI 执黑（human_color=W）时黑侧显示 AI 档位/风格', () => {
  const row = deriveRow(
    makeGame({ mode: 'human_ai', human_color: 'W', black_name: 'AI', white_name: '李四', white_rank: 'rank_5k', ai_level: 9 }),
    { now: NOW },
  );
  assert.deepEqual(row.black, { name: 'AI', rank: '3D', tag: '标准' }); // level 9 → rank_3d
  assert.deepEqual(row.white, { name: '李四', rank: '5K', tag: '' });
});

test('FE-RLIST-06 deriveRow：相对时间（now 注入）/绝对回退', () => {
  const row = deriveRow(makeGame({ updated_at: new Date(NOW - 3 * 60 * 60 * 1000).toISOString() }), { now: NOW });
  assert.equal(row.relTime, '3 小时前');
  const old = deriveRow(makeGame({ updated_at: '2026-08-10T00:00:00Z' }), { now: NOW });
  assert.match(old.relTime, /\d{4}/); // 超过 7 天 → 绝对时间
});

test('FE-RLIST-07 deriveRow：白中盘胜 / 空结果回退', () => {
  const row = deriveRow(makeGame({ result: 'W+Resign' }), { now: NOW });
  assert.equal(row.statusText, '已结束 · 白中盘胜');
  const empty = deriveRow(makeGame({ result: null }), { now: NOW });
  assert.equal(empty.statusText, '已结束');
});

/* ============================================================
 * normalizeMoves / derivePreview（缩略棋面 + 报告入口判定）
 * ============================================================ */

test('FE-RLIST-08 normalizeMoves：过滤 pass/越界空点并转 camelCase', () => {
  const moves = [
    { move_no: 1, color: 'B', x: 9, y: 9, is_pass: 0 },
    { move_no: 2, color: 'W', x: 3, y: 3, is_pass: 0 },
    { move_no: 3, color: 'B', x: null, y: null, is_pass: 1 },
    { move_no: 4, color: 'W', x: 15, y: 15, is_pass: 0 },
  ];
  const norm = normalizeMoves(moves);
  assert.equal(norm.length, 3);
  assert.deepEqual(norm[0], { moveNo: 1, color: 'B', x: 9, y: 9, isPass: false });
  assert.deepEqual(norm[2], { moveNo: 4, color: 'W', x: 15, y: 15, isPass: false });
  assert.deepEqual(normalizeMoves(null), []);
});

test('FE-RLIST-09 derivePreview：让子 + 落子回放棋子数 & info 段（图下一行格式）', () => {
  const detail = {
    ...makeGame({ handicap: 2, komi: 0, adaptive_enabled: true, analysis_complete: true }),
    moves: [
      { move_no: 1, color: 'B', x: 9, y: 9, is_pass: 0 },
      { move_no: 2, color: 'W', x: 4, y: 4, is_pass: 0 },
    ],
  };
  const prev = derivePreview(detail);
  assert.equal(prev.kind, 'ready');
  assert.equal(prev.size, 19);
  assert.equal(prev.stones.length, 4); // 2 让子黑 + 2 落子
  assert.equal(prev.stones.filter((s) => s.color === 'black').length, 3);
  assert.equal(prev.finished, true);
  assert.equal(prev.reportReady, true); // finished && analysis_complete
  // 2026/09/13 人工反馈：`N 手 · 贴 X · 分先/让 N 子 · 结果（仅结束）`
  assert.deepEqual(prev.infoSegs, ['120 手', '贴 0', '让 2 子', 'B+7.5']);
  // 2026/09/21 人工决策：预览卡信息行首位徽章＝对局编号（模式不再单独派生）
  assert.equal('modeLabel' in prev, false);
  assert.equal(prev.primary.label, '回放');
});

test('FE-RLIST-10 derivePreview：分析不完整 → 报告隐藏；空 detail → empty', () => {
  const detail = {
    ...makeGame({ analysis_complete: false }),
    moves: [],
  };
  const prev = derivePreview(detail);
  assert.equal(prev.kind, 'ready');
  assert.equal(prev.reportReady, false);
  assert.equal(derivePreview(null).kind, 'empty');
  // 进行中局（分析未完成也不显示报告；信息行不含结果段）
  const active = derivePreview({ ...makeGame({ status: 'active', analysis_complete: true }), moves: [] });
  assert.equal(active.reportReady, false);
  assert.equal(active.primary.label, '续弈');
  assert.deepEqual(active.infoSegs, ['120 手', '贴 7.5', '分先']);
  assert.equal(active.id, 1);
});

/* ============================================================
 * deriveEmptyState / pager / miniBoardSvg / 文件名
 * ============================================================ */

test('FE-RLIST-11 deriveEmptyState：loading/error/none/filter/list', () => {
  assert.equal(deriveEmptyState({ loading: true }).kind, 'loading');
  assert.equal(deriveEmptyState({ error: true }).kind, 'error');
  const none = deriveEmptyState({ total: 0, rows: [], filtersActive: false });
  assert.equal(none.kind, 'none');
  assert.equal(none.title, '还没有对局');
  assert.equal(none.cta.hash, '#/create');
  const filter = deriveEmptyState({ total: 3, rows: [], filtersActive: true });
  assert.equal(filter.kind, 'filter');
  assert.equal(filter.title, '无符合筛选的对局');
  assert.equal(deriveEmptyState({ total: 3, rows: [1], filtersActive: false }).kind, 'list');
});

test('FE-RLIST-12 pagerWindow / derivePager：窗口、省略号与钳制', () => {
  assert.deepEqual(pagerWindow(1, 5), [1, 2, 3, 4, 5]);
  assert.deepEqual(pagerWindow(1, 20), [1, 2, 3, '…', 20]);
  assert.deepEqual(pagerWindow(10, 20), [1, '…', 9, 10, 11, '…', 20]);
  assert.deepEqual(pagerWindow(19, 20), [1, '…', 18, 19, 20]);
  assert.deepEqual(pagerWindow(20, 20), [1, '…', 18, 19, 20]);
  const pager = derivePager({ total: 0, page: 1 });
  assert.equal(pager.totalPages, 1);
  assert.equal(pager.hasPrev, false);
  assert.equal(pager.hasNext, false);
  const p = derivePager({ total: 41, page: 99, pageSize: 20 });
  assert.equal(p.totalPages, 3);
  assert.equal(p.current, 3);
  assert.equal(p.hasNext, false);
  assert.equal(p.hasPrev, true);
  // 人类修订 R3：固定 10 条/页（不再随视口收缩），桌面/移动一致
  assert.equal(PAGE_SIZE, 10);
});

test('FE-RLIST-13 miniBoardSvg：线/星/石数量与越界忽略', () => {
  const svg19 = miniBoardSvg(19, [{ x: 9, y: 9, color: 'black' }, { x: 999, y: -1, color: 'white' }], '-1');
  assert.equal((svg19.match(/<line /g) || []).length, 38); // 19 横 + 19 纵
  assert.equal((svg19.match(/<circle /g) || []).length, 11); // 9 星 + 1 石 ×2（石体 + 辉光叠加；越界白子忽略）
  assert.equal(svg19.includes('id="pb-1"'), true);
  assert.equal(svg19.includes('url(#pb-1)'), true);
  assert.equal(svg19.includes('url(#pw-1)'), false); // 越界白子不绘制
  assert.equal(svg19.includes('gradientUnits="userSpaceOnUse"'), true); // 辉光渐变
  assert.equal(svg19.includes('<feDropShadow '), true); // 外投影
  const svg9 = miniBoardSvg(9, [{ x: 4, y: 4, color: 'white' }], '-2');
  assert.equal((svg9.match(/<line /g) || []).length, 18);
  assert.ok(svg9.includes('url(#pw-2)'));
});

test('FE-RLIST-14 parseContentDispositionFilename：SGF 下载文件名', () => {
  assert.equal(parseContentDispositionFilename('attachment; filename="game_12.sgf"', 'game_12.sgf'), 'game_12.sgf');
  assert.equal(parseContentDispositionFilename("attachment; filename*=UTF-8''%E5%AF%B9%E5%B1%80.sgf", 'x.sgf'), '对局.sgf');
  assert.equal(parseContentDispositionFilename('', 'game_1.sgf'), 'game_1.sgf');
});

test('FE-RLIST-15 rowHTML / previewHTML：转义与关键属性', () => {
  const row = deriveRow(makeGame({ black_name: '张<script>' }), { now: NOW });
  const html = rowHTML({ ...row, fav: true });
  assert.equal(html.includes('<script>'), false);
  assert.ok(html.includes('张&lt;script&gt;'));
  assert.ok(html.includes('data-act="fav"'));
  assert.ok(html.includes('aria-pressed="true"'));
  assert.ok(html.includes('title="对局进行中，不可删除"') === false, 'finished 行删除不禁');
  const activeHtml = rowHTML({ ...deriveRow(makeGame({ status: 'active' }), { now: NOW }), fav: false });
  assert.ok(activeHtml.includes('disabled'));
  const ph = previewHTML({ ...derivePreview({ ...makeGame({ analysis_complete: false }), moves: [] }) });
  assert.ok(!ph.includes('data-act="report"'));
  // 2026/09/13 人工反馈：删除「选中对局预览」文案（空态也仅保留提示行）
  assert.equal(previewHTML({ kind: 'empty' }).includes('选中对局预览'), false);
  assert.ok(previewHTML({ kind: 'empty' }).includes('从左侧选择一个对局查看缩略棋面'));
  assert.equal(escapeHtml('<&>"'), '&lt;&amp;&gt;&quot;');
});

test('FE-RLIST-18 previewHTML：预览卡重排（玩家行在上/信息行在下）+ 主操作样式（2026/09/14）', () => {
  // 进行中局：玩家行在图上方；图下一行＝徽章 + 信息段；[续弈] 非 primary（2026/09/14 人工反馈）
  const active = derivePreview({ ...makeGame({ status: 'active', result: null }), moves: [] });
  const html = previewHTML(active);
  assert.equal(html.includes('选中对局预览'), false, '标题与图标已删除');
  assert.ok(html.indexOf('preview-players') < html.indexOf('preview-board'), '玩家行必须在预览图上方');
  assert.ok(html.includes('class="badge">#1</span>'), '信息行首位＝对局编号徽章（2026/09/21）');
  assert.equal(/class="badge[^"]*">(人人|人机)</.test(html), false, '预览卡不得再出现 人人/人机 徽章');
  assert.ok(html.includes('贴 7.5') && html.includes('分先') && html.includes('120 手'));
  assert.ok(html.indexOf('preview-board') < html.indexOf('preview-foot'), '信息行/按钮在图下方');
  assert.ok(/<div class="preview-foot">/.test(html) && html.includes('preview-info num'));
  assert.ok(html.includes('data-act="open"') && html.includes('>续弈</button>'));
  assert.ok(/class="btn btn-secondary"[^>]*data-act="open"/.test(html), '续弈不设为 primary');
  // 进行中局不带结果段（result 仅限已结束）
  assert.equal(html.includes('B+7.5'), false);
  // 人人局同样为编号徽章（模式已由玩家行表达）
  const human = previewHTML(derivePreview({ ...makeGame({ mode: 'human_human', result: null }), moves: [] }));
  assert.ok(human.includes('class="badge">#1</span>'));
  // 已结束：回放保持 primary + 信息行含结果原文
  const done = previewHTML(derivePreview({ ...makeGame(), moves: [] }));
  assert.ok(done.includes('B+7.5'));
  assert.ok(/class="btn btn-primary"[^>]*data-act="open"/.test(done), '回放保持 primary');
  // 列表行 [续弈] 同为非 primary，[回放] 保持 primary
  const rowHtml = rowHTML(deriveRow(makeGame({ status: 'active', result: null }), { now: NOW }));
  assert.ok(/class="btn btn-secondary btn-sm"[^>]*data-act="open"/.test(rowHtml), '列表行 [续弈] 非 primary');
  const doneRow = rowHTML(deriveRow(makeGame(), { now: NOW }));
  assert.ok(/class="btn btn-primary btn-sm"[^>]*data-act="open"/.test(doneRow), '列表行 [回放] 保持 primary');
});

test('FE-RLIST-16 previewHTML：桌面卡/移动抽屉卡 SVG 渐变 id 唯一（防重复 id → 棋子不显示）', () => {
  const p = derivePreview({ ...makeGame({ id: 51, analysis_complete: false }), moves: [] });
  const desktop = previewHTML(p);       // 桌面卡：ns 缺省 → pb-51 / pw-51
  const drawer = previewHTML(p, 'd');   // 移动抽屉卡：ns=d → pb-51-d / pw-51-d
  assert.ok(desktop.includes('id="pb-51"'));
  assert.ok(desktop.includes('id="pw-51"'));
  assert.equal(desktop.includes('pb-51-d'), false);
  assert.ok(drawer.includes('id="pb-51-d"'));
  assert.ok(drawer.includes('id="pw-51-d"'));
  assert.equal(drawer.includes('id="pb-51"'), false);
});

test('FE-RLIST-17 retainListAction：加载中且已有行 → 保留旧列表（防塌缩闪烁 BUG-061）', () => {
  // 切换状态 tab/筛选/搜索/分页的等待期：已有行 → 保留（叠忙碌遮罩），不得换矮 loading 块
  assert.equal(retainListAction({ loading: true, hasRows: true }), 'keep');
  // 首次加载（无行可保留）→ 照常 loading 块
  assert.equal(retainListAction({ loading: true, hasRows: false }), 'replace');
  // 就绪/错误/空态渲染 → 正常替换（同时清除忙碌态）
  assert.equal(retainListAction({ loading: false, hasRows: true }), 'replace');
  assert.equal(retainListAction({}), 'replace');
});

test('FE-RLIST-19 deriveRow：结算中对局文案＝`结算中 · 第 N 手`（与进行中区分，2026/09/19 人工口径）', () => {
  const scoring = deriveRow(
    makeGame({ status: 'scoring', result: null, last_move_no: 88 }),
    { now: NOW },
  );
  assert.equal(scoring.statusText, '结算中 · 第 88 手');
  assert.equal(scoring.finished, false);
  assert.equal(scoring.canDelete, false); // 结算中不可删除（W-16 同进行中）
  assert.equal(scoring.primary.label, '续弈');
  // 对照：进行中/未开局文案不变
  assert.equal(deriveRow(makeGame({ status: 'active', result: null, last_move_no: 34 }), { now: NOW }).statusText, '进行中 · 第 34 手');
  assert.equal(deriveRow(makeGame({ status: 'created', result: null, last_move_no: 0 }), { now: NOW }).statusText, '进行中 · 尚未开局');
});

test('FE-RLIST-20 listStateFromQuery / listQueryFromState：URL 状态互逆与非法值归一（2026/09/19）', () => {
  // 缺省/空 → 全默认
  assert.deepEqual(listStateFromQuery({}), { tab: 'all', favOnly: false, q: '', page: 1 });
  assert.deepEqual(listStateFromQuery(), { tab: 'all', favOnly: false, q: '', page: 1 });
  // 合法回读（query 值均为字符串）
  assert.deepEqual(
    listStateFromQuery({ tab: 'finished', fav: '1', q: '张三', page: '3' }),
    { tab: 'finished', favOnly: true, q: '张三', page: 3 },
  );
  // 非法值归一（未知 tab / fav≠1 / q 非字符串 / page 非正整数）
  assert.deepEqual(
    listStateFromQuery({ tab: 'bogus', fav: '0', q: 42, page: 'x' }),
    { tab: 'all', favOnly: false, q: '', page: 1 },
  );
  assert.deepEqual(listStateFromQuery({ page: '0' }).page, 1);
  // 默认值一律省略（不污染 URL）
  assert.deepEqual(listQueryFromState({ tab: 'all', favOnly: false, q: '', page: 1 }), {});
  assert.deepEqual(listQueryFromState({}), {});
  // 非默认值输出 + 搜索裁剪
  assert.deepEqual(
    listQueryFromState({ tab: 'active', favOnly: true, q: ' 李四 ', page: 2 }),
    { tab: 'active', fav: '1', q: '李四', page: '2' },
  );
  // 互逆：状态 → query → 状态
  const st = { tab: 'finished', favOnly: true, q: '王', page: 4 };
  assert.deepEqual(listStateFromQuery(listQueryFromState(st)), st);
});

test('FE-RLIST-21 URL 同步 + 行键盘选中：接线守门（源码，2026/09/19 人工决策）', () => {
  const src = readFileSync(
    path.join(import.meta.dirname, '..', 'static', 'js', 'views', 'review-list-view.js'),
    'utf8',
  );
  // URL 状态：变更经 replaceState 回写（不触发 hashchange → 不重挂视图）
  assert.match(src, /history\.replaceState\(null, '', hash\)/);
  assert.match(src, /buildHash\('review-list'/, 'URL 构建必须走 buildHash 纯函数');
  assert.match(src, /const initial = listStateFromQuery\(props\.route/, '初始筛选状态必须回读路由 query');
  // 键盘选中：focusin 路径 + :focus-visible 门控（鼠标点按钮不得误选）
  assert.match(src, /rootEl\.addEventListener\('focusin', onRootFocusin\)/);
  assert.match(src, /t\.matches\(':focus-visible'\)/);
});
