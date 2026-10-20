/**
 * tGo · T6.3 创建对局向导纯函数无头单测（node --test）
 * 用例 ID: FE-CREATE-*
 * 覆盖：常量、段位↔难度映射、载荷构建（人机/人人/自适应/让子/执色）、校验、
 *       预填序列化/规范化、快速开始、档案联想、缩略棋盘 SVG、预览文案。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RANKS,
  RULE_KOMI,
  engineModeAllowed,
  rankIndex,
  rankOfLevel,
  levelRankText,
  rulesKomi,
  initialForm,
  humanPlayer,
  derivePayload,
  validateForm,
  firstErrorField,
  HUMAN_MODEL_HINT_TEXT,
  HUMAN_MODEL_REJECT_MARK,
  serializePrefill,
  normalizePrefill,
  quickStartForm,
  matchPlayers,
  tinyBoardSVG,
  previewText,
  previewPlayers,
  playerText,
  handicapOptions,
} from '../static/js/views/create-wizard.js';

test('FE-CREATE-01 常量与映射：12 档段位顺序与规则贴目', () => {
  assert.equal(RANKS.length, 12);
  assert.equal(RANKS[0], 'rank_20k');
  assert.equal(RANKS[11], 'rank_9d');
  assert.deepEqual(RULE_KOMI, { chinese: 7.5, japanese: 6.5, aga: 7.5 });
});

test('FE-CREATE-02 段位↔难度档位映射', () => {
  assert.equal(rankIndex('rank_20k'), 1);
  assert.equal(rankIndex('rank_5k'), 5);
  assert.equal(rankIndex('rank_9d'), 12);
  assert.equal(rankIndex(null), null);
  assert.equal(rankIndex('rank_xxx'), null);
  assert.equal(rankOfLevel(1), 'rank_20k');
  assert.equal(rankOfLevel(8), 'rank_1d');
  assert.equal(rankOfLevel(99), 'rank_9d'); // 越界钳制
  assert.equal(rankOfLevel(0), 'rank_20k');
});

test('FE-CREATE-03 难度档位短标与规则默认贴目', () => {
  assert.equal(levelRankText(1), '20K');
  assert.equal(levelRankText(5), '5K');
  assert.equal(levelRankText(8), '1D');
  assert.equal(levelRankText(12), '9D');
  assert.equal(levelRankText(13), '—');
  assert.equal(levelRankText('abc'), '—');
  assert.equal(rulesKomi('japanese'), 6.5);
  assert.equal(rulesKomi('chinese'), 7.5);
  assert.equal(rulesKomi('nope'), 7.5); // 未知回退中国默认
});

test('FE-CREATE-04 引擎态 → 人机可选（仅 DEAD/FATAL 禁）', () => {
  assert.equal(engineModeAllowed('STOPPED'), true);
  assert.equal(engineModeAllowed('INIT'), true);
  assert.equal(engineModeAllowed('IDLE'), true);
  assert.equal(engineModeAllowed('ANALYZING'), true);
  assert.equal(engineModeAllowed(null), true);
  assert.equal(engineModeAllowed('DEAD'), false);
  assert.equal(engineModeAllowed('FATAL'), false);
});

test('FE-CREATE-05 载荷构建：人机标准难度（含等级与贴目）', () => {
  const form = {
    ...initialForm(),
    mode: 'human_ai',
    humanColor: 'black',
    style: 'standard',
    level: 7,
    blackName: '张三',
    blackRank: 'rank_1k',
    komi: 7.5,
  };
  const p = derivePayload(form);
  assert.equal(p.mode, 'human_ai');
  assert.equal(p.board_size, 19);
  assert.equal(p.color, 'B');
  assert.equal(p.handicap, 0);
  assert.equal(p.komi, 7.5);
  assert.deepEqual(p.black, { name: '张三', rank: 'rank_1k' });
  assert.deepEqual(p.white, { name: null, rank: null });
  // 录段位 → 自动匹配档（rank_1k = 7）
  assert.deepEqual(p.ai, { style: 'standard', adaptive: false, level: 7 });
});

test('FE-CREATE-06 载荷构建：人类执白 + 未录名默认 null + 让子锁定', () => {
  let form = {
    ...initialForm(),
    mode: 'human_ai',
    humanColor: 'white',
    whiteRank: 'rank_5k',
    komi: 6.5,
    handicap: 2,
  };
  let p = derivePayload(form);
  assert.equal(p.color, 'B'); // 让子强制人类执黑
  assert.equal(p.komi, 0); // 让子贴 0
  assert.equal(p.handicap, 2);
  assert.deepEqual(p.black, { name: null, rank: null });
  assert.equal(p.ai.level, 5); // 白方（执子方）段位匹配

  form = { ...initialForm(), mode: 'human_ai', humanColor: 'white', whiteName: '李四', style: 'standard', level: 3 };
  p = derivePayload(form);
  assert.equal(p.color, 'W');
  assert.equal(p.white.name, '李四');
});

test('FE-CREATE-07 载荷构建：自适应 = 人类风格 + adaptive（不带 level）', () => {
  const p = derivePayload({ ...initialForm(), mode: 'human_ai', style: 'adaptive', blackRank: 'rank_3k', level: 5 });
  assert.deepEqual(p.ai, { style: 'human', adaptive: true });
  // 人人：省略 ai 与 color
  const pvp = derivePayload({ ...initialForm(), mode: 'human_human', blackName: '甲', whiteName: '乙' });
  assert.equal('ai' in pvp, false);
  assert.equal('color' in pvp, false);
  assert.equal(pvp.black.name, '甲');
  assert.equal(pvp.white.name, '乙');
});

test('FE-CREATE-08 校验：引擎/人类模型门控与贴目/姓名', () => {
  const base = initialForm();
  // 引擎不可用 + 人机
  const e = validateForm({ ...base, mode: 'human_ai' }, { engineAvailable: false });
  assert.ok(e.mode);
  // 人类风格/自适应需要人类模型（文案＝统一下降级说明，2026/09/18 人工口径）
  assert.equal(
    validateForm({ ...base, mode: 'human_ai', style: 'human' }, { humanModelAvailable: false }).style,
    HUMAN_MODEL_HINT_TEXT,
  );
  assert.equal(
    validateForm({ ...base, mode: 'human_ai', style: 'adaptive' }, { humanModelAvailable: false }).style,
    HUMAN_MODEL_HINT_TEXT,
  );
  assert.deepEqual(validateForm({ ...base, mode: 'human_ai', style: 'standard' }, { humanModelAvailable: false }), {});
  // 服务端同条件拒绝文案的识别片段：必须仍是后端 INVALID_PAYLOAD 文案的子串
  // （提交被拒 → 改走 toast 的判定依据；后端文案变更须同步本常量，2026/09/18）
  assert.ok(
    '人类模型不可用：仅标准风格可用（人类模型缺失降级）'.includes(HUMAN_MODEL_REJECT_MARK),
    'HUMAN_MODEL_REJECT_MARK 必须是服务端拒绝文案的识别片段',
  );
  // 人人不需要引擎/人类模型/难度
  assert.deepEqual(validateForm({ ...base, mode: 'human_human' }, { engineAvailable: false, humanModelAvailable: false }), {});
  // 非法贴目 / 超长姓名
  assert.ok(validateForm({ ...base, komi: -1 }).komi);
  assert.ok(validateForm({ ...base, komi: 'abc' }).komi);
  assert.ok(validateForm({ ...base, blackName: 'x'.repeat(65) }).blackName);
  // 合法（默认档位在）
  assert.deepEqual(validateForm(base, {}), {});
});

test('FE-CREATE-09 校验：固定难度必有档位 / 自适应无需档位', () => {
  const base = initialForm();
  const noRankHuman = { ...base, mode: 'human_ai', style: 'standard', level: 4 };
  assert.deepEqual(validateForm(noRankHuman, {}), {}); // 滑杆档位兜底
  const noRankHumanAdaptive = { ...base, mode: 'human_ai', style: 'adaptive' };
  assert.deepEqual(validateForm(noRankHumanAdaptive, { humanModelAvailable: true }), {});
});

test('FE-CREATE-10 首错字段顺序（用于焦点跳转）', () => {
  const errs = { coaching: 'x', blackName: 'y', komi: 'z' };
  assert.equal(firstErrorField(errs), 'blackName');
  assert.equal(firstErrorField({ mode: 'x' }), 'mode');
  assert.equal(firstErrorField({}), null);
  assert.equal(firstErrorField({ unknown: 'x' }), 'unknown');
});

test('FE-CREATE-11 预填序列化/规范化（往返 + 脏数据容错）', () => {
  const form = { ...initialForm(), mode: 'human_human', rules: 'japanese', komi: 6.5, handicap: 3, blackName: '张三', blackRank: 'rank_5k', whiteName: '李四', coaching: true, style: 'human', level: 9 };
  const raw = serializePrefill(form);
  assert.deepEqual(normalizePrefill(raw, initialForm()), form);
  // 脏数据（越界/非法枚举/类型错）回退默认
  const n = normalizePrefill({ mode: 'bogus', boardSize: 99, rules: 'x', komi: -3, humanColor: 'red', style: 'evil', level: 99, handicap: 1, blackRank: 42, coaching: 'yes' }, initialForm());
  assert.equal(n.mode, 'human_ai');
  assert.equal(n.boardSize, 19);
  assert.equal(n.rules, 'chinese');
  assert.equal(n.komi, 7.5);
  assert.equal(n.humanColor, 'black');
  assert.equal(n.style, 'standard');
  assert.equal(n.level, 12); // clamp 上限
  assert.equal(n.handicap, 0);
  assert.equal(n.blackRank, null);
  assert.equal(n.coaching, true); // Boolean('yes')
  // null → fallback
  assert.equal(normalizePrefill(null, form), form);
});

test('FE-CREATE-12 快速开始（W-25：自适应 + 默认参数 + 分先/点评关）', () => {
  const base = { ...initialForm(), mode: 'human_ai', blackName: '小宇', blackRank: 'rank_10k', humanColor: 'black', coaching: true, handicap: 2, boardSize: 9, rules: 'japanese', komi: 6.5 };
  const q = quickStartForm(base);
  // 重置为默认：19/中国/7.5/执黑/分先/点评关，AI 自适应
  assert.equal(q.style, 'adaptive');
  assert.equal(q.mode, 'human_ai');
  assert.equal(q.boardSize, 19);
  assert.equal(q.rules, 'chinese');
  assert.equal(q.komi, 7.5);
  assert.equal(q.handicap, 0);
  assert.equal(q.coaching, false);
  assert.equal(q.humanColor, 'black');
  // 执黑侧档案保留（执子方 = 黑）
  assert.equal(q.blackName, '小宇');
  assert.equal(q.blackRank, 'rank_10k');
  // 人类执白：保留白方档案并仍为白（自适应初始水平取执子方）
  const w = quickStartForm({ ...initialForm(), mode: 'human_ai', humanColor: 'white', whiteName: '阿白', whiteRank: 'rank_3k', blackName: 'AI' });
  assert.equal(w.humanColor, 'white');
  assert.equal(w.whiteName, '阿白');
  assert.equal(w.blackName, '');
  // 默认兜底
  const q2 = quickStartForm(initialForm());
  assert.equal(q2.komi, 7.5);
  assert.equal(q2.humanColor, 'black');
});

test('FE-CREATE-13 档案联想过滤（模糊 + 默认上限 5 + 空 query 首段）', () => {
  const players = [
    { name: '张三', rank: 'rank_5k' },
    { name: '张三丰', rank: 'rank_1d' },
    { name: '李四', rank: 'rank_8k' },
    { name: '王五', rank: 'rank_3k' },
  ];
  assert.deepEqual(matchPlayers(players, '张'), [{ name: '张三', rank: 'rank_5k' }, { name: '张三丰', rank: 'rank_1d' }]);
  assert.equal(matchPlayers(players, '李').length, 1);
  assert.equal(matchPlayers(players, '').length, 4);
  assert.equal(matchPlayers(players, '张', 1).length, 1);
  assert.deepEqual(matchPlayers(null, 'x'), []);
  assert.equal(matchPlayers(players, '不存在').length, 0);
  // 下拉条数上限（2026/09/19 人工反馈「限定最大 5 条下拉」）：空 query 与模糊匹配一致，取前 5（保服务端顺序）
  const many = Array.from({ length: 7 }, (_, i) => ({ name: `棋手${i}`, rank: 'rank_5k' }));
  assert.equal(matchPlayers(many, '').length, 5);
  assert.equal(matchPlayers(many, '棋手').length, 5);
  assert.equal(matchPlayers(many, '').at(-1).name, '棋手4');
});

test('FE-CREATE-14 缩略棋盘 SVG（19/13/9 网格与星位）', () => {
  for (const size of [19, 13, 9]) {
    const svg = tinyBoardSVG(size);
    assert.match(svg, /<svg/);
    assert.match(svg, new RegExp(`${size} 路棋盘预览`));
    // 19 路：20 条 path（横 19 + 纵 19 分组拼接也可用数量断言：19 路共有 19 条线路径段）
    assert.ok(svg.includes('<path'));
    assert.ok(svg.includes('<circle'));
  }
  assert.equal(tinyBoardSVG(19).includes('9'), true);
});

test('FE-CREATE-15 预览文案（棋盘/规则/让子；执色不参与）', () => {
  const base = initialForm();
  assert.equal(previewText(base), '19 路 · 中国 · 贴 7.5 · 分先');
  // 执色/模式不参与步骤 2 文案（2026/09/15 调整：改由第一页信息行 previewPlayers 呈现）
  const w = { ...base, mode: 'human_ai', humanColor: 'white', rules: 'japanese', komi: 6.5 };
  assert.equal(previewText(w), '19 路 · 日本 · 贴 6.5 · 分先');
  const h = { ...base, rules: 'chinese', handicap: 3 };
  assert.equal(previewText(h), '19 路 · 中国 · 贴 0 · 让 3 子');
  const pvp9 = { ...base, mode: 'human_human', boardSize: 9 };
  assert.equal(previewText(pvp9), '9 路 · 中国 · 贴 7.5 · 分先');
});

test('FE-CREATE-16 humanPlayer：按执色取执子方', () => {
  const form = { ...initialForm(), mode: 'human_ai', humanColor: 'white', whiteName: '李四', whiteRank: 'rank_3k', blackName: 'AI', blackRank: null };
  assert.deepEqual(humanPlayer(form), { name: '李四', rank: 'rank_3k' });
  const b = { ...form, humanColor: 'black' };
  assert.deepEqual(humanPlayer(b), { name: 'AI', rank: null });
});

test('FE-CREATE-17 预览第一页信息行：棋手/模式（含默认真人与 AI 风格/难度）', () => {
  const base = initialForm();
  assert.equal(previewPlayers({ ...base, mode: 'human_ai', humanColor: 'black', blackName: '张三', blackRank: 'rank_5k', style: 'adaptive' }), '人机 · 黑 张三 5K vs AI（自适应）');
  // 固定难度（2026/09/15）：预览追加 AI 方难度档位（默认档 4 = 8K）
  assert.equal(previewPlayers({ ...base, mode: 'human_ai', humanColor: 'white', whiteName: '', style: 'human' }), '人机 · 白 真人 vs AI 8K（人类）');
  assert.equal(previewPlayers({ ...base, level: 9 }), '人机 · 黑 真人 vs AI 3D（标准）');
  assert.equal(previewPlayers({ ...base, mode: 'human_human', blackName: '甲', blackRank: 'rank_1d', whiteName: '乙' }), '人人 · 黑 甲 1D vs 白 乙');
  assert.equal(previewPlayers({ ...base, mode: 'human_human' }), '人人 · 黑 真人 vs 白 真人');
  // playerText 兜底
  assert.equal(playerText(null), '真人');
  assert.equal(playerText({ name: '王五' }), '王五');
  assert.equal(playerText({ name: '王五', rank: 'rank_9d' }), '王五 9D');
});

test('FE-CREATE-18 让子选项与预填钳制（BUG-049：9/13 路不得给出非法让子数）', () => {
  // 选项按尺寸上限：19 路 0,2..9；13 路 0,2..6；9 路 0,2..4
  assert.deepEqual(handicapOptions(19), [0, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(handicapOptions(13), [0, 2, 3, 4, 5, 6]);
  assert.deepEqual(handicapOptions(9), [0, 2, 3, 4]);
  // 预填越界组合钳制到该尺寸上限（旧版本持久化残留）
  const clamped = normalizePrefill({ boardSize: 9, handicap: 9 }, initialForm());
  assert.equal(clamped.handicap, 4);
  const clamped13 = normalizePrefill({ boardSize: 13, handicap: 8 }, initialForm());
  assert.equal(clamped13.handicap, 6);
  // 上限内保持原值
  assert.equal(normalizePrefill({ boardSize: 9, handicap: 2 }, initialForm()).handicap, 2);
});
