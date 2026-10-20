/**
 * tGo · rest-client.js 无头单测（T5.3，node --test）
 * 用例 ID: FE-REST-*
 * 覆盖：请求/query/JSON、{code,message} 错误信封映射、202 Accepted 语义、
 * 网络失败包装、错误码→用户文案映射。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ApiError,
  createRestClient,
  errorText,
  ERROR_TEXT,
  DEFAULT_TIMEOUT_MS,
} from '../static/js/core/rest-client.js';

/** 构造可控 fetch 响应。 */
function jsonResponse(status, body, { ok } = {}) {
  const isOk = ok !== undefined ? ok : status >= 200 && status < 300;
  return {
    ok: isOk,
    status,
    async text() {
      return body === undefined ? '' : JSON.stringify(body);
    },
  };
}

function makeFetch() {
  const calls = [];
  const impl = async (url, init) => {
    const call = { url, init: init || {} };
    calls.push(call);
    return jsonResponse(200, { ok: true, url: String(url) });
  };
  return { impl, calls };
}

test('FE-REST-01 GET 成功 + query 序列化', async () => {
  const { impl, calls } = makeFetch();
  const client = createRestClient({ fetchImpl: impl });
  const res = await client.get('/games', { status: 'active', page: 2, page_size: 20, empty: '' });
  assert.equal(res.status, 200);
  assert.equal(res.accepted, false);
  const url = calls[0].url;
  assert.ok(url.includes('/api/games'), url);
  assert.ok(url.includes('status=active'));
  assert.ok(url.includes('page=2'));
  assert.ok(!url.includes('empty'), '空值参数应省略');
});

test('FE-REST-01b 数组 query → 重复参数键（列表 status 多值 OR）', async () => {
  const { impl, calls } = makeFetch();
  const client = createRestClient({ fetchImpl: impl });
  await client.get('/games', { status: ['created', 'active', 'scoring'], page: 1, fav: null, name: '' });
  const url = calls[0].url;
  assert.equal(calls[0].init.method, 'GET');
  assert.ok(url.includes('status=created'), url);
  assert.ok(url.includes('status=active'), url);
  assert.ok(url.includes('status=scoring'), url);
  // 数组内空值/整参数空值均省略
  assert.ok(!url.includes('fav='), url);
  assert.ok(!url.includes('name='), url);
  const occurrences = url.match(/status=/g) || [];
  assert.equal(occurrences.length, 3, '同一键应重复出现 3 次');
});

test('FE-REST-02 POST JSON 载荷', async () => {
  const { impl, calls } = makeFetch();
  const client = createRestClient({ fetchImpl: impl });
  const payload = { mode: 'human_ai', board_size: 19 };
  await client.post('/games', payload);
  const init = calls[0].init;
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(init.body), payload);
});

test('FE-REST-03 错误信封抛 ApiError（code/message/data）', async () => {
  const impl = async (url, init) => jsonResponse(422, { code: 'ILLEGAL_MOVE', message: '禁入点/打劫，请另选位置' }, { ok: false });
  const client = createRestClient({ fetchImpl: impl });
  await assert.rejects(
    client.post('/games/1/moves', {}),
    (err) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.status, 422);
      assert.equal(err.code, 'ILLEGAL_MOVE');
      assert.equal(err.message, '禁入点/打劫，请另选位置');
      assert.equal(err.data.code, 'ILLEGAL_MOVE');
      return true;
    },
  );
});

test('FE-REST-04 非 JSON 错误页 → 通用错误码', async () => {
  const impl = async () => ({ ok: false, status: 500, async text() { return '<html>Internal Server Error</html>'; } });
  const client = createRestClient({ fetchImpl: impl });
  await assert.rejects(client.get('/games'), (err) => {
    assert.equal(err.code, 'HTTP_500');
    assert.ok(err.message.includes('500'));
    return true;
  });
});

test('FE-REST-05 202 Accepted 语义（accepted:true 且不抛错）', async () => {
  const impl = async () => jsonResponse(202, { message: '已排队' });
  const client = createRestClient({ fetchImpl: impl });
  const res = await client.post('/admin/engines/stop');
  assert.equal(res.status, 202);
  assert.equal(res.accepted, true);
  assert.deepEqual(res.data, { message: '已排队' });
});

test('FE-REST-06 网络失败包装为 NETWORK_ERROR', async () => {
  const impl = async () => {
    throw new TypeError('Failed to fetch');
  };
  const client = createRestClient({ fetchImpl: impl });
  await assert.rejects(client.get('/games'), (err) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.status, 0);
    assert.equal(err.code, 'NETWORK_ERROR');
    return true;
  });
});

