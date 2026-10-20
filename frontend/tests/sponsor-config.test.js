/**
 * tGo · 赞助配置纯数据层无头单测（FE-SPON-*，node --test）
 *
 * 覆盖：源顺序、仓库/分支规范化、图片地址解析（相对/绝对/https/越界拒绝）、
 * 配置结构校验、金额/方式取值、jsDelivr→raw 回退、超时错误归一。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { sponsorChargeProgress, SPONSOR_CHARGE_MS } from '../static/js/core/sponsor.js';

import {
  DEFAULT_GITHUB_REPO,
  SPONSOR_AMOUNTS,
  SPONSOR_METHODS,
  SponsorConfigError,
  normalizeGithubRepo,
  normalizeGithubBranch,
  sponsorConfigSources,
  resolveSponsorAssetUrl,
  parseSponsorConfig,
  selectSponsorQr,
  sponsorQrUrls,
  sponsorMethodLabel,
  sponsorAmountLabel,
  loadSponsorConfig,
} from '../static/js/core/sponsor-config.js';

function validRaw(overrides = {}) {
  return {
    version: 3,
    wechat: {
      qr: {
        8: 'wechat_qr/8.png',
        18: 'wechat_qr/18.png',
      },
    },
    alipay: {
      qr: {
        8: 'alipay_qr/8.png',
        18: 'alipay_qr/18.png',
      },
    },
    ...overrides,
  };
}

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  };
}

const STATIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'static');
function readStatic(relative) {
  return readFileSync(path.join(STATIC_DIR, relative), 'utf8');
}

const BASE = 'https://cdn.jsdelivr.net/gh/yimuur/tGo@main/frontend/sponsor/';
const RAW_BASE = 'https://raw.githubusercontent.com/yimuur/tGo/main/frontend/sponsor/';

/* ---------- 源与命名规范化 ---------- */

test('FE-SPON-01 默认源顺序：jsDelivr → GitHub raw，目录为 frontend/sponsor', () => {
  const sources = sponsorConfigSources(DEFAULT_GITHUB_REPO, 'main');
  assert.equal(sources.length, 2);
  assert.equal(sources[0].id, 'jsdelivr');
  assert.equal(sources[0].configUrl, `${BASE}sponsor.json`);
  assert.equal(sources[0].baseUrl, BASE);
  assert.equal(sources[1].id, 'raw');
  assert.equal(sources[1].configUrl, `${RAW_BASE}sponsor.json`);
  assert.equal(sources[1].baseUrl, RAW_BASE);
});

test('FE-SPON-02 仓库/分支非法值回退默认，防 URL 注入', () => {
  assert.equal(normalizeGithubRepo('yimuur/tGo'), 'yimuur/tGo');
  assert.equal(normalizeGithubRepo('bad repo/name'), DEFAULT_GITHUB_REPO);
  assert.equal(normalizeGithubRepo('../../etc/passwd'), DEFAULT_GITHUB_REPO);
  assert.equal(normalizeGithubRepo('../evil'), DEFAULT_GITHUB_REPO);
  assert.equal(normalizeGithubRepo('owner/..'), DEFAULT_GITHUB_REPO);
  assert.equal(normalizeGithubRepo('/name'), DEFAULT_GITHUB_REPO);
  assert.equal(normalizeGithubRepo(''), DEFAULT_GITHUB_REPO);
  assert.equal(normalizeGithubBranch('main'), 'main');
  assert.equal(normalizeGithubBranch('release/1.0'), 'release/1.0');
  assert.equal(normalizeGithubBranch('../evil'), 'main');
  assert.equal(normalizeGithubBranch('/evil'), 'main');
  assert.equal(normalizeGithubBranch(''), 'main');
});

/* ---------- 图片地址解析 ---------- */

test('FE-SPON-03 相对图片地址按成功源解析并追加版本参数', () => {
  assert.equal(
    resolveSponsorAssetUrl('wechat_qr/8.png', BASE, '3', 'wechat.qr.8'),
    `${BASE}wechat_qr/8.png?v=3`,
  );
  assert.equal(
    resolveSponsorAssetUrl('alipay_qr/18.png', RAW_BASE, '3', 'alipay.qr.18'),
    `${RAW_BASE}alipay_qr/18.png?v=3`,
  );
  // 无版本时不追加查询参数
  assert.equal(
    resolveSponsorAssetUrl('wechat_qr/8.png', BASE, '', 'wechat.qr.8'),
    `${BASE}wechat_qr/8.png`,
  );
});

