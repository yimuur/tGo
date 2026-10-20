/**
 * tGo · 棋谱导入（SGF，T6.7）
 *
 * 复盘视图（review-list/review）顶栏 [+创建对局] 原地演化为 [导入棋谱]（UI_UX §5.5.1 /
 * §3.3），点击唤起系统文件选择器 → multipart 上传 ``POST /api/games/import``：
 *   - 成功：Toast「已导入：黑 vs 白」→ 进入该局回放（§5.5.1 导入约定）；
 *   - 失败：``SGF_INVALID`` / ``SGF_TOO_LARGE`` 对应文案 Toast，停留当前列表可再次
 *     点击重试（§6.4 / §10「保留页面供重试」口径，2026/09/06 人工确认：文件选择器 +
 *     错误 Toast + 停留列表可重试，无持久弹层）。
 *
 * 顶层纯函数（checkSgfFile / 文案派生）可无头测试；DOM 装配（attachSgfImporter）
 * 为浏览器薄胶水（人工验收轮覆盖）。
 */
import { errorText } from './rest-client.js';

/** 文件选择器 accept（SGF MIME 常见声明，浏览器按扩展名/声明过滤）。 */
export const SGF_ACCEPT = '.sgf,application/x-go-sgf,application/sgf';

/** 顶栏按钮 title（人工反馈：提示信息统一为「导入棋谱（SGF）」；≤5MB/≤2000 手 限定在错误 Toast 与 UI_UX §5.5.1 口径中说明）。 */
export const SGF_HINT = '导入棋谱（SGF）';

/** 客户端预检上限（后端另有权威校验，先本地快速失败免上传）。 */
export const SGF_MAX_BYTES = 5 * 1024 * 1024;

/** 导入请求进行中的按钮文案。 */
export const IMPORT_BUSY_TEXT = '导入中…';

/**
 * [导入棋谱] 忙碌态文本载体解析（纯函数，2026/09/19 BUG-107）。
 *
 * 按钮内容＝``<svg class="icon">…</svg><span data-ref="ctaImportLabel">导入棋谱</span>``——
 * 忙碌态**只能改写标签节点文本**：旧实现直接整串覆盖按钮 textContent，会把 `<svg>` 图标
 * 一并抹掉（实测：导入完成后顶栏按钮图标丢失，BUG-107）。标签节点缺失时回退按钮本体
 * （兼容旧模板；但模板必须带标签节点，由守门用例约束）。
 * @param {{querySelector?:Function, textContent?:string}} cta
 * @returns {{target:object|null, label:string}} target＝实际承载文本的节点
 */
export function importCtaLabelTarget(cta) {
  if (!cta) return { target: null, label: '' };
  const found = typeof cta.querySelector === 'function'
    ? cta.querySelector('[data-ref="ctaImportLabel"]')
    : null;
  const target = found || cta;
  return { target, label: target.textContent || '' };
}

/**
 * 客户端文件预检（大小/空文件；编码与合法性由服务端 parse 校验）。
 * @param {{name?:string, size?:number}} file
 * @returns {{ok:true, file:object}|{ok:false, code:string}}
 */
export function checkSgfFile(file) {
  if (!file) return { ok: false, code: 'SGF_INVALID' };
  const size = Number(file.size);
  if (!Number.isFinite(size) || size <= 0) return { ok: false, code: 'SGF_INVALID' };
  if (size > SGF_MAX_BYTES) return { ok: false, code: 'SGF_TOO_LARGE' };
  return { ok: true, file };
}

/**
 * 对局标题「黑名 vs 白名」（导入成功 Toast 用；缺名回退 真人/AI 与后端默认一致）。
 * @param {{black_name?:string, white_name?:string}} [game]
 * @returns {string}
 */
export function gameTitleOf(game) {
  const black = (game && game.black_name) || '真人';
  const white = (game && game.white_name) || '真人';
  return `${black} vs ${white}`;
}

/** 成功 Toast 文案（UI_UX §5.5.1：「已导入：黑 vs 白」）。 */
export function importSuccessText(game) {
  return `已导入：${gameTitleOf(game)}`;
}

/**
 * 上传异常 → Toast 载荷（网络/HTTP/业务错误统一；成功返回 null）。
 * @param {Error} err  ApiError 或任意异常
 * @returns {{code:string, level:'error'}|null}
 */
