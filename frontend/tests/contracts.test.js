/**
 * tGo · 跨层契约守门用例（node --test，无头）
 * 用例 ID: FE-CTR-*
 *
 * 背景（2026/09/11 人工反馈两个缺陷，均属“契约无人守门”）：
 *   1. `scoring.prediction`/`analysis.comment` 后端已推送，但 `ws-client.js` 的
 *      入站白名单未登记 → 消息被静默丢弃（结算面板永久停在“AI 正在分析终局局面”）。
 *   2. `turning_points[].delta_winrate` 后端输出改为百分比后，报告弹层仍 ×100
 *      → 显示 `ΔW −690%`（重复换算）。
 *
 * 本文件把两条约定固化为可回归的断言：
 *   - FE-CTR-01：`docs/API.md` §4.3/§4.4 声明的**每个服务端推送类型**都必须被
 *     ws-client 识别（登记 SERVER_MESSAGE_TYPES，且不落入 `onUnknown`）。
 *   - FE-CTR-02：winrate 百分比换算**唯一位置＝后端输出边界**；前端视图层
 *     不得再次 ×100（源码守卫，防“重复换算”复发）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';

import { SERVER_MESSAGE_TYPES, createWsClient } from '../static/js/core/ws-client.js';
import {
  ENGINE_LAUNCHABLE_STATES,
  ENGINE_QUERY_STATES,
  ENGINE_RUNNING_STATES,
} from '../static/js/core/engine-state.js';
import { NAV_ITEMS, ROUTES } from '../static/js/core/route.js';

const ROOT = path.join(import.meta.dirname, '..', '..'); // 仓库根
const JS_DIR = path.join(import.meta.dirname, '..', 'static', 'js');

/* ---------- 契约 1：后端推送类型 ↔ ws-client 登记 ---------- */

/** 解析 docs/API.md 中“服务端 → 客户端”/管理通道推送表的首列类型名。
 *
 * 仅取**标题本身**匹配的小节（避免正文提及“服务端 → 客户端”时误收错误码表等表格）。
 */
function documentedServerTypes(markdown) {
  const types = new Set();
  const chunks = markdown.split(/^(?=#{2,6} )/m); // 按任意级标题切分（标题与其正文同块）
  for (const chunk of chunks) {
    const [heading = ''] = chunk.split('\n', 1);
    if (!/服务端 → 客户端|管理通道/.test(heading)) continue;
    for (const line of chunk.split('\n')) {
      const m = /^\|\s*`?([a-z_]+(?:\.[a-z_]+)*)`?\s*\|/.exec(line);
      if (m && m[1] !== 'type') types.add(m[1]);
    }
  }
  return types;
}

function apiDoc() {
  return readFileSync(path.join(ROOT, 'docs', 'API.md'), 'utf8');
}

test('FE-CTR-01 | docs/API.md 声明的服务端推送类型全部被 ws-client 识别（不落 onUnknown）', () => {
  const documented = documentedServerTypes(apiDoc());
  assert.ok(documented.size >= 15, `解析到推送类型过少（${documented.size}），文档结构可能已变化`);

  // 1) 文档类型必须全部登记在 SERVER_MESSAGE_TYPES（漏登记即回归）
  const registered = new Set(SERVER_MESSAGE_TYPES);
  const missing = [...documented].filter((t) => !registered.has(t));
  assert.deepEqual(missing, [], `未登记的服务端消息类型: ${missing.join(', ')}`);

  // 2) 路由行为：逐类型投递，除 control/error/pong 外均不得落入 onUnknown
  const ignored = new Set(['undo.request', 'undo.declined', 'error', 'pong']);
  const unknown = [];
  const dispatched = [];
  const env = fakeEnv();
  const client = createWsClient({
    url: 'ws://x/ws/games/1',
    role: 'game',
    createSocket: env.factory,
    dispatch: (m) => dispatched.push(m),
    onError: () => {},
    onControl: () => {},
    onUnknown: (e) => unknown.push(e.type),
  });
  client.connect();
  env.last()._open();
  for (const type of documented) {
    env.last()._msg({ type, seq: 1, data: { game_id: 1, move_no: 1 } });
  }
  client.close();
  assert.deepEqual(unknown.filter((t) => !ignored.has(t)), [], '存在被静默丢弃的服务端消息类型');
  assert.ok(
    dispatched.some((m) => m.type === 'analysis.comment')
    && dispatched.some((m) => m.type === 'scoring.prediction'),
    'analysis.comment / scoring.prediction 必须进入状态树分发',
  );
});

/* ---------- 契约 2：winrate 换算唯一位置（前端不得重复换算） ---------- */

function walkJs(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walkJs(full));
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

test('FE-CTR-02 | 视图层禁止 ×100/winrateToPercent：换算唯一位置＝后端输出边界（+ core/fmt.js）', () => {
  const files = walkJs(JS_DIR);
  const offenders = [];
  for (const file of files) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    if (!rel.startsWith('frontend/static/js/views/')) continue; // 仅约束视图层
    const text = readFileSync(file, 'utf8');
    for (const line of text.split('\n')) {
      // 视图层禁止自做百分比换算（含 winrate 二次换算 → `ΔW −690%` 回归）：
      // 需换算请用 core/fmt.js 的 winrateToPercent / fractionToPercent
      if (/\*\s*100\b/.test(line)) offenders.push(`${rel}: ${line.trim()}`);
      if (/\bwinrateToPercent\b/.test(line)) offenders.push(`${rel}: ${line.trim()}`);
    }
  }
  assert.deepEqual(offenders, [], `视图层出现换算（×100 / winrateToPercent）：\n${offenders.join('\n')}`);
});

/* ---------- 契约 3：订阅回调禁止二次派发服务端消息（防无限递归） ---------- */

test('FE-CTR-03 | 视图层禁止二次派发 position.ownership（订阅内重派发 → 栈溢出且热力永不上屏，BUG-041）', () => {
  // 根因回顾：WS 消息已由壳（app.js hub dispatch）写入状态树；视图若在
  // `onStoreChange` 里对同类消息再 `store.dispatch`，reducer 每次返回新引用 →
  // 订阅回调 → 再派发……无限递归（`[state] listener 异常：Maximum call stack
  // size exceeded`），且派发后的视图副作用永不执行（领地热力不落画布）。
  const files = walkJs(path.join(JS_DIR, 'views'));
  const offenders = [];
  for (const file of files) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    const text = readFileSync(file, 'utf8');
    if (/store\.dispatch\([^)]*type:\s*'position\.ownership'/.test(text)) offenders.push(rel);
  }
  assert.deepEqual(offenders, [], `视图层二次派发 position.ownership：\n${offenders.join('\n')}`);
});

/* ---------- 契约 4：DOM 重建必须由状态派生（防“圆点被抹掉”类缺陷复发） ---------- */

/** 截取指定顶层函数体（`  function name(` 到下一个同缩进 `  function `）。 */
function functionBody(text, name) {
  const start = text.indexOf(`  function ${name}(`);
  assert.notEqual(start, -1, `未找到函数 ${name}`);
  const rest = text.slice(start + 1);
  const next = rest.indexOf('\n  function ');
  return next === -1 ? rest : rest.slice(0, next);
}

