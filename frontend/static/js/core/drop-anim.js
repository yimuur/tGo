/**
 * tGo · 云子落子动效模型（人手执子“斜放压平”下落；参照 WEBUI/yunzi-motion.html）
 *
 * 目的（2026/09/08 人工确认）：模拟棋手从真实高度把棋子放到棋盘上——棋子从“手高”
 * 处指数缓动下降，过程中垂直压缩（倾斜透视）+ 相对落点下移 + 动态柔和投影，落地瞬间
 * 以完全平贴形态衔接，无闪烁。
 *
 * 相对参考稿的三处工程化（人工确认）：
 *   1) **R 归一**：参考稿固定 z0=150px / 半径 18.5 → 起始高 ≈ 8.1R、最大 Y 下移 ≈ 2.7R、
 *      最大垂直压缩 0.4；本棋盘石径随 9/13/19 与缩放变化，全部按石径 R 换算，保证各路数
 *      观感一致；
 *   2) **dt 无关（帧率无关）**：参考稿每帧 `z += (0-z)*0.15` 与帧率耦合（60fps≈1s，低帧
 *      更慢更跳）；本模块用 elapsed 解析式 `z0·e^{−k·t}`，60/120Hz/低帧恒时长 ≈ DROP_MS；
 *   3) **落地无缝**：z 降至 landEpsR（2%·R）即判落地，绘制方须于当帧以“平贴静态”形态
 *      画一帧再移除动画项（见 board.js _drawState）。
 *
 * 本文件为纯函数层（顶层无 DOM），供 board.js 状态层渲染与无头单测（node --test）。
 */

/** 动效几何/时间参数（均以石径 R 归一或秒/毫秒计；可配置，禁止散落魔数）。 */
export const DROP_ANIM = Object.freeze({
  z0R: 10, // 起始“手高”（R 归一；参考 150px/R18.5≈8.1）
  decayPerSec: 7.5, // 指数衰减率 e^{−k·t}（/s，帧率无关）
  landEpsR: 0.02, // 落地判定高度（R 归一；2%·R 以下视为已落地）
  squashMax: 0.5, // 空中最大垂直压缩（scale(1, 1−ratio·0.4)，参考 0.4）
  yMaxR: 2.8, // 空中最大 Y 下移（R 归一；参考 50px/R18.5≈2.7）
});

/** 动画总时长（ms）＝从 z0R 指数衰减至 landEpsR 所需时间。 */
export const DROP_MS = Math.round(
  (Math.log(DROP_ANIM.z0R / DROP_ANIM.landEpsR) / DROP_ANIM.decayPerSec) * 1200,
);

/**
 * 当前高度（R 归一）：z0R 指数衰减到 0（低于 landEpsR 即返回 0）。
 * @param {number} elapsedMs 距起始的毫秒
 * @returns {number} ≥0
 */
export function dropZR(elapsedMs) {
  const t = Math.max(0, Number(elapsedMs) || 0);
  const z = DROP_ANIM.z0R * Math.exp((-DROP_ANIM.decayPerSec * t) / 1000);
  return z < DROP_ANIM.landEpsR ? 0 : z;
}

/** 是否已落地（高度 ≤ landEpsR）。 */
export function isDropLanded(elapsedMs) {
  return dropZR(elapsedMs) <= 0;
}

/**
 * 剩余高度占比（1=空中起点 → 0=落地）。
 * @param {number} elapsedMs
 * @returns {number} [0,1]
 */
export function dropRatio(elapsedMs) {
  return Math.min(1, dropZR(elapsedMs) / DROP_ANIM.z0R);
}

/** 垂直压缩系数 squash（1=正圆 → 1−squashMax 最扁）。 */
export function dropSquash(ratio) {
  const r = Math.min(1, Math.max(0, Number(ratio) || 0));
  return 1 - r * DROP_ANIM.squashMax;
}

/** Y 下移（R 归一；随高度减小线性回落到 0）。 */
export function dropYOffR(ratio) {
  const r = Math.min(1, Math.max(0, Number(ratio) || 0));
  return r * DROP_ANIM.yMaxR;
}