test('FE-SPON-04 绝对地址仅允许 https；协议相对/绝对路径/越界/非 https 一律拒绝', () => {
  assert.equal(
    resolveSponsorAssetUrl('https://example.com/qr.png', BASE, '3', 'qr'),
    'https://example.com/qr.png',
  );
  for (const bad of ['http://example.com/qr.png', 'data:image/png;base64,abc', 'javascript:alert(1)', '//cdn.example.com/qr.png', '/qr.png', '../qr.png', 'a/../../qr.png', '']) {
    assert.throws(
      () => resolveSponsorAssetUrl(bad, BASE, '3', 'qr'),
      (err) => err instanceof SponsorConfigError && err.code === 'SPONSOR_CONFIG_INVALID',
      `应拒绝地址：${bad}`,
    );
  }
});

/* ---------- 配置结构 ---------- */

test('FE-SPON-05 合法配置归一化：两种方式 × 两档金额，相对路径全部解析', () => {
  const config = parseSponsorConfig(validRaw(), BASE);
  assert.equal(config.version, '3');
  assert.deepEqual(Object.keys(config.methods), ['wechat', 'alipay']);
  assert.deepEqual(Object.keys(config.methods.wechat.qr), ['8', '18']);
  assert.equal(config.methods.wechat.qr['8'], `${BASE}wechat_qr/8.png?v=3`);
  assert.equal(config.methods.alipay.qr['18'], `${BASE}alipay_qr/18.png?v=3`);
  assert.equal(selectSponsorQr(config, 'wechat', 8), `${BASE}wechat_qr/8.png?v=3`);
  assert.equal(selectSponsorQr(config, 'alipay', 18), `${BASE}alipay_qr/18.png?v=3`);
  assert.equal(selectSponsorQr(config, 'wechat', 99), null);
  assert.equal(selectSponsorQr(config, 'unknown', 8), null);
  assert.deepEqual(sponsorQrUrls(config), [
    `${BASE}wechat_qr/8.png?v=3`,
    `${BASE}wechat_qr/18.png?v=3`,
    `${BASE}alipay_qr/8.png?v=3`,
    `${BASE}alipay_qr/18.png?v=3`,
  ]);
});

test('FE-SPON-06 配置缺方式/缺金额/非对象均报 INVALID', () => {
  assert.throws(
    () => parseSponsorConfig(null, BASE),
    (err) => err instanceof SponsorConfigError && err.code === 'SPONSOR_CONFIG_INVALID',
  );
  assert.throws(
    () => parseSponsorConfig({ version: 1, wechat: { qr: { 8: 'a.png' } } }, BASE),
    (err) => err instanceof SponsorConfigError && err.code === 'SPONSOR_CONFIG_INVALID',
  );
  const missingTier = validRaw();
  delete missingTier.wechat.qr['18'];
  assert.throws(
    () => parseSponsorConfig(missingTier, BASE),
    (err) => err instanceof SponsorConfigError && err.code === 'SPONSOR_CONFIG_INVALID',
  );
});

test('FE-SPON-07 固定文案：默认微信/8 元，档位与方法顺序稳定', () => {
  assert.deepEqual(
    SPONSOR_METHODS.map((m) => m.id),
    ['wechat', 'alipay'],
  );
  assert.deepEqual(
    SPONSOR_AMOUNTS.map((a) => a.amount),
    [8, 18],
  );
  assert.equal(sponsorMethodLabel('wechat'), '微信');
  assert.equal(sponsorMethodLabel('alipay'), '支付宝');
  assert.equal(sponsorAmountLabel(8), '请作者尝杯清茶');
  assert.equal(sponsorAmountLabel(18), '请作者喝壶浓茶');
  assert.equal(sponsorAmountLabel(99), '');
});

/* ---------- 远程加载与回退 ---------- */

test('FE-SPON-08 首要源成功：直接返回 jsDelivr 配置，不再请求 raw', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    return jsonResponse(validRaw());
  };
  const result = await loadSponsorConfig({ fetchImpl });
  assert.equal(result.source.id, 'jsdelivr');
  assert.equal(calls.length, 1);
  assert.equal(calls[0], `${BASE}sponsor.json`);
  assert.equal(result.config.methods.wechat.qr['8'], `${BASE}wechat_qr/8.png?v=3`);
});

test('FE-SPON-09 首要源失败/配置格式无效：回退 raw 并以其路径解析图片', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    const key = String(url);
    calls.push(key);
    if (key === `${BASE}sponsor.json`) return jsonResponse({ bad: true });
    return jsonResponse(validRaw());
  };
  const result = await loadSponsorConfig({ fetchImpl });
  assert.equal(result.source.id, 'raw');
  assert.equal(calls.length, 2);
  assert.equal(result.config.methods.wechat.qr['8'], `${RAW_BASE}wechat_qr/8.png?v=3`);
});

test('FE-SPON-10 全部源不可用：抛 UNAVAILABLE 并保留尝试明细', async () => {
  const fetchImpl = async () => jsonResponse({}, 404);
  await assert.rejects(
    () => loadSponsorConfig({ fetchImpl }),
    (err) =>
      err instanceof SponsorConfigError &&
      err.code === 'SPONSOR_CONFIG_UNAVAILABLE' &&
      err.details &&
      err.details.attempts.length === 2,
  );
});