test('FE-CTR-04 | 复盘底部按钮重建（renderActions）的领地开启态必须由状态派生（BUG-045：下一手后指示被抹掉）', () => {
  // 根因回顾：`renderActions` 全量重建按钮 DOM 时把开启指示写死为隐藏态（旧实现是连续模式
  // 的 `u-hide` 圆点），且不重新应用领地状态 → 任何触发重建的操作（下一手/布局断点/WS 消息）
  // 都会抹掉指示，而 `territory.auto` 实际仍为 true（视图与状态不一致）。
  // 2026/09/17：指示载体＝主题色填充 + 图标点亮 + 连续呼吸（is-lit/is-fill/breathe），
  // 由 `territoryButtonClassString` 派生（内部即 territoryButtonClasses → territoryButtonView）。
  const text = readFileSync(path.join(JS_DIR, 'views', 'review-view.js'), 'utf8');
  const body = functionBody(text, 'renderActions');
  assert.match(
    body,
    /territoryButtonClassString\(/,
    'renderActions 必须以 territoryButtonClassString(state) 派生领地按钮开启态，不得写死',
  );
});

/* ---------- 契约 5：顶栏导航高亮键（data-route ↔ navKeyOf 输出） ---------- */

test('FE-CTR-05 | 顶栏主导航 data-route 必须与 navKeyOf 输出一致（复盘 tab 高亮失效回归，2026/09/13）', () => {
  // 根因回顾：index.html 曾写 data-route="review-list"，而 navKeyOf('review-list')
  // 输出 'review' → app.js 里 `anchor.dataset.route === navKey` 恒为 false，
  // [复盘] tab 永不点亮（非 accent 色 / 非加粗）。
  const html = readFileSync(path.join(JS_DIR, '..', 'index.html'), 'utf8');
  const nav = /<nav class="main"[\s\S]*?<\/nav>/.exec(html);
  assert.ok(nav, 'index.html 未找到顶栏主导航');
  const domKeys = [...nav[0].matchAll(/data-route="([^"]+)"/g)].map((m) => m[1]);
  const navKeys = [...new Set(ROUTES.filter((r) => r.nav).map((r) => r.nav))];
  assert.deepEqual(domKeys, navKeys, 'data-route 与 navKeyOf() 输出不一致 → tab 高亮失效');
  for (const item of NAV_ITEMS) {
    assert.ok(navKeys.includes(item.key), `NAV_ITEMS.key 不在导航键集合：${item.key}`);
  }
});

/* ---------- 契约 6：点评气泡统一（对弈/复盘同一实现） ---------- */

test('FE-CTR-06 | 点评气泡统一为 .board-bubble（复盘禁止回退到 .rv-bubble 横幅，2026/09/13）', () => {
  // 人工口径：复盘页点击棋子点评＝对弈页同款棋子附近气泡；结构/定位经
  // core/comment-bubble.js 共用内核，样式只允许 .board-bubble。
  const js = readFileSync(path.join(JS_DIR, 'views', 'review-view.js'), 'utf8');
  assert.ok(
    js.includes('commentBubbleHTML(') && js.includes('boardBubblePlacement('),
    '复盘气泡必须经 core/comment-bubble.js 共用内核渲染/定位',
  );
  const css = readFileSync(path.join(JS_DIR, '..', 'css', 'app.css'), 'utf8');
  assert.equal(/\.rv-bubble\b/.test(css), false, '.rv-bubble 应为历史样式（两页统一 .board-bubble）');
});

/* ---------- 契约 7：Logo / 背景 SVG 主题适配（iOS 不得依赖 SVG 内 prefers-color-scheme） ---------- */

test('FE-CTR-07 | Logo/背景 SVG 主题双文件 + data-theme 选文件（四资产一律固定色板，2026/09/13）', () => {
  // 根因（BUG-068 复核后修订）：SVG-as-image 内的 prefers-color-scheme 在 iOS Safari 按**系统**
  // （而非应用主题）评估 → 浅色文件会被系统深色反色（「应用浅色 + 系统深色」错误）；
  // 故四个资产一律固定色板，由 app.css 按 data-theme 选切，彻底移除自适应块。
  const staticDir = path.join(JS_DIR, '..');
  for (const f of ['title.svg', 'title-dark.svg', 'background.svg', 'background-dark.svg']) {
    assert.ok(existsSync(path.join(staticDir, f)), `缺少主题资产：${f}`);
  }
  for (const f of ['title.svg', 'title-dark.svg', 'background.svg', 'background-dark.svg']) {
    const text = readFileSync(path.join(staticDir, f), 'utf8');
    assert.equal(
      /@media[^{]*prefers-color-scheme/.test(text),
      false,
      `${f} 必须是固定色板（不得声明 prefers-color-scheme 媒体查询）`,
    );
  }
  const css = readFileSync(path.join(staticDir, 'css', 'app.css'), 'utf8');
  assert.match(css, /html\[data-theme="dark"\] \.brand \.brand-logo \{[^}]*title-dark\.svg/s);
  assert.match(css, /html\[data-theme="dark"\] body\.tgo-decor::before \{[^}]*background-dark\.svg/s);
  const html = readFileSync(path.join(staticDir, 'index.html'), 'utf8');
  assert.equal(/<img[^>]*brand-logo/.test(html), false, 'index.html 品牌 Logo 必须改为背景承载的 span');
  assert.match(html, /<span class="brand-logo"[^>]*role="img"/);
});

/* ---------- 契约 8：顶栏主题/静音图标切换动效 ---------- */

test('FE-CTR-08 | 顶栏主题/静音图标切换动效（is-icon-swap ↔ @keyframes icon-swap，2026/09/13）', () => {
  const css = readFileSync(path.join(JS_DIR, '..', 'css', 'app.css'), 'utf8');
  assert.match(css, /@keyframes icon-swap\s*\{/);
  assert.match(css, /\.icon-btn\.is-icon-swap \.icon\s*\{[^}]*animation:/s);
  const js = readFileSync(path.join(JS_DIR, 'app.js'), 'utf8');
  assert.match(js, /classList\.add\('is-icon-swap'\)/);
});

test('FE-CTR-09 | 主题按钮图标＝当前主题状态（浅=太阳 / 深=月亮 / 系统=i-theme-auto，2026/09/13）', () => {
  // 规格源：docs/UI_UX.md 顶栏主题按钮图标三态。曾反向实现为“点击后目标状态”（浅→月亮、
  // 深→太阳），被人工反馈修正；本断言防止回退到反向映射。
  const js = readFileSync(path.join(JS_DIR, 'app.js'), 'utf8');
  assert.match(
    js,
    /const icon = mode === 'system' \? 'i-theme-auto' : \(dark \? 'i-moon' : 'i-sun'\);/,
    '图标必须与当前主题一致：浅=太阳、深=月亮、系统=i-theme-auto',
  );
  assert.equal(/dark \? 'i-sun' : 'i-moon'/.test(js), false, '不得回退为“点击后目标状态”反向映射');
});

/* ---------- 契约 10：复盘来源登记 / 位置记忆 / 列表跨页定位（2026/09/14） ---------- */

test('FE-CTR-10 | 复盘定位与恢复契约：来源登记在复盘页（任何入口）+ focus_id 跨页定位 + 位置记忆', () => {
  // 2026/09/14 人工口径：① 返回定位覆盖所有进入复盘的入口（登记点在复盘页加载时，
  // 不在列表点击处——否则漏掉结算 [复盘]/报告 [回放该手]/直达 URL）；
  // ② 列表跨页定位由服务端 focus_id 计算（禁止回退为“仅当前页查找后选中首行”）；
  // ③ 位置记忆（tgo.review-pos）仅在复盘页主谱定位时写入（试下分支不参与）。
  const review = readFileSync(path.join(JS_DIR, 'views', 'review-view.js'), 'utf8');
  const list = readFileSync(path.join(JS_DIR, 'views', 'review-list-view.js'), 'utf8');
  assert.ok(
    review.includes('LS_KEYS.reviewSelect') && review.includes('LS_KEYS.reviewPos'),
    '复盘页必须登记来源对局（reviewSelect）并记忆显示手数（reviewPos）',
  );
  assert.ok(review.includes('resolveReviewTarget('), '进入定位必须经 resolveReviewTarget（at > 记录 > 末手）');
  assert.ok(list.includes('query.focus_id'), '列表必须携带 focus_id 请求服务端定位页码');
  assert.equal(
    /writeReviewSelect\s*\(/.test(list),
    false,
    '来源登记不得回退到列表点击处（会漏掉结算/报告/直达入口）',
  );
});

/* ---------- 契约 11：侧栏卡刷新 body-only（防嵌套卡） ---------- */

test('FE-CTR-11 | 侧栏信息卡刷新仅 body（防“毛玻璃层中的卡片层”嵌套卡，2026/09/14）', () => {
  // 根因（BUG-074）：对弈信息卡刷新曾把整卡 HTML setHtml 到既有 .card 元素内 → 内嵌第二层
  // .card（双 padding/边框/backdrop-filter）；复盘页用 body-only 模板故无此问题。
  // 口径：卡刷新只替换 body，完整卡 HTML 仅用于初始模板（FE-SB-21 锁函数层）。
  const game = readFileSync(path.join(JS_DIR, 'views', 'game-sidebar.js'), 'utf8');
  const review = readFileSync(path.join(JS_DIR, 'views', 'review-sidebar.js'), 'utf8');
  assert.ok(
    game.includes('setHtml(infoEl, infoCardBodyHTML('),
    '对弈信息卡刷新必须用 body-only HTML（infoCardBodyHTML）',
  );
  assert.ok(
    review.includes('setHtml(infoEl, reviewInfoBodyHTML('),
    '复盘信息卡刷新必须用 body-only HTML（reviewInfoBodyHTML）',
  );
  assert.equal(
    /setHtml\(infoEl, infoCardHTML\(/.test(game),
    false,
    '不得把整卡 HTML 写进既有 .card（会嵌套卡片层）',
  );
});

/* ---------- 契约 12：向导档案联想 + 点评气泡交互（2026/09/15 人工反馈） ---------- */

test('FE-CTR-12 | 向导联想项绑 pointerdown + 聚焦即出档案；点评气泡两行块级 + 空白/触摸/ESC 收起', () => {
  // 根因①（选中无效）：联想项仅绑 click，而输入框 blur 后 120ms 立即清空联想框——
  // 慢点击/触摸长按（mousedown→mouseup >120ms）时节点先被移除 → click 永不触发。
  // 根因②（无下拉）：仅 input 事件拉取联想，单击/聚焦输入框无反应。
  // 根因③（气泡过宽）：.b-line1/.b-line2 为行内 span → .b-text 的 max-content = 两行之和
  // （实测≈317px）→ 恒被 max-width 顶到 260px 上限。
  const wiz = readFileSync(path.join(JS_DIR, 'views', 'create-wizard.js'), 'utf8');
  assert.match(
    wiz,
    /addEventListener\('pointerdown',[\s\S]{0,240}?pickSuggestion\(/,
    '联想项选中必须绑 pointerdown（click 会被 blur 延迟清理抢先移除节点）',
  );
  assert.match(wiz, /addEventListener\('focus', showList\)/, '输入框聚焦必须展示历史档案下拉');
  assert.match(wiz, /addEventListener\('click', showList\)/, '单击输入框必须展示历史档案下拉');

  const css = readFileSync(path.join(JS_DIR, '..', 'css', 'app.css'), 'utf8');
  for (const line of ['b-line1', 'b-line2']) {
    assert.match(
      css,
      new RegExp(`\\.board-bubble \\.${line} \\{[^}]*display: block`),
      `.board-bubble .${line} 必须为块级（否则两行宽度被求和 → 气泡恒触 max-width 上限）`,
    );
  }

  // 空白处点击收起气泡（两页棋盘空点回调）
  const game = readFileSync(path.join(JS_DIR, 'views', 'game-view.js'), 'utf8');
  const review = readFileSync(path.join(JS_DIR, 'views', 'review-view.js'), 'utf8');
  assert.match(
    functionBody(game, 'tryPlay'),
    /clearCoachBubble\(\)/,
    '对弈页空交叉点点击（tryPlay）必须先收起点评气泡',
  );
  assert.match(
    functionBody(review, 'onBoardPoint'),
    /clearBubble\(\)/,
    '复盘页空交叉点点击（onBoardPoint）必须先收起点评气泡',
  );

  // 触摸单次轻点 / 键盘 ESC 收起（2026/09/15 二次反馈：触摸首点不落子、也不进 onIntersection）
  assert.match(
    game,
    /onBlankTap: \(\) => clearCoachBubble\(\)/,
    '对弈页必须把棋盘空白轻点（触摸首点/网格外）接到收起气泡',
  );
  assert.match(
    review,
    /onBlankTap: \(\) => clearBubble\(\)/,
    '复盘页必须把棋盘空白轻点（触摸首点/网格外）接到收起气泡',
  );
  const board = readFileSync(path.join(JS_DIR, 'core', 'board.js'), 'utf8');
  const touchBody = /_handleTouchTap\(evt\) \{([\s\S]*?)\n  \}/.exec(board);
  assert.ok(
    touchBody && /_emitBlankTap\(\)/.test(touchBody[1]),
    '触摸轻点空白必须在棋盘层通知宿主（onBlankTap；首点不落子也不进 onIntersection）',
  );
  assert.match(
    game,
    /self\._escKey = \(e\) => \{[\s\S]{0,240}?clearCoachBubble\(\)/,
    '对弈页 ESC（_escKey）必须收起点评气泡（与复盘页同口径）',
  );
});

/* ---------- 契约 13：空态插画↔四处空态 ---------- */

test('FE-CTR-13 | 空态插画统一为 #i-empty-go（4:3 画布 ↔ .art 尺寸），四处空态全部接入（2026/09/17）', () => {
  const icons = readFileSync(path.join(JS_DIR, 'icons.js'), 'utf8');
  assert.match(
    icons,
    /'i-empty-go': \{[^}]*viewBox: '0 0 120 90'/,
    'icons.js 必须定义空态插画 i-empty-go，且画布为 4:3（120×90）——与 .art 尺寸一致',
  );
  // 插画不是 24×24 图标：必须走对象形态（viewBox/body），不得被当成普通字符串图标
  assert.match(icons, /'i-empty-go': \{[^}]*body:/, 'i-empty-go 必须以 {viewBox, strokeWidth, body} 插画形态登记');

  const surfaces = [
    ['views/game-view.js', '对弈页空态'],
    ['views/review-view.js', '复盘页加载失败空态'],
    ['views/review-list-view.js', '棋谱列表空态'],
    ['app.js', '视图装载失败兜底'],
  ];
  for (const [file, label] of surfaces) {
    const text = readFileSync(path.join(JS_DIR, file), 'utf8');
    assert.match(
      text,
      /<svg class="art" aria-hidden="true"><use href="#i-empty-go"\/><\/svg>/,
      `${label}（${file}）必须使用空态插画（svg.art + #i-empty-go）`,
    );
  }

  const css = readFileSync(path.join(JS_DIR, '..', 'css', 'app.css'), 'utf8');
  assert.match(css, /\.empty-state \.art \{[^}]*width: 120px; height: 90px/, '.empty-state .art 尺寸必须与插画画布一致');
  assert.match(css, /\.rl-state \.art \{[^}]*width: 120px; height: 90px/, '.rl-state .art（列表空态）尺寸必须与插画画布一致');
});

/* ---------- 契约 14：引擎胶囊圆点呼吸动画（PROMPTS L952，2026/09/17 人工口径） ---------- */

test('FE-CTR-14 | 三态圆点呼吸（本体脉动＋晕影扩散渐隐）与调优中圆点 s-tune（琥珀）', () => {
  const css = readFileSync(path.join(JS_DIR, '..', 'css', 'app.css'), 'utf8');
  assert.match(
    css,
    /\.dot\.s-tune \{[^}]*background: var\(--eng-init\)/,
    '调优中圆点（s-tune）必须为琥珀色（同加载中状态色）',
  );
  // 未启动（STOPPED）：中性灰 token，且不得呼吸（进程未运行，非进行态）
  assert.match(css, /\.dot\.s-off \{[^}]*background: var\(--eng-off\)/, '未启动圆点（s-off）必须用 --eng-off');
  assert.doesNotMatch(
    css,
    /\.dot\.s-off[^{]*\{[^}]*animation:/,
    '未启动圆点不得带呼吸/晕影动画',
  );
  for (const cls of ['s-init', 's-tune', 's-busy']) {
    assert.match(
      css,
      new RegExp(`\\.dot\\.${cls}[^{]*\\{[^}]*animation: engPillBreath`),
      `${cls} 圆点必须呼吸（本体亮度脉动）`,
    );
    assert.match(
      css,
      new RegExp(`\\.dot\\.${cls}[^{]*::after`),
      `${cls} 圆点必须带晕影层（::after）`,
    );
  }
  assert.match(css, /@keyframes engPillBreath/, '必须定义圆点脉动关键帧');
  assert.match(
    css,
    /@keyframes engPillHalo \{[\s\S]*?transform: scale\(2\.4\)[\s\S]*?opacity: 0/,
    '晕影必须向外扩散（scale）并渐隐（opacity→0）',
  );
  assert.match(
    css,
    /prefers-reduced-motion[\s\S]*?\.dot\.s-init::after, \.dot\.s-tune::after, \.dot\.s-busy::after \{ animation: none !important; display: none; \}/,
    'prefers-reduced-motion 必须停用圆点呼吸与晕影（减弱动效约定）',
  );
});

/* ---------- 契约 15：图标点亮/熄灭＝状态过渡（PROMPTS L953-957，2026/09/18 人工反馈） ---------- */

test('FE-CTR-15 | 晕影常驻过渡（熄灭淡出；到达＝仅晕影淡入）+ 图标本体零动效/零滤镜（iOS 防位移）', () => {
  // 口径演变：① 09/17 金色点亮 + 到达动效；② 09/18 一次＝去掉点亮瞬间缩放（纯淡入）；
  // ③ 09/18 二次（iOS 反馈「图标仍有一点轻微位置变动」）：**去除一切作用于图标本体的
  //    滤镜/透明度/缩放动效、并让载体提前常驻**——iOS WebKit 对 svg 上的 filter 或
  //    图层动画会重栅格化（Chromium 布局实测零位移，问题在合成层）；到达光效只允许
  //    落在晕影伪元素（opacity），点亮瞬间不得发生任何 DOM 结构变更。
  const css = readFileSync(path.join(JS_DIR, '..', 'css', 'app.css'), 'utf8');
  // 图标本体：点亮仅改色（不得含 filter——drop-shadow 为 iOS 位移源）
  const litIcon = /\.btn\.is-lit \.icon \{([^}]*)\}/.exec(css);
  assert.ok(litIcon, '缺少 .btn.is-lit .icon 规则');
  assert.match(litIcon[1], /color: var\(--lit-ink\)/, '点亮态必须改色');
  assert.equal(/filter/.test(litIcon[1]), false, '点亮态不得给 svg 本体加滤镜（iOS 重栅格化位移）');
  assert.equal(
    /@keyframes tgoIconLit|\.btn\.is-lit-in \.icon-lit \{ animation/.test(css),
    false,
    '不得再动画 svg 或载体（图标本体零动效，仅晕影淡入）',
  );
  // 晕影：基态常驻 + 双向 opacity 过渡；到达光效＝伪元素淡入
  assert.match(
    css,
    /\.btn \.icon-lit::before \{[^}]*opacity: 0[^}]*transition: opacity/,
    '晕影基态必须常驻于载体并声明过渡（熄灭＝淡出而非直接消失）',
  );
  assert.match(
    css,
    /\.btn\.is-lit \.icon-lit::before \{ opacity: 1; \}/,
    '点亮态必须只翻转晕影 opacity（由基态过渡而来）',
  );
  const haloIn = /@keyframes tgoLitHaloIn \{[\s\S]*?\n\}/.exec(css);
  assert.ok(haloIn, '缺少关键帧 @keyframes tgoLitHaloIn');
  assert.equal(/transform|scale/.test(haloIn[0]), false, 'tgoLitHaloIn 必须为纯 opacity 淡入（无缩放）');
  assert.match(
    css,
    /\.btn\.is-lit-in \.icon-lit::before \{ animation: tgoLitHaloIn/,
    '到达动效必须只落在晕影伪元素',
  );
  // 载体常驻：ensureIconLitWrap 必须先于点亮判定调用（点亮瞬间零 DOM 变更，防 iOS 结构变更位移）
  const litModule = readFileSync(path.join(JS_DIR, 'core', 'btn-lit.js'), 'utf8');
  const applyBody = /export function applyIconLit\([\s\S]*?\n\}/.exec(litModule);
  assert.ok(applyBody, '缺少 applyIconLit');
  const ensureAt = applyBody[0].indexOf('ensureIconLitWrap(btn, doc)');
  const toggleAt = applyBody[0].indexOf("classList.toggle('is-lit'");
  assert.ok(
    ensureAt !== -1 && toggleAt !== -1 && ensureAt < toggleAt,
    'ensureIconLitWrap 必须先于点亮判定（载体常驻 → 点亮瞬间无 DOM 插入/搬移）',
  );
  // 复盘 [深度分析]：innerHTML 仅在形态/文案变化时重建——逐次重建会抹掉进行中的
  // 熄灭淡出/到达动效（新节点无过渡历史）
  const review = readFileSync(path.join(JS_DIR, 'views', 'review-view.js'), 'utf8');
  assert.match(
    review,
    /dataset\.renderSig !== btnHtml/,
    '复盘按钮 innerHTML 必须按内容签名跳过同串重建（防抹掉点亮动效/熄灭过渡）',
  );
});

/* ---------- 契约 16：人人对弈落子零视觉副作用（PROMPTS L954，2026/09/18） ---------- */

test('FE-CTR-16 | 人人落子不重绘置灰（sendMove 仅人机）、move.applied 同帧解锁、PASS 行为层自守', () => {
  // 根因：sendMove 在人人模式同样立即 syncAll（本意为人机「AI 思考」即时呈现）——
  // busy 令全部操作按钮置灰、待 game.state 又立即解禁 → 每次落子闪烁（实测 disabled
  // 窗口 ~20ms 跨 1–2 帧）。修复＝①人人发送零重绘；②move.applied（提交回执）同帧解锁。
  const game = readFileSync(path.join(JS_DIR, 'views', 'game-view.js'), 'utf8');
  const sendMoveBody = functionBody(game, 'sendMove');
  assert.match(sendMoveBody, /isHumanAi\(/, 'sendMove 的即时重绘必须仅限人机（AI 思考呈现）');
  assert.equal(
    /if \(self\.board\) syncAll/.test(sendMoveBody),
    false,
    '不得回退为无条件重绘（人人闪源）',
  );
  const storeBody = functionBody(game, 'onStoreChange');
  assert.match(
    storeBody,
    /moveAppliedUnlocksBusy\(state\.game\)/,
    'move.applied 的 busy 复位必须经 moveAppliedUnlocksBusy 判定（人人解锁/人机保留，BUG-094）',
  );
  const passBody = functionBody(game, 'sendPass');
  assert.match(passBody, /actions\.pass\) return/, 'sendPass 必须以 actions.pass（含 busy）自守（发送不再即时置灰按钮）');
});

/* ---------- 契约 17：创建向导「人类模型缺失」提示＝toast（PROMPTS L955，2026/09/18 人工口径） ---------- */

test('FE-CTR-17 | 向导提交被拒（人类模型缺失）→ toast 呈现，不再落卡片底部内联错误区', () => {
  // 服务端对「人类风格/自适应但未挂载人类模型」的创建返回 INVALID_PAYLOAD +
  // 人类模型不可用：仅标准风格可用（人类模型缺失降级）——此前落 [data-form-error]
  // （卡片底部）内联区；按人工口径改走 toast（warning，同文案常量供校验路径复用）。
  const wiz = readFileSync(path.join(JS_DIR, 'views', 'create-wizard.js'), 'utf8');
  const m = /async function submit\([\s\S]*?\n  \}/.exec(wiz);
  assert.ok(m, '未找到 create-wizard.js::submit');
  const body = m[0];
  assert.match(
    body,
    /code === 'INVALID_PAYLOAD' && message\.includes\(HUMAN_MODEL_REJECT_MARK\)/,
    'submit 必须以 HUMAN_MODEL_REJECT_MARK 识别人类模型缺失拒绝',
  );
  assert.match(
    body,
    /toast\(\{ level: 'warning', text: HUMAN_MODEL_HINT_TEXT, key: 'human-model-missing' \}\)/,
    '该拒绝必须以专用文案走 toast（key 合并去重）',
  );
  assert.match(
    body,
    /showInlineError\(message \|\| '参数不合法，请检查表单'\)/,
    '其余 INVALID_PAYLOAD 校验错误保持内联提示（不得一并 toast 化）',
  );
});

/* ---------- 契约 18：首启引导标题资产（PROMPTS L936，2026/09/18 人工反馈） ---------- */

test('FE-CTR-18 | 首启引导标题＝title.svg（含深色选切）；无附加 favicon 图标', () => {
  // 人工口径：`欢迎来到 tGo` 文字标题改为 title.svg 品牌标志；标题行不放置 favicon.svg 图标。
  // 主题选切沿用 BUG-068 口径：固定色板双文件 + CSS 按 data-theme 选文件（不得依赖 SVG 内部媒体查询）。
  const onb = readFileSync(path.join(JS_DIR, 'views', 'onboarding-view.js'), 'utf8');
  assert.match(onb, /<h1 class="welcome-title">/, '欢迎卡标题必须改为 title.svg 载体（.welcome-title）');
  assert.equal(/<h1>欢迎来到 tGo<\/h1>/.test(onb), false, '不得回退为文字标题');
  assert.equal(/welcome-favicon/.test(onb), false, '标题行不得再放置 favicon.svg 载体');
  const css = readFileSync(path.join(JS_DIR, '..', 'css', 'app.css'), 'utf8');
  assert.match(
    css,
    /\.welcome-title \{[^}]*url\("\.\.\/title\.svg"\)/,
    '标题必须以 title.svg 背景渲染',
  );
  assert.match(
    css,
    /html\[data-theme="dark"\] \.welcome-title \{[^}]*title-dark\.svg/,
    '深色主题必须选切 title-dark.svg',
  );
  assert.equal(/welcome-favicon/.test(css), false, '不得残留 favicon 载体样式');
});

/* ---------- 契约 19：空闲超时滑杆禁用灰置（2026/09/18 人工反馈：常驻联动） ---------- */

test('FE-CTR-19 | 空闲超时滑杆：禁用态必须同步灰置（本体与数值附注）', () => {
  const css = readFileSync(path.join(JS_DIR, '..', 'css', 'app.css'), 'utf8');
  assert.match(
    css,
    /\.admin-grid input\[type="range"\]:disabled \{ opacity: \.[0-9]+; cursor: not-allowed; \}/,
    '空闲超时滑杆禁用时必须显式灰置（opacity + 禁用光标）',
  );
  assert.match(
    css,
    /\.admin-grid input\[type="range"\]:disabled \+ \.range-val \{ opacity: \.[0-9]+; \}/,
    '滑杆禁用时数值附注（.range-val）必须联动灰置',
  );
});

/* ---------- 契约 20：触摸轻点提交必须经手势判定（2026/09/18 人工反馈：结算页缩放误标记死子） ---------- */

test('FE-CTR-20 | 触摸提交手势判定（BUG-105）：捏合/平移/取消不得触发已占点选择与双击落子', () => {
  const board = readFileSync(path.join(JS_DIR, 'core', 'board.js'), 'utf8');
  // ① 触摸轻点：已占点选择 / 双击落子都只能登记 _pendingTap（延迟到 pointerup 判定）——
  //    若在 pointerdown 即时提交，捏合/平移的**首指落下**会误触发（结算页缩放误标记死子）。
  const touchBody = /_handleTouchTap\(evt\) \{([\s\S]*?)\n  \}/.exec(board);
  assert.ok(touchBody, '未找到 _handleTouchTap');
  assert.ok(
    /kind: 'select'/.test(touchBody[1]) && /kind: 'place'/.test(touchBody[1]),
    '触摸已占点选择与双击落子必须登记 _pendingTap（延迟提交）',
  );
  assert.equal(
    /onSelectStone\(pt\)/.test(touchBody[1]),
    false,
    '触摸已占点不得在 pointerdown 即时 onSelectStone（捏合/平移首指会误标记死子）',
  );
  // ② pointerup 必须经纯函数判定后提交（捏合/平移/取消一律丢弃）
  const upBody = /_handlePointerUp\(evt\) \{([\s\S]*?)\n  \}/.exec(board);
  assert.ok(upBody, '未找到 _handlePointerUp');
  assert.match(upBody[1], /touchTapCommitAction\(/, 'pointerup 必须经 touchTapCommitAction 判定提交');
  // ③ 捏合开始（第二指落下）必须废弃待定轻点
  const downBody = /_handlePointerDown\(evt\) \{([\s\S]*?)\n  \}/.exec(board);
  assert.ok(downBody, '未找到 _handlePointerDown');
  assert.match(downBody[1], /_resetTouchMarkers\(\)/, '捏合开始必须清待定轻点（_resetTouchMarkers 含 pending）');
  // ④ click 兜底接线（iOS Safari 偶发缺 pointerup——待定轻点必须仍可提交）
  assert.match(board, /addEventListener\('click', this\._onClick\)/, 'click 兜底必须接线');
  assert.match(board, /_handleClick\(\) \{[\s\S]*?this\._commitPendingTap\(pending\)/, 'click 兜底必须提交待定轻点');
  // ⑤ 交付兜底计时器（iOS 缺失 up/click 的最后防线）：登记待定即武装、一切废弃路径同步清计时器
  assert.match(board, /export const TOUCH_TAP_FALLBACK_MS = \d+;/, '必须定义交付兜底窗口常量');
  assert.match(touchBody[1], /_armTapFallback\(evt\.pointerId\)/, '登记待定轻点必须武装交付兜底计时器');
  const resetBody = /_resetTouchMarkers\(\) \{([\s\S]*?)\n  \}/.exec(board);
  assert.ok(resetBody && /_clearTapFallback\(\)/.test(resetBody[1]), '废弃待定轻点必须同步清除兜底计时器');
});

/* ---------- 契约 21：变化图预览胶囊定宽（防步进/暂停文本长度抖动，2026/09/19 人工反馈） ---------- */

test('FE-CTR-21 | 变化图预览胶囊：标签/步数定宽盒（对弈/复盘同构，禁止回退整串 textContent）', () => {
  const css = readFileSync(path.join(JS_DIR, '..', 'css', 'app.css'), 'utf8');
  // 2026/09/19 定稿口径（TESTING.md 同批记录；同日人工确认：测试断言以最新更改为准——
  // 5em/`变化图预览` 为遗留，不回退）：标签 `变化图`/`已暂停` 均 3 全角 → 3em；
  // 计数 `15/15` 5 字符 → 5ch（配合 .num 等宽数字）
  assert.match(
    css,
    /\.preview-chip \.pv-label \{[^}]*min-width: 3em/,
    '标签盒必须定宽：`变化图`＝3 全角字符（3em）',
  );
  assert.match(
    css,
    /\.preview-chip \.pv-count \{[^}]*min-width: 5ch/,
    '步数盒必须定宽：`15/15`＝5 字符（5ch，配合 .num 等宽数字）',
  );
  const game = readFileSync(path.join(JS_DIR, 'views', 'game-view.js'), 'utf8');
  const review = readFileSync(path.join(JS_DIR, 'views', 'review-view.js'), 'utf8');
  for (const [page, src, refLabel, refCount] of [
    ['对弈', game, 'gvPreviewLabel', 'gvPreviewCount'],
    ['复盘', review, 'rvPreviewLabel', 'rvPreviewCount'],
  ]) {
    assert.match(src, new RegExp(`data-ref="${refLabel}"`), `${page}页缺少标签盒（${refLabel}）`);
    assert.match(src, new RegExp(`data-ref="${refCount}"`), `${page}页缺少步数盒（${refCount}）`);
    // 分写：标签与步数各自写入 textContent（整串写入时长度变化会撑动胶囊）
    assert.match(
      src,
      /label\.textContent = p\.playing \|\| atEnd \? '变化图' : '已暂停'/,
      `${page}页标签必须单独写入（不得回退整串）`,
    );
    assert.match(
      src,
      /count\.textContent = `\$\{p\.step\}\/\$\{p\.pts\.length\}`/,
      `${page}页步数必须单独写入（不得回退整串）`,
    );
  }
});

/* ---------- 契约 22：报告/结算槽位（BUG-106 修复守卫，2026/09/19 人工决策） ---------- */

test('FE-CTR-22 | [报告]/[结算] 槽位：u-hide 机制（不得回退 hidden 属性）+ 桌面/移动双入口同步', () => {
  const review = readFileSync(path.join(JS_DIR, 'views', 'review-view.js'), 'utf8');
  // ① 双入口：桌面信息行 + 移动 [···] 菜单（各一个 [报告] + 一个 [结算]）
  const reportCount = (review.match(/<button[^>]*data-act="report"/g) || []).length;
  const settleCount = (review.match(/<button[^>]*data-act="settle"/g) || []).length;
  assert.equal(reportCount, 2, '[报告] 入口必须恰为 2 个（桌面信息行 + 移动菜单）');
  assert.equal(settleCount, 2, '[结算] 入口必须恰为 2 个（桌面信息行 + 移动菜单）');
  // ② 初始态以 u-hide 呈现（`.btn{display:inline-flex}` 覆盖 UA `[hidden]` → 属性门控无效，BUG-106）
  assert.match(review, /data-act="report" title="对局报告">报告</);
  assert.match(review, /data-act="report">报告</, '移动菜单项＝普通展开项（2026/09/19 去 role=menuitem）');
  assert.match(review, /data-act="settle" title="对局未结算：标记死子并结算">结算</);
  assert.match(review, /data-act="settle">结算</, '移动菜单项＝普通展开项（2026/09/19 去 role=menuitem）');
  const reportBtnTags = review.match(/<button[^>]*data-act="report"[^>]*>/g) || [];
  const settleBtnTags = review.match(/<button[^>]*data-act="settle"[^>]*>/g) || [];
  for (const tag of [...reportBtnTags, ...settleBtnTags]) {
    assert.match(tag, /u-hide/, `槽位按钮初始必须 u-hide（勿回退 hidden 属性）: ${tag}`);
    assert.equal(/\shidden[\s>]/.test(tag), false, `槽位按钮禁止 hidden 属性（被 .btn display 覆盖）: ${tag}`);
  }
  // ③ syncButtons 必须遍历全部节点（旧实现只同步第一个 → 移动端菜单项从不门控）
  assert.match(review, /querySelectorAll\('\[data-act="report"\]'\)/, 'report 门控必须遍历全部节点');
  assert.match(review, /querySelectorAll\('\[data-act="settle"\]'\)/, 'settle 门控必须遍历全部节点');
  assert.equal(/report\.hidden\s*=/.test(review), false, '不得回退 report.hidden 赋值（BUG-106 根因）');
  // ④ 槽位裁决走纯函数（未结算终局恒占 [结算]；其余按 analysis_complete 门控）
  assert.match(review, /reportSlotView\(\s*slotContext\(\)\s*\)/, '槽位必须经 reportSlotView(纯函数) 裁决');
  assert.match(review, /hub\.sendGame\('scoring\.prepare'\)/, '[结算] 进入须触发预判（scoring.prepare）');

  // ⑤ 前端客户端类型表必须登记 scoring.prepare（否则出站白发/被拒）
  const ws = readFileSync(path.join(JS_DIR, 'core', 'ws-client.js'), 'utf8');
  assert.match(ws, /'scoring\.prepare'/, 'ws-client CLIENT_MESSAGE_TYPES 必须登记 scoring.prepare');
  // ⑥ API 文档同步（客户端 → 服务端表）
  assert.ok(apiDoc().includes('scoring.prepare'), 'docs/API.md 必须登记 scoring.prepare');

  // ⑦ 复盘结算模块复用共用提示口径（不得复制文案逻辑）
  const settle = readFileSync(path.join(JS_DIR, 'views', 'review-settle.js'), 'utf8');
  assert.match(settle, /import \{[^}]*deadConfirmHint[^}]*\} from '\.\/scoring-panel\.js'/, '提示文案复用 scoring-panel 单一口径');
  assert.match(settle, /'scoring\.confirm', \{ dead_points: skip \? \[\] : deadToTuples\(self\.dead\) \}/, '确认载荷＝空/死子坐标对（同对弈页口径）');

  // ⑧ 列表状态文案：scoring 须与进行中区分（`结算中 · 第 N 手`）
  const list = readFileSync(path.join(JS_DIR, 'views', 'review-list-view.js'), 'utf8');
  assert.match(list, /`结算中 · 第 \$\{moveNo\} 手`/, '结算中对局列表文案必须为 `结算中 · 第 N 手`');

  // ⑨ ESC 让位必须按**可见**遮罩判定（报告弹层单例常驻 DOM：存在性判定会永久拦截 ESC）
  for (const [label, src] of [
    ['复盘补结算', settle],
    ['对弈结算面板', readFileSync(path.join(JS_DIR, 'views', 'scoring-panel.js'), 'utf8')],
  ]) {
    assert.match(src, /hasOpenDialogMask\(\)/, `${label} ESC 让位必须经 hasOpenDialogMask 判定`);
    assert.equal(
      /document\.querySelector\('\.dialog-mask'\)/.test(src),
      false,
      `${label} 不得回退 .dialog-mask 存在性判定（常驻单例会永久拦截 ESC）`,
    );
  }

  // ⑩ 第二步「数子结果」（2026/09/19 人工口径）：game.finished 后原地展示
  //    大字 + 黑目/白目/贴目/手数（deriveScoreGrid 同对弈页口径），[完成] 后退出
  assert.match(settle, /data-act="done">完成</, '结算卡第二步必须提供 [完成]（退出返回复盘）');
  assert.match(settle, /deriveScoreGrid\(game, \{ blackScore: f\.blackScore, whiteScore: f\.whiteScore \}\)/, '第二步网格必须复用 deriveScoreGrid（同对弈页口径）');
  assert.match(settle, /self\.finished = \{[\s\S]*?blackScore: data\.black_score/, 'game.finished 载荷必须本地捕获（目数不随后续 game.state）');
  assert.equal(
    /rv-settle-done/.test(readFileSync(path.join(JS_DIR, 'views', 'review-view.js'), 'utf8')),
    false,
    '第二步展示后不得再以 toast 重复提示结算完成（去掉旧 rv-settle-done 提示）',
  );

  // ⑪ 结算音效（2026/09/19 人工反馈）：进入结算模式播放对弈页同口径音效
  //    （对弈页 enterSettle → playSound('success') 一次性；复盘补结算同口径）
  assert.match(
    review,
    /inst\.activate\(\);\s*\n\s*playSound\('success'\);/,
    '进入结算模式必须播放成功音效（对弈页 enterSettle 同口径）',
  );
});

/* ---------- 契约 23：导入按钮图标保全（BUG-107，2026/09/19 人工反馈） ---------- */

test('FE-CTR-23 | [导入棋谱] 按钮：忙碌态只改写标签节点（禁回退 cta.textContent 整串覆盖）', () => {
  // 根因：旧 setBusy 以 `cta.textContent =` 切换文案——连 `<svg>` 图标一并抹掉，
  // 导入完成后顶栏按钮图标丢失。修复＝按钮文本由独立标签节点承载 + 只改写标签。
  const importJs = readFileSync(path.join(JS_DIR, 'core', 'sgf-import.js'), 'utf8');
  assert.match(importJs, /importCtaLabelTarget\(cta\)/, '忙碌态文本载体必须经 importCtaLabelTarget 解析');
  assert.match(importJs, /labelEl\.textContent = next \? IMPORT_BUSY_TEXT : ctaLabel/, '忙碌态只能改写标签节点文本');
  assert.equal(/cta\.textContent\s*=/.test(importJs), false, '不得回退 cta.textContent 赋值（会抹掉 svg 图标）');
  // 模板：按钮内保留图标 + 标签节点
  const indexHtml = readFileSync(path.join(JS_DIR, '..', 'index.html'), 'utf8');
  assert.match(
    indexHtml,
    /id="cta-import"[\s\S]*?<svg class="icon" aria-hidden="true"><use href="#i-sgf"\/><\/svg><span data-ref="ctaImportLabel">导入棋谱<\/span>/,
    '顶栏导入按钮必须保留 svg 图标 + 独立标签节点',
  );
  // 提示信息（2026/09/20 人工反馈）：统一为「导入棋谱（SGF）」，与 SGF_HINT 常量一致
  assert.match(
    indexHtml,
    /id="cta-import"[^>]*title="导入棋谱（SGF）"/,
    '顶栏导入按钮 title 必须为「导入棋谱（SGF）」',
  );
  assert.match(importJs, /SGF_HINT = '导入棋谱（SGF）'/, 'SGF_HINT 常量须与模板提示信息一致');
});

/* ---------- 契约 24：全局分析中断（2026/09/19 人工反馈） ---------- */

test('FE-CTR-24 | 全局分析：单击即发 cancel（无两步布防）+ 统一文案 + interrupted 不报「完成」', () => {
  // 根因（人工反馈「全局分析开始后再次点击按钮无法中断」）：旧实现两段式——
  // 首击仅布防（记 globalStopArmed 并换文案 `停止分析`）、次击才发 cancel，与
  // 按钮文案 `点击停止` 不符（实际感受为点一次停不下来）；且被中断的 done 回投
  // 仍报「全局分析完成」。修复＝单击直发 cancel（带防误触窗口）+ interrupted 静默；
  // 同日二次修订：统一文案 `补分析 · 待补 N 手`（去 `已补 x/y · 点击停止`防按钮跳动）。
  const review = readFileSync(path.join(JS_DIR, 'views', 'review-view.js'), 'utf8');
  assert.equal(/globalStopArmed/.test(review), false, '不得回退「先布防再确认」两步态（globalStopArmed）');
  assert.match(
    review,
    /if \(self\.globalStopping\) return;[\s\S]{0,240}GLOBAL_STOP_GUARD_MS[\s\S]{0,240}hub\.sendGame\('global_analysis\.cancel'\)/,
    '运行中单击必须直接下发 global_analysis.cancel（经防误触窗口后）',
  );
  assert.match(
    review,
    /const interrupted = Boolean\(message\.data && message\.data\.interrupted\)/,
    'global_analysis.done 须识别 interrupted 载荷',
  );
  assert.match(review, /if \(!interrupted\) toast\(/, '被中断的 done 不得再报「全局分析完成」');
  // 统一文案（2026/09/19 人工反馈二次修订）：运行中只示剩余 `补分析 · 待补 N 手`——
  // 禁止回退 `已补 x/y · 点击停止`/`停止分析` 形变文案（按钮跳动来源）；
  // 2026/09/20：文案收敛到单一来源 `analyzeRemainLabel`（label 与定宽渲染盒共用，
  // 禁两处字面量各自演化），故断言改写为「两分支均经 helper」+「不得残留 label 字面量」。
  assert.match(review, /label: analyzeRemainLabel\(remaining\)/, '运行中按钮必须与空闲态同形（只示剩余待补手数）');
  assert.match(review, /label: analyzeRemainLabel\(missing\)/, '空闲待补态同样经单一来源 helper');
  assert.equal(/label: `补分析 · 待补/.test(review), false, '计数文案不得再内联字面量（须经 analyzeRemainLabel）');
  assert.equal(/已补 \$\{/.test(review), false, '不得回退 `已补 x/y` 形变文案');
  assert.equal(/'停止分析'/.test(review), false, '不得回退 `停止分析` 占位文案');
  const ws = readFileSync(path.join(JS_DIR, 'core', 'ws-client.js'), 'utf8');
  assert.match(ws, /'global_analysis\.cancel'/, 'ws-client CLIENT_MESSAGE_TYPES 必须登记 global_analysis.cancel');
});

/* ---------- 契约 25：引擎胶囊显示迟滞（2026/09/19 防全局分析期间文案闪烁） ---------- */

test('FE-CTR-25 | 引擎胶囊：ANALYZING→IDLE 最短保持（显示级迟滞接线守门）', () => {
  // 根因：连续查询每手 begin/end 各广播一次 engine.status → 胶囊文案/圆点在
  // 分析中↔空闲中 间高频闪跳（实测数秒 500+ 次）。修复＝显示级迟滞（前端）。
  const pill = readFileSync(path.join(JS_DIR, 'core', 'engine-pill.js'), 'utf8');
  assert.match(pill, /pillDisplayState\(\{/, 'attachEnginePill 必须经 pillDisplayState 派生显示状态');
  assert.match(pill, /ANALYZING_HOLD_MS/, '保持窗口常量必须存在');
  assert.match(pill, /holdTimer = setTimeout\(render, plan\.deferMs/, '窗口到期必须重评（落定为 IDLE）');
  assert.match(pill, /clearTimeout\(holdTimer\)/, '重渲染/detach 必须清理挂起计时');
});

/* ---------- 契约 26–28：WIG 合规轮（2026/09/19）——无文本控件命名 / 画布文本替代 / 减动效 ---------- */

const STATIC_DIR = path.join(import.meta.dirname, '..', 'static');

test('FE-CTR-26 | WIG：role=switch 开关必须可访问名（管理页 switchHTML aria-label）', () => {
  // 根因：`role=switch` 的空 <button> 无文本可取名，邻近 <label>/<span> 又无 for/关联
  // → 读屏播报为“开关，关闭”，无法分辨是哪个设置项（WIG：无文本控件必须命名）。
  const admin = readFileSync(path.join(JS_DIR, 'views', 'admin-view.js'), 'utf8');
  assert.match(
    admin,
    /role="switch" aria-checked="\$\{on\}" data-switch="\$\{ref\}" aria-label="\$\{label\}"/,
    'switchHTML 必须输出 aria-label',
  );
  const twoArg = admin.match(/switchHTML\('[^']+',\s*[^,)]+\)/g) || [];
  assert.equal(twoArg.length, 0, `存在未命名的开关调用：${twoArg.join(' / ')}`);
});

test('FE-CTR-27 | WIG：移动结算宿主不得 aria-hidden + 胜率条 role=img 文本替代', () => {
  // 根因：宿主硬编码 aria-hidden="true" 且从未清除（显隐仅 u-hide）→ 结算抽屉
  // 展开后整棵子树仍被读屏遮蔽；胜率条 aria-label 挂在无 role 的 <div> 上被忽略。
  for (const [file, ref] of [['game-view.js', 'settleMobile'], ['review-view.js', 'rvSettleMobile']]) {
    const src = readFileSync(path.join(JS_DIR, 'views', file), 'utf8');
    const tag = (src.match(new RegExp(`<div[^>]*data-ref="${ref}"[^>]*>`)) || [''])[0];
    assert.ok(tag, `${file} 必须存在 ${ref} 宿主`);
    assert.equal(/aria-hidden/.test(tag), false, `${ref} 不得硬编码 aria-hidden（展开后仍遮蔽读屏）`);
    assert.match(tag, /u-hide/, `${ref} 显隐必须走 u-hide（display:none 已对读屏隐藏）`);
  }
  const game = readFileSync(path.join(JS_DIR, 'views', 'game-view.js'), 'utf8');
  const review = readFileSync(path.join(JS_DIR, 'views', 'review-view.js'), 'utf8');
  assert.match(game, /class="wr-bar" data-ref="wrBar" role="img" aria-label="黑白胜率"/);
  assert.match(game, /el\.setAttribute\('aria-label', `黑白胜率：/, '胜率条 aria-label 必须随渲染同步');
  assert.match(review, /class="wr-bar" data-ref="rvWrBar" role="img" aria-label="黑白胜率"/);
  assert.match(review, /bar\.setAttribute\('aria-label', `黑白胜率：/, '胜率条 aria-label 必须随渲染同步');
});

test('FE-CTR-28 | WIG：胶囊 disclosure 状态 + 减动效滚动/安全区 + 提子控件读屏替代', () => {
  const pill = readFileSync(path.join(JS_DIR, 'core', 'engine-pill.js'), 'utf8');
  assert.match(pill, /setAttribute\('aria-expanded', 'true'\)/, '展开必须同步 aria-expanded');
  assert.match(pill, /setAttribute\('aria-expanded', 'false'\)/, '关闭必须同步 aria-expanded');
  const html = readFileSync(path.join(STATIC_DIR, 'index.html'), 'utf8');
  assert.match(
    html,
    /id="engine-pill"[^>]*aria-haspopup="dialog"[^>]*aria-expanded="false"/,
    '胶囊初始态必须声明 disclosure 语义',
  );

  for (const file of ['game-sidebar.js', 'review-sidebar.js']) {
    const src = readFileSync(path.join(JS_DIR, 'views', file), 'utf8');
    assert.match(
      src,
      /behavior: reducedMotion \? 'auto' : 'smooth'/,
      `${file} 平滑滚动必须受 prefers-reduced-motion 门控`,
    );
  }

  const counter = readFileSync(path.join(JS_DIR, 'core', 'capture-counter.js'), 'utf8');
  assert.match(counter, /setAttribute\('role', 'img'\)/, '提子数仅画布绘制 → 必须提供文本替代');
  assert.match(counter, /setAttribute\('role', 'button'\)/, '可切换（onToggle）时必须为可键盘按钮');
  assert.match(counter, /addEventListener\('keydown'/, '切换必须有键盘等价路径');

  const css = readFileSync(path.join(STATIC_DIR, 'css', 'app.css'), 'utf8');
  assert.match(css, /top: calc\(12px \+ env\(safe-area-inset-top, 0px\)\)/, '沉浸退出按钮须避开刘海安全区');
});

test('FE-CTR-29 | [···] 菜单＝普通展开语义（无 menu 角色/aria-haspopup，保留 aria-expanded）', () => {
  // 2026/09/19 人工决策：menu 角色意味着方向键导航约定（未实现）——降级为 plain
  // disclosure（Tab 可操作），触发器保留 aria-expanded 表达展开态。
  for (const file of ['game-view.js', 'review-view.js', 'review-list-view.js']) {
    const src = readFileSync(path.join(JS_DIR, 'views', file), 'utf8');
    assert.equal(/role="menu"/.test(src), false, `${file} 不得回退 role="menu"`);
    assert.equal(/role="menuitem"/.test(src), false, `${file} 不得回退 role="menuitem"`);
    assert.equal(/aria-haspopup\s*=/.test(src), false, `${file} 不得回退 aria-haspopup（无菜单键盘约定）`);
  }
  const game = readFileSync(path.join(JS_DIR, 'views', 'game-view.js'), 'utf8');
  assert.match(
    game,
    /data-act="more"[\s\S]{0,120}aria-expanded="false"/,
    '触发器必须保留 aria-expanded（展开态可感知）',
  );
});

/* ---------- 契约 30：管理页参数校验可感知（WIG：错误就地 + 标记 + 聚焦，2026/09/19） ---------- */

test('FE-CTR-30 | 管理页参数校验：err role=alert + aria-invalid + 失败聚焦首个错误', () => {
  const admin = readFileSync(path.join(JS_DIR, 'views', 'admin-view.js'), 'utf8');
  assert.match(admin, /role="alert" data-err=/, '错误文本必须 role=alert（提交后即时播报）');
  assert.match(admin, /setAttribute\('aria-invalid', 'true'\)/, '错误字段必须 aria-invalid 标记');
  assert.match(admin, /function focusFirstFormError/, '校验失败必须聚焦首个错误输入（WIG）');
});

/* ---------- 契约 31：结算 AI 预判结果高亮（2026/09/19 人工反馈） ---------- */

test('FE-CTR-31 | 结算预判结果：主题色 + 正文粗体 + 删除「（按当前标记结算）」', () => {
  // 人工口径：对弈/复盘结算卡片 `AI 预判结果 白胜 1.5 目 (W+1.5)` —— 整体主题色
  // 高亮、正文（`白胜 1.5 目`）粗体；不再附「（按当前标记结算）」。
  for (const file of ['scoring-panel.js', 'review-settle.js']) {
    const src = readFileSync(path.join(JS_DIR, 'views', file), 'utf8');
    assert.equal(src.includes('（按当前标记结算）'), false, `${file} 不得回退「（按当前标记结算）」文案`);
    assert.match(src, /class="settle-pred"><b>/, `${file} 预判结果必须经 .settle-pred + <b> 呈现`);
    assert.match(src, /predictionResultParts/, `${file} 必须使用结构化预判文案（单一口径）`);
  }
  const css = readFileSync(path.join(STATIC_DIR, 'css', 'app.css'), 'utf8');
  assert.match(css, /\.scoring-panel \.settle-pred \{[^}]*color: var\(--accent\)/, '预判结果必须用主题色高亮');
  // 归一：旧扁平文案函数不得复活（避免双口径）
  const panel = readFileSync(path.join(JS_DIR, 'views', 'scoring-panel.js'), 'utf8');
  assert.equal(/predictionResultText/.test(panel), false, '不得回退 predictionResultText（已由 Parts 取代）');
});

/* ---------- 契约 32：M-9/M-10/M-11/M-12 修复的源码级约束（2026/09/19 代码审查） ---------- */

test('FE-CTR-32 | M 系列修复契约：结算确认超时 / failRestore 先销毁壳 / rAF 按需 / 超时覆盖响应体', () => {
  const panel = readFileSync(path.join(JS_DIR, 'views', 'scoring-panel.js'), 'utf8');
  assert.match(panel, /createConfirmGuard/, '结算确认必须具备超时守卫（M-9）');
  assert.match(panel, /confirmGuard\.arm\(\)/, '确认/取消提交必须 arm 超时（M-9）');
  assert.match(panel, /confirmGuard\.done\(\)/, '正常复位路径必须 done 清计时（M-9）');

  const game = readFileSync(path.join(JS_DIR, 'views', 'game-view.js'), 'utf8');
  assert.match(
    game,
    /function failRestore[\s\S]{0,400}teardownShell\(\)[\s\S]{0,200}showEmpty\('restore-fail'\)/,
    '恢复失败必须先销毁对局壳再切空态（M-10）',
  );

  const counter = readFileSync(path.join(JS_DIR, 'core', 'capture-counter.js'), 'utf8');
  assert.match(counter, /visibilitychange/, '提子控件必须响应页面可见性停/续帧（M-11）');
  assert.match(counter, /_needsFrame\(\)/, '提子控件必须按需判定是否续帧（M-11）');

  const rest = readFileSync(path.join(JS_DIR, 'core', 'rest-client.js'), 'utf8');
  assert.match(rest, /text = await res\.text\(\)/, '响应体读取必须位于超时闸保护范围内（M-12）');
  assert.equal(rest.includes('.text().catch(() => null)'), false, '不得回退「body 读取宽容 + 超时先行释放」（M-12）');
});

/* ---------- 契约 33：L 系列修复的源码级约束（2026/09/19 代码审查） ---------- */

test('FE-CTR-33 | L 系列修复契约：按压计划 / grade 白名单 / 合并渲染 / Worker 超时 / 音频恢复 / outbox 上限', () => {
  const board = readFileSync(path.join(JS_DIR, 'core', 'board.js'), 'utf8');
  assert.match(board, /export function pointerDownPlan/, 'L-9：按压处置计划必须为纯函数');
  assert.match(board, /next\.commentRing !== prev\.commentRing/, 'L-9：commentRing 必须登记状态层失效');

  const bubble = readFileSync(path.join(JS_DIR, 'core', 'comment-bubble.js'), 'utf8');
  assert.match(bubble, /BUBBLE_GRADES/, 'L-9：grade 必须白名单校验');

  const review = readFileSync(path.join(JS_DIR, 'views', 'review-view.js'), 'utf8');
  assert.match(review, /function scheduleSync\(\)/, 'L-10：试下高频消息须合并渲染');
  assert.match(review, /cancelAnimationFrame\(sliderRaf\)/, 'L-10：sliderRaf 必须随 destroy 取消');

  const game = readFileSync(path.join(JS_DIR, 'views', 'game-view.js'), 'utf8');
  assert.match(game, /WORKER_REPLY_TIMEOUT_MS/, 'L-10：Worker 应答必须超时回收');

  const audio = readFileSync(path.join(JS_DIR, 'core', 'audio.js'), 'utf8');
  assert.match(audio, /scheduleParts/, 'L-11：suspended ctx 须 resume 后合成');

  const ws = readFileSync(path.join(JS_DIR, 'core', 'ws-client.js'), 'utf8');
  assert.match(ws, /OUTBOX_LIMIT/, 'L-11：outbox 容量上限');
  assert.match(ws, /terminalClosed/, 'L-11：终态关闭后不得入队/重连');
});

/* ---------- 契约 34/35：引擎状态集合单源 + 启动入口收敛（ISSUE-069，2026/09/20） ---------- */

/**
 * 解析后端 `backend/app/core/fsm.py` 中的状态集合（权威定义）。
 * @param {string} source fsm.py 源码
 * @param {string} name 集合名（RUNNING_STATES / QUERY_STATES / LAUNCHABLE_STATES）
 * @returns {string[]} 状态名（如 ['INIT','IDLE','ANALYZING']）
 */
function parseBackendStateSet(source, name) {
  const block = source.match(
    new RegExp(`${name}\\s*:\\s*tuple\\[EngineState[^=]*=\\s*\\(([^)]*)\\)`)
  );
  assert.ok(block, `backend/app/core/fsm.py 必须定义 ${name}`);
  return [...block[1].matchAll(/EngineState\.(\w+)/g)].map((m) => m[1]);
}

test('FE-CTR-34 | 引擎状态集合单源：前端镜像必须与后端 fsm.py 逐项一致（ISSUE-069）', () => {
  // 动机（BUG-119）：引擎"是否在运行 / 可否拉起 / 可否查询"曾由后端与前端各自解释，
  // 同一事实多处解释导致判定漂移。现权威定义在后端，前端镜像由此契约锁定。
  const py = readFileSync(path.join(ROOT, 'backend', 'app', 'core', 'fsm.py'), 'utf8');
  assert.deepEqual([...ENGINE_RUNNING_STATES], parseBackendStateSet(py, 'RUNNING_STATES'));
  assert.deepEqual([...ENGINE_QUERY_STATES], parseBackendStateSet(py, 'QUERY_STATES'));
  assert.deepEqual([...ENGINE_LAUNCHABLE_STATES], parseBackendStateSet(py, 'LAUNCHABLE_STATES'));
});

test('FE-CTR-35 | 启动/重启入口收敛：横幅与对弈页不得自行拉起引擎（2026/09/20 人工决策）', () => {
  // 动机（ISSUE-069 G2）：DEAD 期间点击启动/重试会被后端快速失败（ENGINE_DEAD），而失败
  // 回执（admin.task）只有管理页视图消费 → 用户看到「已受理」却无任何反馈。故启动/停止/
  // 重启入口统一收敛到管理页；引导页的 STOPPED 自动拉起（onboarding-view）不在此列。
  for (const [segments, label] of [
    [['core', 'engine-banner.js'], '引擎降级横幅'],
    [['app.js'], '壳（横幅动作）'],
    [['views', 'game-view.js'], '对弈视图'],
  ]) {
    const src = readFileSync(path.join(JS_DIR, ...segments), 'utf8');
    assert.equal(
      /admin\/engines\/start/.test(src),
      false,
      `${label} 不得调用 POST /admin/engines/start（重启入口只在管理页）`
    );
  }
  const banner = readFileSync(path.join(JS_DIR, 'core', 'engine-banner.js'), 'utf8');
  assert.equal(/key: 'retry'/.test(banner), false, 'DEAD 横幅不得再提供 [重试]');
  assert.equal(/key: 'restart'/.test(banner), false, 'FATAL 横幅不得再提供 [手动重启]');
  const admin = readFileSync(path.join(JS_DIR, 'views', 'admin-view.js'), 'utf8');
  assert.match(admin, /path: '\/admin\/engines\/start'/, '管理页必须保留 [启动]/[手动重启]');
  const game = readFileSync(path.join(JS_DIR, 'views', 'game-view.js'), 'utf8');
  assert.equal(/engineRetry/.test(game), false, '对弈页不得再有 [重试] 按钮/处理器');
});

/* ---------- 契约 36：[补分析] 按钮计数定宽（防手数文本抖动，2026/09/20 人工反馈） ---------- */

test('FE-CTR-36 | [补分析] 计数定宽：数字单独进 3ch 右对齐盒（禁整串内插 label）', () => {
  // 根因（人工反馈「全局分析按钮会随手数文本变化而抖动」）：`补分析 · 待补 N 手` 的 N
  // 随分析推进逐手递减（3 位→2 位→1 位）→ 按钮宽度变化；而 `.bottom-actions` 靠右对齐
  // → 按钮左缘逐手横跳。中文恒 1em、数字经 `.num` 等宽 → 只锁**数字盒**即可全形态定宽。
  const css = readFileSync(path.join(STATIC_DIR, 'css', 'app.css'), 'utf8');
  assert.match(
    css,
    /\.bottom-actions \.btn\[data-act='analyze'\] \.an-count \{[^}]*min-width: 3ch;[^}]*text-align: right;/,
    '计数盒必须定宽 3ch（人工口径：待补手数按三位数）且右对齐',
  );
  const review = readFileSync(path.join(JS_DIR, 'views', 'review-view.js'), 'utf8');
  assert.match(
    review,
    /<span class="an-count num">\$\{bt\.remaining\}<\/span>/,
    '计数必须以定宽盒 + 等宽数字（.an-count.num）渲染，数据源为 bt.remaining',
  );
  assert.equal(
    /<span style="flex:1;text-align:left;font-size:12px">/.test(review),
    false,
    '不得回退整串内插 label 的旧渲染（宽度随手数位数变化）',
  );
});

/* ---------- 契约 37：复盘批量快照接入（2026/09/21 性能优化，防静默回退） ---------- */

test('FE-CTR-37 | 复盘批量快照：命中优先级 / 失效接线 / 领地懒加载（禁把快照当实时数据）', () => {
  // 动机：逐手步进此前每步一次 WS recommend.request（服务端 ~5 次 SQL/步）；改为一次性
  // 拉取 `GET /replay` 后本地命中。正确性风险全在**失效**与**优先级**，故固化守门：
  //   ① 快照是纯加速：未命中/已失效必须回落既有 WS 路径（不得因接入而删除回落分支）；
  //   ② 实时结果（WS/深算）优先级高于快照，且快照条目不得写入实时 LRU（须保持可失效）；
  //   ③ 深算结果到达 → 先失效快照该键再重拉（否则本地命中把旧快照当新数据）；
  //   ④ 领地懒加载只在用户开启 [领地] 时触发，且缺失局面仍走 WS 补分析路径。
  const review = readFileSync(path.join(JS_DIR, 'views', 'review-view.js'), 'utf8');
  assert.match(review, /createReplayBundle\(\)/, '控制器必须持有批量快照（core/replay-bundle.js）');
  assert.ok(
    review.includes("if (action === 'bundle')") && review.includes("data: snap"),
    '快照命中分支必须本地 dispatch（零请求）',
  );
  assert.ok(
    review.indexOf('const snap = cached ? null : self.bundle.get(key);')
      < review.indexOf("hub.sendGame('recommend.request'"),
    '快照查询必须先于 WS 请求（回落分支必须保留）',
  );
  // ②快照条目不入实时 LRU（对象同一性判定：快照必须始终可失效）
  assert.match(
    review,
    /if \(self\.bundle\.get\(key\) !== payload\) self\.cache\.set\(key, payload\);/,
    '快照来源的 review.recommend 不得写入 LRU（否则失效后仍返回陈旧快照）',
  );
  // ③深算结果到达 → 失效快照键（含领地），再清 LRU 并重拉
  const deepBlock = review.slice(
    review.indexOf("if (type === 'deep_analysis.result')"),
    review.indexOf("toast({ level: 'success', text: '深度分析完成'"),
  );
  assert.ok(deepBlock.includes('self.bundle.invalidate(key);'), '深算结果到达必须失效快照该键');
  assert.ok(
    deepBlock.indexOf('self.bundle.invalidate(key);') < deepBlock.indexOf('self.cache.delete(key);'),
    '失效必须先于清实时缓存 + 重拉（否则回落时仍命中旧快照）',
  );
  // ④领地懒加载：仅 [领地] 开启路径触发；只拉一次；命中则零请求
  assert.match(review, /if \(!self\.gameId \|\| self\.bundle\.hasOwnership\(\) \|\| self\.bundleOwnershipLoading\) return;/,
    '领地快照必须懒加载且只拉一次');
  assert.equal(
    (review.match(/loadBundleOwnership\(\);/g) || []).length,
    2,
    '领地快照只应在单击开启与双击连续两条开启路径触发（不得在进入页面时预拉）',
  );
  assert.match(review, /const snap = bundleOwnershipOf\(key\);\s*\n\s*if \(snap\.covered\) \{/,
    '领地请求入口必须优先命中快照（零请求）');
  // ⑤服务端 game.state 会复位 review 切片（state.js applyGameState）→ 视图必须按当前局面重派
  // （批量快照为同步本地命中，不再有「WS 异步回投」自然补齐；2026/09/21 回归修复）
  assert.match(
    review,
    /if \(type === 'game\.state'\) \{[\s\S]{0,600}?requestRecommendFor\(posKey\(\)\);/,
    'game.state 复位 review 切片后必须按当前局面重派（否则卡片停空态直到手动步进）',
  );
  // 快照刷新（补分析/结算后）必须清空实时 LRU 的空条目，否则空态遮住新数据
  assert.match(review, /purgeEmptyEntries\(self\.cache\);/, 'refreshBundle 必须清除空条目后再写入新快照');
  const bundle = readFileSync(path.join(JS_DIR, 'core', 'replay-bundle.js'), 'utf8');
  assert.ok(
    bundle.includes('purgeEmptyEntries') && bundle.includes('snapshotServes'),
    'core/replay-bundle.js 必须导出快照判定与空条目清理（纯函数层可无头测试）',
  );
  const api = readFileSync(path.join(ROOT, 'docs', 'API.md'), 'utf8');
  assert.ok(
    api.includes('/api/games/{id}/replay') && api.includes('/api/games/{id}/replay/ownership'),
    'docs/API.md 必须登记两个批量端点（§3.1）',
  );
});

/* ---------- 契约 38：沉浸底行 + 引擎常驻说明文案（2026/09/21 人工决策） ---------- */

test('FE-CTR-38 | 沉浸底行＝提子计数器 + [PASS][悔棋]（与棋盘整体居中）；常驻文案随开关联动', () => {
  // 人工口径（PROMPTS 2026/09/21）：
  //   ① 沉浸模式棋盘下方**保留一行**——左[提子计数器] 右[PASS][悔棋]（曾整行 display:none）；
  //   ② 其余动作隐藏：[支招] 结果落在沉浸下已隐藏的侧栏/分析抽屉（点了看不到结果）、
  //      [领地] 同批隐藏；移动端黑白胜率条为整行网格（width:100%）保留会把底行撑成两行；
  //   ③ 该行恒贴棋盘下方：棋盘与底行作为整体垂直居中（富余空间由棋盘上方/底行下方均分）；
  //   ④ 管理页「常驻」旁文案随开关联动（开＝引擎保持常驻运行 / 关＝引擎按需自动拉起，空闲超时自动释放）。
  const css = readFileSync(path.join(JS_DIR, '..', 'css', 'app.css'), 'utf8');
  assert.match(
    css,
    /body\.immersive \.topbar,\r?\nbody\.immersive \.sidebar,\r?\nbody\.immersive \.info-row,\r?\nbody\.immersive \.drawer-root \{ display: none !important; \}/,
    '沉浸隐藏列表＝顶栏/侧栏/信息行/分析抽屉（底行必须保留，勿回退整行隐藏）',
  );
  assert.match(
    css,
    /body\.immersive \.bottom-row \.wr-bar,[\s\S]{0,160}?\[data-act="coach"\],[\s\S]{0,160}?\[data-act="territory"\] \{ display: none !important; \}/,
    '沉浸底行必须隐藏 胜率条 / [支招] / [领地]',
  );
  assert.match(
    css,
    /body\.immersive \.board-wrap \{ max-height: none; margin-block: auto 0; \}/,
    '棋盘仅保留下侧 0（上侧 auto）——否则底行与棋盘间出现大空隙',
  );
  assert.match(
    css,
    /body\.immersive \.bottom-row \{ margin-bottom: auto; \}/,
    '底行必须承担下侧 auto（与棋盘上方均分富余空间＝两者成组居中）',
  );
  assert.match(
    css,
    /body\.immersive \.board-zone:has\(> \.bottom-row\.u-hide\) \.board-wrap \{ margin-bottom: auto; \}/,
    '结算/终局底行隐藏时必须恢复棋盘对称居中（无底行吸收下侧空隙）',
  );

  // 底行内容契约：左提子计数器 + 右 [PASS][悔棋]（对弈页）；结算隐藏走 u-hide（上面 :has 判据的前提）
  const game = readFileSync(path.join(JS_DIR, 'views', 'game-view.js'), 'utf8');
  assert.match(game, /<div class="captures" data-ref="captures"><\/div>/, '底行左＝提子计数器宿主');
  assert.match(game, /<div class="bottom-actions">[\s\S]{0,400}?data-act="pass"[\s\S]{0,400}?data-act="undo"/, '底行右＝[PASS][悔棋]（+.bottom-actions 内）');
  assert.match(game, /bottom\.classList\.toggle\('u-hide', settle\)/, '结算/终局底行隐藏仍走 u-hide（:has 判据前提）');

  // 管理页常驻文案：单一口径纯函数 + 骨架 data-ref + renderEngine 联动；旧静态文案不得残留
  const admin = readFileSync(path.join(JS_DIR, 'views', 'admin-view.js'), 'utf8');
  const fnBody = /export function residentNoteText\(resident\) \{([\s\S]*?)\n\}/.exec(admin);
  assert.ok(fnBody, '必须存在 residentNoteText 纯函数（单一口径）');
  assert.match(fnBody[1], /'引擎保持常驻运行'/, '常驻开＝`引擎保持常驻运行`');
  assert.match(fnBody[1], /'引擎按需自动拉起，空闲超时自动释放'/, '常驻关＝`引擎按需自动拉起，空闲超时自动释放`');
  assert.match(admin, /data-ref="residentNote">\$\{residentNoteText\(false\)\}/, '骨架必须按默认配置（resident=false）渲染说明文案');
  assert.match(
    admin,
    /setText\(region\.querySelector\('\[data-ref="residentNote"\]'\), residentNoteText\(resident\)\)/,
    'renderEngine 必须按 resident 刷新说明文案',
  );
  assert.equal(
    /<span class="muted" style="font-size:12px">引擎将保持运行<\/span>/.test(admin),
    false,
    '不得残留旧静态文案 span（引擎将保持运行）',
  );
});

/* ---------- 契约 39：编号搜索＝定位跳页 + 预览卡编号徽章（2026/09/21 人工决策） ---------- */

test('FE-CTR-39 | 搜索框 `#123`＝定位跳页（不做 name 过滤）；预览卡左下角徽章＝对局编号', () => {
  // 人工口径：① 编号搜索不筛只跳——服务端 focus_id 算出所在页（focus_page）→ 前端翻页并选中；
  // ② 预览卡信息行首位徽章由 人人/人机 改为对局编号 `#id`（与搜索语法 `#123` 互为锚点）。
  const src = readFileSync(path.join(JS_DIR, 'views', 'review-list-view.js'), 'utf8');
  // ① 意图解析单一口径：`#编号` 不产生 name 过滤（LIKE %#123% 恒 0 行）
  assert.match(src, /export function searchIntent\(q\) \{/, '必须有 searchIntent 纯函数（单一口径）');
  assert.match(src, /const intent = searchIntent\(s\.q\);/, 'listQuery 必须经 searchIntent 分流');
  assert.match(src, /if \(intent\.kind === 'name'\) query\.name = intent\.name;/, '只有姓名意图才下发 name 过滤');
  // ② 定位走服务端 focus_id（不得客户端全量扫描/不得当筛选）
  assert.match(src, /const locateId = searchId != null \? searchId : st\.pendingSelect;/, '定位目标＝搜索编号优先，其次复盘返回记录');
  assert.match(src, /if \(locateId != null\) query\.focus_id = locateId;/, '定位必须携带 focus_id');
  assert.match(src, /const focusPage = Number\(data\.focus_page\);/, '必须以服务端 focus_page 翻页');
  // ③ 未命中分支：编号＝一次性 Toast（列表保持原样）；复盘返回＝一次性清除 LS 记录
  assert.match(src, /focusMissedId !== searchId/, '编号未命中提示必须去重（同一编号不重复打扰）');
  assert.match(src, /key: 'rl-locate-miss'/, '未命中 Toast 必须固定 key（合并防刷屏）');
  assert.match(
    src,
    /if \(searchId == null\) \{\r?\n\s*st\.pendingSelect = null;\r?\n\s*clearReviewSelect\(\);/,
    '复盘返回的一次性语义必须保留（命中/未命中都要清记录）',
  );
  // ④ 编号定位不是筛选：空库 + 编号输入不得误报「无符合筛选的对局」
  assert.match(src, /searchIntent\(st\.q\)\.kind === 'name'/, 'filtersActive 只认姓名搜索');
  // ⑤ 搜索框必须自述编号能力（placeholder + aria-label）
  assert.match(src, /placeholder="按姓名或编号搜索…"/, 'placeholder 必须反映编号搜索');
  assert.match(src, /aria-label="按姓名或对局编号搜索"/, 'aria-label 必须反映编号搜索');
  // ⑥ 预览卡徽章＝对局编号；derivePreview 不再派生模式（防双口径回退）
  assert.match(src, /`<span class="badge">#\$\{escapeHtml\(prev\.id\)\}<\/span>`/, '预览卡信息行首位＝`#编号` 徽章');
  assert.equal(/prev\.modeLabel|prev\.modeAccent/.test(src), false, '预览卡不得再引用模式徽章字段');
  const previewFn = /export function derivePreview\(detail\) \{([\s\S]*?)\r?\n\}/.exec(src);
  assert.ok(previewFn, '未找到 derivePreview');
  assert.equal(/modeLabel|modeAccent/.test(previewFn[1]), false, 'derivePreview 不得再派生模式徽章字段');
  // 列表行徽章（人人/人机）保持不变——本次只改预览卡
  assert.match(src, /const modeCls = row\.modeAccent \? 'badge accent' : 'badge';/, '列表行模式徽章不受影响');
});

/* ---------- 契约 40：主题切换＝两层同帧重绘（2026/09/24 人工反馈） ---------- */

test('FE-CTR-40 | 主题/主题色切换：棋盘静态层与状态层必须同帧失效（TOP5/光标读 --accent，禁「移动鼠标才更新」）', () => {
  // 人工反馈：「切换深浅主题后，支招/topN 推荐的对比度颜色更新延迟，要将鼠标移动到棋盘上才会更新」。
  // 根因：状态层叠加标记（TOP5 徽章＝--accent 圆徽 + --accent-contrast 序号、键盘光标圈）与静态层
  // **共用 `_colors` 色板缓存**，而主题观察器只失效静态层 → 状态层像素保留旧主题色，直到下一次
  // 无关的状态失效（鼠标移动 → hover 幽灵 `_invalidate('state')`）才被动更新，用户观感即「延迟」。
  // 口径：主题/主题色变化走 `refresh()`——清色板缓存 + 两层同帧标脏（单一入口，勿再只失效单层）。
  const board = readFileSync(path.join(JS_DIR, 'core', 'board.js'), 'utf8');
  const observer = /this\._mo = new MutationObserver\(([\s\S]*?)\);\r?\n/.exec(board);
  assert.ok(observer, '未找到主题观察器构造（监听 data-theme/data-accent 的 MutationObserver）');
  assert.match(
    board,
    /attributeFilter: \['data-theme', 'data-accent'\]/,
    '必须同时观察 data-theme 与 data-accent（换主题色同样改 --accent）',
  );
  assert.match(observer[1], /this\.refresh\(\)/, '主题变化必须走 refresh()（清缓存 + 两层同帧失效）');
  assert.equal(
    /_invalidate\(/.test(observer[1]),
    false,
    '禁止只失效单层（旧实现仅 static → 状态层 TOP5 徽章/光标保留旧主题色）',
  );
  const refreshBody = /refresh\(\) \{([\s\S]*?)\n  \}/.exec(board);
  assert.ok(refreshBody, '未找到 refresh()');
  assert.match(refreshBody[1], /this\._colors = null;/, 'refresh() 必须清空色板缓存（CSS token 重新解析）');
  assert.match(refreshBody[1], /this\._dirty\.static = true;/, 'refresh() 必须标脏静态层');
  assert.match(refreshBody[1], /this\._dirty\.state = true;/, 'refresh() 必须标脏状态层');
  // 状态层确实消费主题色板（守卫：accent/contrast 取自 CSS token，故主题切换必须重绘状态层）
  assert.match(board, /ctx\.fillStyle = c\.accent;/, 'TOP5 徽章圆底＝c.accent（主题色）');
  assert.match(board, /ctx\.fillStyle = c\.accentContrast;/, 'TOP5 序号＝c.accentContrast（主题对比色）');
});

/* ---------- 契约 41：同族——按需调度下的主题取色不得残留（2026/09/24 自查） ---------- */

test('FE-CTR-41 | 提子计数器：主题切换必须唤醒一帧（reduce-motion 静态模式下 rAF 空闲，无帧则旧文字色残留）', () => {
  // 同族根因：`_themeTick()` 只在**帧内**比对 data-theme；常态呼吸动画持续要帧（掩盖问题），
  // 但 reduce-motion（UI_UX §6.3 允许）下 `_needsFrame()` 为假 → 循环空闲，切主题后无人唤醒，
  // 文字色（--text-1/--text-2）与面板色一直停在旧主题，直到下一次状态变化（落子提子）才更新。
  const src = readFileSync(path.join(JS_DIR, 'core', 'capture-counter.js'), 'utf8');
  const observer = /this\._mo = new MutationObserver\(([\s\S]*?)\)\r?\n/.exec(src);
  assert.ok(observer, '未找到主题观察器构造');
  assert.match(src, /attributeFilter: \['data-theme'\]/, '观察 data-theme（文字色 token 随主题变）');
  assert.match(observer[1], /this\._invalidate\(\)/, '主题变化必须 _invalidate() 唤醒一帧重绘');
  const destroyBody = /destroy\(\) \{([\s\S]*?)\n  \}/.exec(src);
  assert.ok(destroyBody, '未找到 destroy()');
  assert.match(destroyBody[1], /this\._mo\.disconnect\(\)/, 'destroy 必须断开主题观察器');
  assert.match(destroyBody[1], /this\._mo = null/, 'destroy 必须释放观察器引用');
});

/* ---------- 契约 42：引擎未启动时改模型/参数＝单条「下次启动生效」提示（2026/09/24 人工反馈） ---------- */

test('FE-CTR-42 | 引擎未启动时改模型/参数：不进入假受理态、不谎报「已排队」（BUG-138）', () => {
  // 人工反馈：引擎未启动时「切换模型 → 保存」先后弹出三条互相矛盾的提示——卡片内静态块
  // 「已排队，将在引擎空闲时执行」、202 文案、以及 60s 后「已受理；连接恢复后将收到执行
  // 结果」（实为**没有**任何 admin.task 回执可等）；且受理态把 [启动] 等按钮连带禁用 60s。
  // 口径：引擎未运行时后端只落配置、不排队（`task_queued=false`）→ 前端只弹一条
  // 「引擎参数/模型已变更，将在引擎下次启动时生效」，不进入等待态。
  const src = readFileSync(path.join(JS_DIR, 'views', 'admin-view.js'), 'utf8');
  const task = /self\.opTask = act;([\s\S]*?)\n  \}/.exec(src);
  assert.ok(task, '未找到 engineTask 受理态实现');
  assert.match(task[1], /data\.task_queued === false/, 'engineTask 必须消费 task_queued === false');
  assert.match(
    task[1],
    /if \(data && data\.task_queued === false\) \{[\s\S]*?self\.opTask = null;[\s\S]*?clearOpTimer\(\);/,
    '未排队（无回执）必须立即清受理态与兜底计时器',
  );
  const queue = /function engineQueueHTML\(\) \{([\s\S]*?)\n  \}/.exec(src);
  assert.ok(queue, '未找到 engineQueueHTML');
  assert.match(queue[1], /self\.opQueued !== true/, '队列提示必须以「已确认排队」为条件');
  assert.match(queue[1], /self\.opTask === 'start'/, '[启动] 不显示「将在引擎空闲时执行」（拉起不是排队）');
  assert.match(src, /self\.opTask = null;\r?\n\s+self\.opQueued = false;/, '受理态清理路径必须同步清 opQueued');
  // 模型保存确认文案随引擎态（未运行＝下次启动生效，不得谎称「保存并重启」）
  assert.match(src, /export function modelSaveCopy\(engineState\) \{/, '必须有 modelSaveCopy 纯函数');
  // 后端同口径：未运行时模型/参数变更共用一条文案，并显式声明无异步任务
  const routes = readFileSync(path.join(ROOT, 'backend', 'app', 'api', 'routes_admin.py'), 'utf8');
  assert.match(
    routes,
    /message="引擎参数\/模型已变更，将在引擎下次启动时生效"/,
    '引擎未运行：模型/参数变更必须同一条文案',
  );
  assert.match(routes, /task_queued=False,/, '未排队分支必须显式 task_queued=False');
  assert.match(
    readFileSync(path.join(ROOT, 'backend', 'app', 'api', 'schemas.py'), 'utf8'),
    /task_queued: Optional\[bool\] = Field\(/,
    'AcceptedResponse 必须暴露 task_queued 契约字段',
  );
});

/* ---------- 契约 43：引擎级变更文案随引擎态（2026/09/24 人工反馈 ② 同族） ---------- */

test('FE-CTR-43 | 引擎级变更文案随引擎态：骨架不得写死「重启引擎生效」（BUG-139）', () => {
  // 人工反馈：「引擎启动失败（FATAL，模型错误），再切换模型，保存模型，依旧重启（按钮文案与
  // 事实不符）」。根因（文案侧）：模型卡按钮标签、模型卡提示、参数卡标题/脏提示/警示条**四处
  // 写死**「安全重启」——引擎未运行（STOPPED/DEAD/FATAL）时实际只落配置、下次启动生效。
  const src = readFileSync(path.join(JS_DIR, 'views', 'admin-view.js'), 'utf8');
  // ① 静态骨架不得再写死重启口径（以标记后缀锚定，避免误伤 engineChangeCopy 的取值表）
  assert.equal(/保存模型（重启引擎生效）/.test(src), false, '按钮标签不得写死「（重启引擎生效）」');
  assert.equal(
    src.includes('切换将安全重启引擎，进行中对局与分析数据不受影响</div>'),
    false,
    '模型卡提示不得写死',
  );
  assert.equal(src.includes('（和当前 .yaml 不一致时保存后安全重启）</span>'), false, '参数卡标题不得写死');
  assert.equal(src.includes('保存后引擎将安全重启）</span>'), false, '脏提示不得写死');
  assert.equal(
    src.includes('引擎级变更保存后将触发引擎安全重启（引擎空闲时执行）</div>'),
    false,
    '警示条不得写死',
  );
  // ② 四处经 data-ref 挂载，由单一取值源 engineChangeCopy 渲染
  assert.match(src, /export function engineChangeCopy\(engineState\) \{/, '必须有 engineChangeCopy 纯函数');
  for (const ref of ['modelSaveHint', 'engineKeyScope', 'dirtyEngineNote', 'engineKeyWarn']) {
    assert.ok(src.includes(`data-ref="${ref}"`), `缺少 data-ref="${ref}"`);
    assert.ok(new RegExp(`set\\('${ref}'`).test(src), `renderScopeCopy 必须刷新 ${ref}`);
  }
  assert.match(src, /const copy = engineChangeCopy\(self\.engine\.state\);/, '取值源＝engineChangeCopy(self.engine.state)');
  // ③ 引擎状态变化（WS engine.status）必须同步刷新（否则胶囊变了文案还停在旧口径）
  const sub = /message\.type === 'engine\.status'\) \{([\s\S]*?)\n      \} else if/.exec(src);
  assert.ok(sub, '未找到 engine.status 订阅分支');
  assert.match(sub[1], /renderScopeCopy\(\)/, 'engine.status 分支必须调 renderScopeCopy()');
});

/* ---------- 契约 44：管理页保存不得引发卡片闪烁（2026/10/10 人工反馈） ---------- */

/** 去注释 + 截取某个具名函数体（`\n  function name(` … 首个 `\n  }`），供源码契约断言。 */
function adminFnBody(src, name) {
  const m = new RegExp(`\\n  (?:async )?function ${name}\\(([\\s\\S]*?)\\n  \\}`).exec(src);
  assert.ok(m, `未找到函数 ${name}`);
  return m[1]
    .replace(/\/\*[\s\S]*?\*\//g, '')   // 块注释
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1'); // 行注释（保留 http:// 之类）
}

test('FE-CTR-44 | 管理页保存不得闪卡：配置保存只灰置参数卡按钮 + 引擎卡渲染幂等（2026/10/10）', () => {
  // 人工反馈：「管理页中，调整空闲超时时间、参数配置，保存后卡片会闪烁一下」。
  // 根因（两处叠加）：
  //  ① saveConfigPatch/saveConfigForm 置 self.saving 后调用 renderOpsBusy()，把**整张引擎卡**
  //     （[启动/停止/重启] 行 innerHTML 重建 + 空闲超时滑杆 + 常驻开关 + 模型区）一并灰置，
  //     响应回来再整卡恢复 → 卡片控件灰置一瞬再恢复＝闪烁；
  //  ② render* 系列无差别写 textContent/innerHTML/disabled（值未变也写）→ 每次数据到达都产生
  //     与事实无关的 DOM 变更，毛玻璃卡（backdrop-filter）随重绘闪烁。
  // 契约：配置保存在途**只能**灰置参数卡自身的 [保存更改]/[重置]；引擎卡屏幕状态只跟
  //      引擎异步任务（self.opTask）走；渲染写入必须经幂等助手比对。
  const src = readFileSync(path.join(JS_DIR, 'views', 'admin-view.js'), 'utf8');

  // ① 表单保存（[保存更改]）只灰置参数卡自身按钮；即时保存（常驻/空闲超时）零忙碌态渲染
  const formSaveBody = adminFnBody(src, 'saveConfigForm');
  assert.match(formSaveBody, /renderConfigBusy\(\)/, '[保存更改] 必须以 renderConfigBusy() 呈现保存在途态');
  const patchSaveBody = adminFnBody(src, 'saveConfigPatch');
  assert.equal(
    /renderConfigBusy\(\)/.test(patchSaveBody),
    false,
    '即时保存（常驻/空闲超时）不得渲染忙碌态——否则会灰置无关卡片按钮一瞬＝闪烁',
  );
  for (const name of ['saveConfigPatch', 'saveConfigForm']) {
    assert.equal(
      /renderOpsBusy\(\)/.test(adminFnBody(src, name)),
      false,
      `${name} 不得调用 renderOpsBusy()（会灰置整张引擎卡＝保存后卡片闪烁）`,
    );
  }
  const cfgBusy = adminFnBody(src, 'renderConfigBusy');
  assert.match(cfgBusy, /cfgSave/, 'renderConfigBusy 必须同步 [保存更改] 禁用态');
  assert.match(cfgBusy, /cfgReset/, 'renderConfigBusy 必须同步 [重置] 禁用态');
  const opsBusy = adminFnBody(src, 'renderOpsBusy');
  assert.equal(/cfgSave|cfgReset/.test(opsBusy), false, 'renderOpsBusy 只负责引擎卡，不得管参数卡按钮');

  // ② 引擎卡/模型卡灰置只跟 self.opTask（配置保存标志 self.saving 一律不得参与）
  for (const name of ['renderEngine', 'renderModel', 'engineOpsHTML']) {
    assert.equal(
      /self\.saving/.test(adminFnBody(src, name)),
      false,
      `${name} 不得引用 self.saving（配置保存会牵动引擎卡控件灰置＝闪烁）`,
    );
  }

  // ③ 渲染幂等：值未变则零 DOM 写入（一律走 setText/setHTML/setValue/setDisabled/setHidden/…）
  const IDEMPOTENT_FNS = [
    'renderEngine',
    'renderModel',
    'renderParamValues',
    'renderScopeCopy',
    'renderDirty',
    'renderFormErrors',
  ];
  assert.ok(src.includes('function setText(el, text)'), '缺少幂等写入助手 setText');
  assert.ok(src.includes('function setHTML(el, html)'), '缺少幂等写入助手 setHTML');
  assert.ok(src.includes('function setDisabled(el, disabled)'), '缺少幂等写入助手 setDisabled');
  assert.ok(src.includes('function setOptions(sel, html, signature)'), '缺少幂等写入助手 setOptions（select 重建）');
  for (const name of IDEMPOTENT_FNS) {
    const body = adminFnBody(src, name);
    assert.equal(/\btextContent\s*=/.test(body), false, `${name} 不得直接写 textContent（须走 setText）`);
    assert.equal(/\.innerHTML\s*=/.test(body), false, `${name} 不得直接写 innerHTML（须走 setHTML）`);
    assert.equal(/\.disabled\s*=/.test(body), false, `${name} 不得直接写 disabled（须走 setDisabled）`);
  }
});

/* ---------- 契约 18：创建对局＝覆盖层（背景页保留 + 取消零重建，2026/10/21 人工反馈） ---------- */

test('FE-CTR-45 | #/create 以覆盖层打开：不卸载背景视图；取消用 replaceState 原地恢复', () => {
  // 根因：旧实现把 #/create 当普通路由 → 进入即 destroy 当前视图、清空 #main，
  // 向导只剩空背景；取消再回 #/ 重新挂载 → 顶栏/页面尺寸重算 = 抖动。
  // 现行：create 路由不参与视图装载，改为在已挂载页面之上打开 `.dialog-mask.create-wizard`
  // （背景模糊遮罩）；取消/返回仅收遮罩并恢复背景 hash，不触发路由重建。
  const app = readFileSync(path.join(JS_DIR, 'app.js'), 'utf8');
  assert.match(
    app,
    /if \(!gateOn && route\.name === 'create'\) \{\s*await enterCreateOverlay\(\);\s*return;/,
    'create 路由必须以覆盖层打开并跳过视图装载',
  );
  assert.match(
    app,
    /if \(canonicalHash\(location\.hash\) === baseHash\) return;/,
    '离开覆盖层回到背景 hash 时必须直接返回（不得重建背景视图）',
  );
  const cancel = /function cancelCreateOverlay\(\) \{([\s\S]*?)\n\}/.exec(app);
  assert.ok(cancel, '未找到 app.js::cancelCreateOverlay');
  assert.match(cancel[1], /history\.replaceState\(/, '取消必须用 replaceState 恢复背景 hash');
  assert.equal(
    /location\.hash\s*=/.test(cancel[1]),
    false,
    '取消不得修改 location.hash（会触发 hashchange → 整页重挂）',
  );

  const wiz = readFileSync(path.join(JS_DIR, 'views', 'create-wizard.js'), 'utf8');
  assert.match(
    wiz,
    /const onCancel = typeof deps\.onCancel === 'function' \? deps\.onCancel : null;/,
    '向导必须支持注入 onCancel（覆盖层模式原地收起）',
  );
  assert.match(
    wiz,
    /if \(onCancel\) onCancel\(\);\s*else nav\('#\/'\);/,
    '取消优先走注入回调，缺省仍回 #/',
  );
  assert.match(
    wiz,
    /if \(key === 'cancel'\) \{ handleCancel\(\); return; \}/,
    '[取消] 按钮必须走统一取消入口（直接调用注入回调会在未注入时失效）',
  );
});

/* ---------- Fake WebSocket（最小可分发环境） ---------- */

function fakeEnv() {
  const instances = [];
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      instances.push(this);
    }

    send(text) {
      this.sent.push(text);
    }

    close() {
      this.readyState = 3;
      if (this.onclose) this.onclose({ code: 1000 });
    }

    _open() {
      this.readyState = 1;
      if (this.onopen) this.onopen({});
    }

    _msg(payload) {
      if (this.onmessage) this.onmessage({ data: JSON.stringify(payload) });
    }
  }
  return {
    all: instances,
    factory: (url) => new FakeWebSocket(url),
    last: () => instances[instances.length - 1],
  };
}
