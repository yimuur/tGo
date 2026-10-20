/**
 * tGo · audio 无头单测（T5.4，node --test）
 * 用例 ID: FE-AUDIO-*
 * 覆盖：音效规格、播放许可策略（解锁×静音）、音量→增益映射、
 * 管理器解锁时机（未解锁不创建 AudioContext、解锁后才可发声）、
 * 多段音（提子）分段与延时调度。
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

import {
  SOUND_SPECS,
  shouldPlay,
  volumeToGain,
  createAudioManager,
} from '../static/js/core/audio.js';

function fakeCtx() {
  const calls = { osc: 0 };
  return {
    state: 'running',
    currentTime: 0,
    destination: {},
    createOscillator() {
      calls.osc += 1;
      return {
        type: '',
        frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
        connect() {},
        start() {},
        stop() {},
      };
    },
    createGain() {
      return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} };
    },
    resume: async () => {},
    _calls: calls,
  };
}

/** 记录振荡器参数的 fake AudioContext（多段音调度用例）。 */
function recordingCtx() {
  const osc = [];
  return {
    state: 'running',
    currentTime: 0,
    destination: {},
    createOscillator() {
      const rec = { type: '', freqSet: null, rampTarget: null };
      osc.push(rec);
      return {
        set type(v) { rec.type = v; },
        get type() { return rec.type; },
        frequency: {
          setValueAtTime(v) { rec.freqSet = v; },
          exponentialRampToValueAtTime(v) { rec.rampTarget = v; },
        },
        connect() {},
        start() {},
        stop() {},
      };
    },
    createGain() {
      return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} };
    },
    resume: async () => {},
    _osc: osc,
  };
}

test('FE-AUDIO-01 音效规格完整（UI_UX §6.3 四类）', () => {
  for (const name of ['stone', 'capture', 'success', 'warning']) {
    assert.ok(SOUND_SPECS[name], `缺少音效 ${name}`);
  }
  assert.equal(SOUND_SPECS.stone.durMs, 50);
  assert.equal(SOUND_SPECS.success.freqStart, 660);
  assert.equal(SOUND_SPECS.success.freqEnd, 880);
});

test('FE-AUDIO-06 提子为复合音（轻触＋下滑），不得＝落子重复（2026/09/15 人工反馈）', () => {
  const cap = SOUND_SPECS.capture;
  assert.ok(Array.isArray(cap.parts) && cap.parts.length >= 2, '提子应为多段复合音');
  const sweep = cap.parts.find((p) => p.freqStart !== undefined);
  assert.ok(sweep, '提子应含滑音段');
  assert.ok(sweep.freqEnd < sweep.freqStart, '提子滑音应向下（收子感），区别于成功提示的上行');
  assert.ok(sweep.durMs > SOUND_SPECS.stone.durMs, '提子音时长应长于落子短嗒');
  // 任一段不得与落子音同参（即“简单叠加两次”的回退会被本用例拦住）
  const stoneKey = JSON.stringify(SOUND_SPECS.stone);
  for (const part of cap.parts) {
    assert.notEqual(JSON.stringify({ ...part, delayMs: undefined }), stoneKey);
  }
});

test('FE-AUDIO-02 播放许可策略', () => {
  assert.equal(shouldPlay({ unlocked: true, muted: false }), true);
  assert.equal(shouldPlay({ unlocked: false, muted: false }), false);
  assert.equal(shouldPlay({ unlocked: true, muted: true }), false);
  assert.equal(shouldPlay({ unlocked: false, muted: true }), false);
});

test('FE-AUDIO-03 音量→增益映射与钳制', () => {
  assert.equal(volumeToGain(0), 0);
  assert.ok(Math.abs(volumeToGain(100) - 0.9) < 1e-9);
  assert.ok(volumeToGain(70) > volumeToGain(30));
  assert.ok(volumeToGain(-10) <= volumeToGain(0));
  assert.ok(volumeToGain(999) <= 0.9);
});

test('FE-AUDIO-04 解锁前不建 AudioContext；解锁后按静音策略发声', () => {
  const ctx = fakeCtx();
  let created = 0;
  let muted = false;
  const manager = createAudioManager({
    isMuted: () => muted,
    getVolume: () => 70,
    ctxFactory: () => {
      created += 1;
      return ctx;
    },
    listenTarget: null,
  });

  assert.equal(manager.isUnlocked(), false);
  manager.play('stone'); // 未解锁：直接跳过，不应创建 ctx
  assert.equal(created, 0);

  manager.unlock();
  assert.equal(manager.isUnlocked(), true);
  assert.equal(created, 1); // 解锁即创建（惰性）

  manager.play('stone'); // 未静音：允许 → 创建振荡器
  assert.equal(ctx._calls.osc, 1);

  muted = true;
  manager.play('success'); // 静音：跳过
  assert.equal(ctx._calls.osc, 1);
});

test('FE-AUDIO-05 未知音效/无 AudioContext 均静默', () => {
  const manager = createAudioManager({
    isMuted: () => false,
    getVolume: () => 70,
    ctxFactory: () => null, // 无 Web Audio
    listenTarget: null,
  });
  manager.unlock();
  manager.play('stone'); // ctx null：不抛
  manager.play('no-such-sound'); // 未知：不抛
});

test('FE-AUDIO-07 提子两段音：首段同步、次段按 delayMs 延后（模拟时间流）', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const ctx = recordingCtx();
    const manager = createAudioManager({
      isMuted: () => false,
      getVolume: () => 70,
      ctxFactory: () => ctx,
      listenTarget: null,
    });
    manager.unlock();
    manager.play('capture');
    assert.equal(ctx._osc.length, 1, '首段（无 delayMs）应同步发声');
    mock.timers.tick(45);
    assert.equal(ctx._osc.length, 2, '次段应在 delayMs 后发声');
    const [tap, sweep] = ctx._osc;
    assert.equal(tap.type, 'sine');
    assert.equal(tap.freqSet, 1200);
    assert.equal(sweep.type, 'triangle');
    assert.deepEqual([sweep.freqSet, sweep.rampTarget], [660, 200], '次段为下滑音');

    // 落子仍为单段平音：与提子音型不同
    manager.play('stone');
    assert.equal(ctx._osc.length, 3);
    assert.equal(ctx._osc[2].freqSet, 1800);
    assert.equal(ctx._osc[2].rampTarget, null);
  } finally {
    mock.timers.reset();
  }
});

test('FE-AUDIO-08 | L-11：后台挂起（suspended）先 resume 再合成；失败静默', async () => {
  const ctx = fakeCtx();
  let resumed = 0;
  const manager = createAudioManager({
    isMuted: () => false,
    getVolume: () => 70,
    ctxFactory: () => ctx,
    listenTarget: null,
  });
  manager.unlock();
  ctx.state = 'suspended'; // 模拟移动端后台挂起（解锁后才发生）
  ctx.resume = async () => {
    resumed += 1;
    ctx.state = 'running';
  };
  manager.play('stone');
  assert.equal(ctx._calls.osc, 0, 'resume 完成前不得合成（旧实现直接合成无声）');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resumed, 1);
  assert.equal(ctx._calls.osc, 1);

  // resume 拒绝：静默（不抛），后续仍可重试
  ctx.state = 'suspended';
  ctx.resume = async () => {
    throw new Error('resume failed');
  };
  manager.play('stone');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ctx._calls.osc, 1);
});
