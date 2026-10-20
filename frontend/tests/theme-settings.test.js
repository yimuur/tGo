/**
 * tGo · theme/settings 无头单测（T5.4，node --test）
 * 用例 ID: FE-THEME-* / FE-SETT-*
 * 覆盖：明暗偏好解析（含跟随系统）、主题色规范化、持久化（注入 storage）、
 * 轮转顺序；音量钳制/静音/reduced-motion 判定。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  THEME_MODES,
  ACCENTS,
  normalizeThemeMode,
  normalizeAccent,
  resolveThemeMode,
  createThemeManager,
} from '../static/js/core/theme.js';

import {
  DEFAULT_VOLUME,
  createSettings,
  defaultReducedMotion,
  stoneMotionEnabled,
  STONE_MOTION_DEFAULT,
  clampPreviewSteps,
  getPreviewSteps,
  showAiMatchEnabled,
  decorEnabled,
} from '../static/js/core/settings.js';

import { createLocalStore, memoryStorage, LS_KEYS } from '../static/js/core/localstore.js';

function storageWith(initial = {}) {
  const mem = memoryStorage();
  for (const [k, v] of Object.entries(initial)) mem.setItem(k, JSON.stringify(v));
  return createLocalStore(mem);
}

function stubMedia(systemDark = false) {
  const listeners = [];
  return {
    systemDark,
    onChange(fn) {
      listeners.push(fn);
      return () => {
        const i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    _emit(dark) {
      listeners.forEach((fn) => fn(dark));
    },
  };
}

/* ---------- FE-THEME ---------- */

test('FE-THEME-01 偏好规范化', () => {
  assert.deepEqual(THEME_MODES, ['light', 'dark', 'system']);
  assert.deepEqual(ACCENTS, ['dai', 'zhu']);
  assert.equal(normalizeThemeMode('dark'), 'dark');
  assert.equal(normalizeThemeMode('system'), 'system');
  assert.equal(normalizeThemeMode('sepia'), 'light');
  assert.equal(normalizeAccent('zhu'), 'zhu');
  assert.equal(normalizeAccent('red'), 'dai');
});

test('FE-THEME-02 明暗解析（含跟随系统）', () => {
  assert.equal(resolveThemeMode('light', true), 'light');
  assert.equal(resolveThemeMode('dark', false), 'dark');
  assert.equal(resolveThemeMode('system', true), 'dark');
  assert.equal(resolveThemeMode('system', false), 'light');
  assert.equal(resolveThemeMode('bogus', true), 'light');
});

test('FE-THEME-03 默认态与持久化读写', () => {
  const store = storageWith();
  const mgr = createThemeManager({ storage: store, media: stubMedia(false), doc: null });
  assert.equal(mgr.getMode(), 'light');
  assert.equal(mgr.getAccent(), 'dai');
  assert.equal(mgr.getResolved(), 'light');

  mgr.setMode('dark');
  assert.equal(mgr.getResolved(), 'dark');
  assert.equal(store.storage.getItem(LS_KEYS.theme), '"dark"'); // 已持久化

  mgr.setAccent('zhu');
  assert.equal(mgr.getAccent(), 'zhu');
  assert.equal(store.storage.getItem(LS_KEYS.accent), '"zhu"');
});

test('FE-THEME-04 轮转顺序 light→dark→system→light', () => {
  const mgr = createThemeManager({ storage: storageWith(), media: stubMedia(true), doc: null });
  mgr.setMode('light');
  mgr.cycleMode();
  assert.equal(mgr.getMode(), 'dark');
  mgr.cycleMode();
  assert.equal(mgr.getMode(), 'system');
  assert.equal(mgr.getResolved(), 'dark'); // system + 系统深色
  mgr.cycleMode();
  assert.equal(mgr.getMode(), 'light');
});

test('FE-THEME-05 跟随系统时媒体变化触发重解析', () => {
  const media = stubMedia(false);
  let fired = 0;
  const mgr = createThemeManager({
    storage: storageWith(),
    media,
    doc: null,
    onChange: () => {
      fired += 1;
    },
  });
  mgr.setMode('system');
  assert.equal(mgr.getResolved(), 'light');
  media._emit(true); // 系统切深色
  assert.equal(mgr.getResolved(), 'dark');
  assert.ok(fired >= 1);
  // 非 system 模式不订阅媒体
  mgr.setMode('dark');
  const before = fired;
  media._emit(false);
  assert.equal(fired, before);
});

/* ---------- FE-SETT ---------- */

