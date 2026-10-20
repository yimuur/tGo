/**
 * tGo · route.js 无头单测（T5.1，node --test）
 * 用例 ID: FE-ROUTE-*
 * 覆盖：parseHash / normalizeRoute / buildHash / navKeyOf 纯函数矩阵。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ROUTES,
  NAV_ITEMS,
  parseHash,
  normalizeRoute,
  buildHash,
  navKeyOf,
} from '../static/js/core/route.js';

test('FE-ROUTE-01 路由表结构完整', () => {
  const names = ROUTES.map((r) => r.name);
  assert.deepEqual(names, ['game', 'create', 'review-list', 'review', 'report', 'admin']);
  assert.equal(NAV_ITEMS.length, 3);
  // 导航键＝ROUTES[].nav（页面 data-route 取同名值；漂移曾致复盘 tab 高亮失效，FE-CTR-05 守门）
  assert.deepEqual(NAV_ITEMS.map((i) => i.key), ['game', 'review', 'admin']);
});

test('FE-ROUTE-02 parseHash：默认/根路由', () => {
  for (const hash of ['', '#', '#/']) {
    const r = parseHash(hash);
    assert.equal(r.name, 'game');
    assert.equal(r.label, '对弈');
    assert.deepEqual(r.params, {});
  }
});

test('FE-ROUTE-03 parseHash：静态子路由', () => {
  assert.equal(parseHash('#/admin').name, 'admin');
  assert.equal(parseHash('#/review').name, 'review-list');
  assert.equal(parseHash('#/create').name, 'create');
  assert.equal(parseHash('#/create/').name, 'create'); // 尾斜杠归一
});

test('FE-ROUTE-04 parseHash：参数路由与 query', () => {
  const rev = parseHash('#/review/12');
  assert.equal(rev.name, 'review');
  assert.equal(rev.params.id, '12');

  const report = parseHash('#/report/7?p=B');
  assert.equal(report.name, 'report');
  assert.equal(report.params.id, '7');
  assert.deepEqual(report.query, { p: 'B' });
});

test('FE-ROUTE-05 parseHash：未知路由', () => {
  const r = parseHash('#/whatever');
  assert.equal(r.name, 'unknown');
});

test('FE-ROUTE-06 normalizeRoute：未知/空兜底对弈且保留 query', () => {
  assert.equal(normalizeRoute('#/no-such').name, 'game');
  const n = normalizeRoute('#/no-such?x=1');
  assert.equal(n.name, 'game');
  assert.deepEqual(n.query, { x: '1' });
  assert.equal(normalizeRoute('').name, 'game');
});

test('FE-ROUTE-07 buildHash：往返一致性', () => {
  assert.equal(buildHash('game'), '#/');
  assert.equal(buildHash('create'), '#/create');
  assert.equal(buildHash('review-list'), '#/review');
  assert.equal(buildHash('admin'), '#/admin');
  assert.equal(buildHash('review', { id: 12 }), '#/review/12');
  assert.equal(buildHash('report', { id: 7 }, { p: 'B' }), '#/report/7?p=B');
});

test('FE-ROUTE-08 buildHash：空 query 值省略、未知名兜底', () => {
  assert.equal(buildHash('report', { id: 1 }, { p: '' }), '#/report/1');
  assert.equal(buildHash('unknown-name'), '#/');
});

test('FE-ROUTE-09 parse→build→parse 幂等', () => {
  const hashes = ['#/', '#/create', '#/review', '#/review/33', '#/report/9?p=W', '#/admin'];
  for (const hash of hashes) {
    const r = parseHash(hash);
    const rebuilt = buildHash(r.name, r.params, r.query);
    const r2 = parseHash(rebuilt);
    assert.equal(r2.name, r.name, `roundtrip name for ${hash}`);
    assert.deepEqual(r2.params, r.params, `roundtrip params for ${hash}`);
    assert.deepEqual(r2.query, r.query, `roundtrip query for ${hash}`);
  }
});

test('FE-ROUTE-10 navKeyOf：顶栏高亮映射', () => {
  assert.equal(navKeyOf('game'), 'game');
  assert.equal(navKeyOf('review-list'), 'review');
  assert.equal(navKeyOf('review'), 'review');
  assert.equal(navKeyOf('admin'), 'admin');
  assert.equal(navKeyOf('create'), null);
  assert.equal(navKeyOf('report'), null);
  assert.equal(navKeyOf('unknown'), null);
});