test('FE-REST-07 错误码→用户文案映射', () => {
  assert.equal(errorText('ILLEGAL_MOVE'), ERROR_TEXT.ILLEGAL_MOVE);
  assert.equal(errorText('UNDO_LIMIT_REACHED'), '悔棋次数已达上限');
  // B2：人类模型不可用（人类风格对局阻断提示）
  assert.equal(errorText('HUMAN_MODEL_UNAVAILABLE'), '人类模型不可用：请恢复人类模型后重试');
  // ISSUE-064：存量对局回放冲突（领域化错误码，非 INTERNAL_ERROR）
  assert.equal(errorText('REPLAY_CONFLICT'), '该对局无法回放（历史数据与当前规则不符）');
  // BUG-082：请求超时（移动端悬挂网络 → 可重试错误态）
  assert.equal(errorText('TIMEOUT'), ERROR_TEXT.TIMEOUT);
  assert.equal(errorText('NO_SUCH_CODE'), 'NO_SUCH_CODE'); // 未知码回退
  assert.ok(Object.keys(ERROR_TEXT).length >= 10);
});

test('FE-REST-08 自定义 baseUrl 去尾斜杠', async () => {
  const { impl, calls } = makeFetch();
  const client = createRestClient({ baseUrl: 'https://tgo.local/api/', fetchImpl: impl });
  await client.get('/health');
  assert.ok(calls[0].url.startsWith('https://tgo.local/api/health'));
});

/* ---------------- BUG-082：请求超时（移动端悬挂网络防护） ---------------- */

test('FE-REST-09 请求超时：悬挂 fetch 在 timeoutMs 后中止 → ApiError(TIMEOUT)', async () => {
  let aborted = false;
  const impl = (url, init = {}) =>
    new Promise((_resolve, reject) => {
      assert.ok(init.signal, '默认请求必须携带 AbortSignal');
      init.signal.addEventListener('abort', () => {
        aborted = true;
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
  const client = createRestClient({ fetchImpl: impl });
  await assert.rejects(client.get('/games', undefined, { timeoutMs: 20 }), (err) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.status, 0);
    assert.equal(err.code, 'TIMEOUT');
    return true;
  });
  assert.equal(aborted, true, '超时必须中止底层 fetch（AbortController）');
});

test('FE-REST-11 响应体读取悬挂同样触发超时（M-12：超时闸覆盖 res.text）', async () => {
  // 旧实现：fetch resolve 即 clearTimeout → 头已回、体悬挂时请求永不超时。
  const impl = async (url, init) => ({
    ok: true,
    status: 200,
    text: () => new Promise((_resolve, reject) => {
      const signal = init && init.signal;
      if (!signal) {
        reject(new Error('未启用超时（signal 缺失）'));
        return;
      }
      signal.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    }),
  });
  const client = createRestClient({ fetchImpl: impl });
  const hung = new Promise((_resolve, reject) => {
    setTimeout(() => reject(new Error('请求未被超时中止：body 读取不受超时闸保护（M-12 回归）')), 1000);
  });
  await assert.rejects(
    Promise.race([client.get('/games', undefined, { timeoutMs: 20 }), hung]),
    (err) => {
      assert.equal(err.code, 'TIMEOUT');
      return true;
    },
  );
});

test('FE-REST-10 默认超时常量 + timeoutMs=0 关闭超时（无 signal）', async () => {
  const { impl, calls } = makeFetch();
  const client = createRestClient({ fetchImpl: impl });
  await client.get('/health');
  assert.ok(calls[0].init.signal, '默认请求应带 AbortSignal（防永久悬挂）');
  assert.ok(DEFAULT_TIMEOUT_MS >= 1000 && DEFAULT_TIMEOUT_MS <= 60_000, DEFAULT_TIMEOUT_MS);
  await client.get('/health', undefined, { timeoutMs: 0 });
  assert.equal(calls[1].init.signal, undefined, 'timeoutMs=0 → 不设超时不带 signal');
});

test('FE-REST-11 正常响应不触发超时（定时器清理，后续请求不受影响）', async () => {
  const { impl, calls } = makeFetch();
  const client = createRestClient({ fetchImpl: impl });
  const t0 = Date.now();
  await client.get('/games');
  await client.get('/games');
  assert.equal(calls.length, 2);
  assert.ok(Date.now() - t0 < 1000, '正常响应不应等待超时');
});