test('FE-SETT-01 音量默认 70 与钳制', () => {
  const s = createSettings({ storage: storageWith(), reducedMotion: { matches: false } });
  assert.equal(s.getVolume(), DEFAULT_VOLUME);
  s.setVolume(150);
  assert.equal(s.getVolume(), 100);
  s.setVolume(-5);
  assert.equal(s.getVolume(), 0);
  s.setVolume('abc');
  assert.equal(s.getVolume(), DEFAULT_VOLUME);
});

test('FE-SETT-02 音量/静音持久化', () => {
  const store = storageWith();
  const s = createSettings({ storage: store, reducedMotion: { matches: false } });
  assert.equal(s.isMuted(), false);
  s.setMuted(true);
  assert.equal(s.isMuted(), true);
  assert.equal(store.storage.getItem(LS_KEYS.muted), 'true');

  s.setVolume(30);
  const s2 = createSettings({ storage: store, reducedMotion: { matches: false } });
  assert.equal(s2.getVolume(), 30); // 新实例读回持久化值
});

test('FE-SETT-03 reduced-motion 判定（注入式）', () => {
  const a = createSettings({ reducedMotion: { matches: true } });
  assert.equal(a.reducedMotion(), true);
  const b = createSettings({ reducedMotion: { matches: false } });
  assert.equal(b.reducedMotion(), false);
  // 无 matchMedia 环境回落 false
  const c = defaultReducedMotion();
  assert.equal(typeof c.matches, 'boolean');
});

test('FE-SETT-04 落子动画开关：默认开 / 关闭持久化 / 新实例读回', () => {
  assert.equal(STONE_MOTION_DEFAULT, true);
  const store = storageWith();
  const s = createSettings({ storage: store, reducedMotion: { matches: false } });
  assert.equal(s.stoneMotion(), true, '未设置 → 默认开');
  s.setStoneMotion(false);
  assert.equal(s.stoneMotion(), false);
  assert.equal(store.storage.getItem(LS_KEYS.stoneMotion), 'false');
  assert.equal(LS_KEYS.stoneMotion, 'tgo.stone-motion');
  const s2 = createSettings({ storage: store, reducedMotion: { matches: false } });
  assert.equal(s2.stoneMotion(), false, '新实例读回持久化值');
  s2.setStoneMotion(true);
  assert.equal(s2.stoneMotion(), true);
});

test('FE-SETT-05 stoneMotionEnabled 无存储环境默认开（模块级，供 board 缺省读取）', () => {
  assert.equal(stoneMotionEnabled(), true);
});

test('FE-SETT-06 T6.10 偏好：显示 AI 匹配档位 / 预览步数 / 装饰纹理（默认+持久化+钳制）', () => {
  const store = storageWith();
  const s = createSettings({ storage: store, reducedMotion: { matches: false } });
  // 默认值
  assert.equal(s.showAiMatch(), true);
  assert.equal(s.previewSteps(), 10);
  assert.equal(s.decor(), false);
  assert.equal(LS_KEYS.showAiMatch, 'tgo.show-ai-match');
  assert.equal(LS_KEYS.previewSteps, 'tgo.preview-steps');
  assert.equal(LS_KEYS.decor, 'tgo.decor');
  // 写读 + 持久化
  s.setShowAiMatch(false);
  s.setPreviewSteps(7);
  s.setDecor(true);
  assert.equal(s.showAiMatch(), false);
  assert.equal(s.previewSteps(), 7);
  assert.equal(s.decor(), true);
  assert.equal(store.storage.getItem(LS_KEYS.showAiMatch), 'false');
  assert.equal(store.storage.getItem(LS_KEYS.previewSteps), '7');
  // 预览步数越界钳制 [5,15]
  s.setPreviewSteps(3);
  assert.equal(s.previewSteps(), 5);
  s.setPreviewSteps(99);
  assert.equal(s.previewSteps(), 15);
  // 新实例读回
  const s2 = createSettings({ storage: store, reducedMotion: { matches: false } });
  assert.equal(s2.showAiMatch(), false);
  assert.equal(s2.decor(), true);
  assert.equal(s2.previewSteps(), 15);
});

test('FE-SETT-07 模块级偏好读取（clamp/get，无存储默认）', () => {
  assert.equal(clampPreviewSteps(6), 6);
  assert.equal(clampPreviewSteps(2), 5);
  assert.equal(clampPreviewSteps('x'), 10);
  assert.equal(getPreviewSteps(), 10);
  assert.equal(showAiMatchEnabled(), true);
  assert.equal(decorEnabled(), false);
});