export function importErrorToast(err) {
  if (!err) return null;
  const code = (err && err.code) || 'NETWORK_ERROR';
  const level = 'error';
  const text = errorText(code);
  return { code, message: text, level, key: 'sgf-import' };
}

/**
 * 装配顶栏 [导入棋谱]：隐藏 file input + 上传 + Toast + 回调。
 * @param {object} deps
 * @param {HTMLElement} deps.cta           导入按钮（[导入棋谱]）
 * @param {object} deps.api                REST 客户端（取详情用 api.get）
 * @param {string} [deps.apiBase='/api']   multipart 上传目标前缀
 * @param {(opts:object)=>void} deps.toast Toast 派发（{level,text,code,key}）
 * @param {(detail:object)=>void} deps.onImported 成功回调（game detail，含 gameId）
 * @param {typeof fetch} [deps.fetchImpl]
 * @param {Document} [deps.doc]
 * @returns {{destroy():void}}
 */
export function attachSgfImporter(deps = {}) {
  const doc = deps.doc || (typeof document !== 'undefined' ? document : null);
  const cta = deps.cta;
  if (!doc || !cta) return { destroy() {} };

  const api = deps.api || {};
  const apiBase = String(deps.apiBase || '/api').replace(/\/+$/, '');
  const toast = deps.toast || (() => {});
  const onImported = deps.onImported || (() => {});
  const fetchImpl =
    deps.fetchImpl ||
    (typeof globalThis !== 'undefined' && globalThis.fetch ? globalThis.fetch.bind(globalThis) : null);

  const input = doc.createElement('input');
  input.type = 'file';
  input.accept = SGF_ACCEPT;
  input.className = 'hidden';
  input.setAttribute('aria-hidden', 'true');
  input.tabIndex = -1;
  doc.body.appendChild(input);

  let busy = false;
  // 按钮文本由独立标签节点承载（BUG-107）：忙碌态只改写标签，保留 <svg> 图标
  const { target: labelEl, label: ctaLabel } = importCtaLabelTarget(cta);

  function setBusy(next) {
    busy = next;
    cta.disabled = next;
    if (labelEl) labelEl.textContent = next ? IMPORT_BUSY_TEXT : ctaLabel;
  }

  /** 上传流程（multipart）。 */
  async function upload(file) {
    setBusy(true);
    try {
      const form = new FormData();
      form.append('file', file, file.name || 'game.sgf');
      const res = await fetchImpl(`${apiBase}/games/import`, { method: 'POST', body: form });
      let data = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }
      if (!res.ok) {
        const err = new Error((data && data.message) || '导入失败');
        err.status = res.status;
        err.code = (data && data.code) || `HTTP_${res.status}`;
        throw err;
      }
      const gameId = data && Number(data.game_id);
      if (!Number.isInteger(gameId) || gameId <= 0) {
        const err = new Error('导入响应缺少 game_id');
        err.code = 'INTERNAL_ERROR';
        throw err;
      }
      // 详情取「黑 vs 白」标题（Toast 文案 §5.5.1）
      let detail = null;
      try {
        const resDetail = await api.get(`/games/${gameId}`);
        detail = resDetail && resDetail.data;
      } catch {
        detail = { game_id: gameId, black_name: null, white_name: null };
      }
      toast({ level: 'success', text: importSuccessText(detail), key: 'sgf-import' });
      onImported(detail && detail.id !== undefined ? detail : { ...(detail || {}), id: gameId, game_id: gameId });
    } catch (err) {
      const t = importErrorToast(err);
      if (t) toast(t);
    } finally {
      setBusy(false);
      input.value = ''; // 允许再次选择同一文件重试
    }
  }

  function onChange() {
    const file = input.files && input.files[0];
    const check = checkSgfFile(file);
    if (!check.ok) {
      toast({ code: check.code, level: 'error', key: 'sgf-import' });
      input.value = '';
      return;
    }
    upload(check.file);
  }

  input.addEventListener('change', onChange);
  const onCta = () => {
    if (busy) return;
    input.click();
  };
  cta.addEventListener('click', onCta);

  return {
    destroy() {
      cta.removeEventListener('click', onCta);
      input.removeEventListener('change', onChange);
      if (input.parentNode) input.parentNode.removeChild(input);
    },
  };
}
