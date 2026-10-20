"""首次自动 benchmark 进度解析（PRD §4.3.4，ARCHITECTURE §3.3）。

KataGo 在新设备/新模型首次启动引擎时自动进行 GPU 调优（`cpp/neuralnet/opencltuner.cpp`
`OpenCLTuner::loadOrAutoTune` → `tune`），调优输出走 **stderr**（`tune()` 以 `cerr`
输出进度、engine logger 默认写 stderr，见 `cpp/command/analysis.cpp`）。

本模块以 **stdout/stderr 标准输出为唯一事实源** 判定调优会话（不依据缓存文件是否存在）：

- **开始**：`Performing autotuning` / `*** On some systems, this may take several
  minutes, please be patient ***` / `Beginning GPU tuning for ...`；
- **进度**：`Tuning N/M ...`（`testAllConfigs` 逐配置行）→ 提取百分比；
- **结束**：`Done tuning`（`tune()` 结束标志）`/ Done tuning, saved results to ...`
  （写缓存完成）/ `All neural net configs autotuned`。

解析策略：对未知行保持健壮（忽略），不因解析失败影响引擎生命周期；
**禁止依据调优缓存文件（KataGoData/opencltuning/）是否存在来判定会话状态**。
"""

from __future__ import annotations

import re
from typing import Callable, Optional

#: 自动 tune 会话开始/进行中的 stderr 标志（依据 KataGo opencltuner.cpp 实际输出）
#: 注意：不得使用宽泛的单词 \btuning\b —— 缓存命中日志 "Loaded tuning parameters from: ..."
#: 含 "tuning" 字样但不是自动调优（误判会把 benchmarking 置位、绕过 120s 超时拖到 900s）。
_ACTIVE_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"performing autotun", re.IGNORECASE),
    re.compile(r"beginning gpu tuning", re.IGNORECASE),
    re.compile(r"no existing tuning parameters", re.IGNORECASE),
    re.compile(r"be patient", re.IGNORECASE),
    # 进度行 "Tuning 3/10 ..."（testAllConfigs 逐配置行）：即使错过开始行也能触发会话
    re.compile(r"tuning\s+\d+\s*/\s*\d+", re.IGNORECASE),
)

#: 自动 tune 会话结束标志（注意 "Done tuning" 中 done 位于 tuning 之前）
_DONE_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"done\s+tuning", re.IGNORECASE),
    re.compile(r"all neural net configs autotuned", re.IGNORECASE),
    re.compile(r"tuning.*(done|complete|finished|success)", re.IGNORECASE),
    re.compile(r"benchmark.*(done|complete|finished|success)", re.IGNORECASE),
)

#: 进度百分比行：KataGo 逐配置进度 "Tuning N/M ..."；兼容 "(xx%)" 形式
_PERCENT_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"(\d+)\s*/\s*(\d+)", re.IGNORECASE),
    re.compile(r"\((\d{1,3})%\)"),
)


ProgressCallback = Callable[[int, str], None]


class BenchmarkParser:
    """stderr 自动 tune 进度解析器（事件驱动，供引擎 stderr 回调接入）。

    - 以 stderr 行为唯一事实源判定会话开始/进行/结束；
    - 不依赖任何缓存文件存在性判断。
    """

    def __init__(
        self,
        *,
        on_benchmark_start: Optional[Callable[[], None]] = None,
        on_progress: Optional[ProgressCallback] = None,
        on_benchmark_end: Optional[Callable[[], None]] = None,
    ) -> None:
        self._on_benchmark_start = on_benchmark_start
        self._on_progress = on_progress
        self._on_benchmark_end = on_benchmark_end
        self._active = False
        self._last_percent: Optional[int] = None

    @property
    def active(self) -> bool:
        """当前是否处于 benchmark 会话中。"""
        return self._active

    def feed(self, line: str) -> None:
        """解析一行 stderr。"""
        if _is_benchmark_done(line):
            if self._active:
                self._active = False
                if self._on_benchmark_end:
                    self._on_benchmark_end()
            return
        if _is_benchmark_active(line):
            if not self._active:
                self._active = True
                if self._on_benchmark_start:
                    self._on_benchmark_start()
        # 会话中：任意进度行（"3 / 10" / "(45%)"）均提取百分比
        if self._active:
            percent = _extract_percent(line)
            if percent is not None:
                self._last_percent = percent
                if self._on_progress:
                    self._on_progress(percent, line.strip())

    def reset(self) -> None:
        self._active = False
        self._last_percent = None


def _is_benchmark_active(line: str) -> bool:
    return any(p.search(line) for p in _ACTIVE_PATTERNS)


def _is_benchmark_done(line: str) -> bool:
    return any(p.search(line) for p in _DONE_PATTERNS)


def _extract_percent(line: str) -> Optional[int]:
    """从进度行提取百分比（0-100）；无法提取返回 None。"""
    for pattern in _PERCENT_PATTERNS:
        m = pattern.search(line)
        if m:
            if len(m.groups()) == 2:
                done, total = int(m.group(1)), int(m.group(2))
                if total > 0:
                    return max(0, min(100, round(done * 100 / total)))
            return max(0, min(100, int(m.group(1))))
    return None