test('FE-SPON-11 全部源配置格式均无效：抛 INVALID', async () => {
  const fetchImpl = async () => jsonResponse({ bad: true });
  await assert.rejects(
    () => loadSponsorConfig({ fetchImpl }),
    (err) => err instanceof SponsorConfigError && err.code === 'SPONSOR_CONFIG_INVALID',
  );
});

test('FE-SPON-12 蓄力进度钳制在 0..1（3 秒完成）', () => {
  assert.equal(SPONSOR_CHARGE_MS, 3000);
  assert.equal(sponsorChargeProgress(-100), 0);
  assert.equal(sponsorChargeProgress(0), 0);
  assert.equal(sponsorChargeProgress(1500), 0.5);
  assert.equal(sponsorChargeProgress(3000), 1);
  assert.equal(sponsorChargeProgress(9000), 1);
  assert.equal(sponsorChargeProgress(Number.NaN), 0);
});

test('FE-SPON-14 顶栏赞助按钮契约：文案/tooltip/茶盏图标/液体层', () => {
  const html = readStatic('index.html');
  assert.match(html, /id="cta-sponsor"[^>]*data-tip="蓄力长按，以添清茶"/);
  assert.match(html, /class="sponsor-liquid"/);
  assert.match(html, /<use href="#i-tea"\/><\/svg><span class="sponsor-label">添盏清茶<\/span>/);
  assert.match(readStatic('js/icons.js'), /'i-tea'/);
});

test('FE-SPON-15 管理路由 CTA 切换契约：显示赞助、隐藏新对局', () => {
  const js = readStatic('js/app.js');
  assert.match(js, /const isAdminView = routeName === 'admin'/);
  assert.match(js, /ctaCreate\.classList\.toggle\('hidden', isReviewView \|\| isAdminView\)/);
  assert.match(js, /sponsorController\.setActive\(isAdminView\)/);
});

test('FE-SPON-16 赞助卡片 Powered by 链接：可点击进入仓库主页', () => {
  const js = readStatic('js/core/sponsor.js');
  assert.match(js, /Powered by yimuur/);
  assert.match(js, /https:\/\/github\.com\/\$\{normalizeGithubRepo\(state\.repo \|\| DEFAULT_GITHUB_REPO\)\}/);
  assert.match(js, /target="_blank" rel="noopener noreferrer"/);
});

test('FE-SPON-17 二维码按窗口整形：等比适配不同尺寸 PNG + 安全内边距', () => {
  const css = readStatic('css/app.css');
  assert.match(css, /--sponsor-qr-size:\s*clamp\(184px,\s*min\(62vw,\s*34vh\),\s*232px\)/);
  assert.match(css, /\.sponsor-qr-stage\s*\{[^}]*height:\s*var\(--sponsor-qr-size\);[^}]*\}/s);
  assert.match(css, /\.sponsor-qr-stage\s*\{[^}]*padding:\s*clamp\(8px,\s*2\.4vw,\s*12px\);[^}]*\}/s);
  assert.match(css, /\.sponsor-qr-img\s*\{[^}]*object-fit:\s*contain;[^}]*object-position:\s*center;[^}]*\}/s);
  assert.match(css, /\.sponsor-qr-img\[hidden\]\s*\{\s*display:\s*none;\s*\}/);
});

test('FE-SPON-18 顶栏品牌 Logo：新标签打开 GitHub 仓库主页', () => {
  const html = readStatic('index.html');
  assert.match(html, /<a class="brand" id="brand-link"[^>]*href="https:\/\/github\.com\/yimuur\/tGo"[^>]*target="_blank"[^>]*rel="noopener noreferrer"[^>]*data-tip="打开 GitHub 仓库主页"/s);
  const js = readStatic('js/app.js');
  assert.match(js, /setBrandRepo\(app\.data\.app\.repo\)/);
  assert.match(js, /api\.get\('\/admin\/app'/);
});

test('FE-SPON-13 请求超时归一为 UNAVAILABLE（不向调用方抛 AbortError）', async () => {
  const fetchImpl = (url, opts) =>
    new Promise((_resolve, reject) => {
      const signal = opts && opts.signal;
      if (signal) {
        signal.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        }, { once: true });
      }
    });
  const sources = [
    {
      id: 'only',
      label: 'only',
      baseUrl: BASE,
      configUrl: `${BASE}sponsor.json`,
    },
  ];
  await assert.rejects(
    () => loadSponsorConfig({ fetchImpl, timeoutMs: 10, sources }),
    (err) => err instanceof SponsorConfigError && err.code === 'SPONSOR_CONFIG_UNAVAILABLE',
  );
});
