"""引擎模型解析（首启引导，PRD §4.1.1 人类模型缺失降级）。

- **标准模型**：`standard_model`（空=自动扫描 `*.bin.gz` 且排除人类模型文件），**必存在**；
- **人类模型**：`human_model`（空=自动扫描 `*human*.bin.gz`），**可选**；
- 人类模型缺失（`human_model_available=False`）时：创建对局禁用“人类风格 / 自适应难度”
  选项（仅标准风格可用），引擎仍正常挂载标准模型（`-human-model` 不传）。
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from app.config import ConfigError

#: 人类模型文件特征（KataGo 官方如 b18c384nbt-humanv0.bin.gz，文件名含 "human"）
_HUMAN_MODEL_PATTERN = re.compile(r"human", re.IGNORECASE)
MODEL_GLOB = "*.bin.gz"


@dataclass(frozen=True)
class EngineModels:
    """模型解析结果：标准模型必存在；人类模型可选。"""

    standard_model_path: str
    human_model_path: Optional[str] = None

    @property
    def human_model_available(self) -> bool:
        """人类模型是否可用（False=创建对局仅标准风格可用）。"""
        return self.human_model_path is not None


def _resolve_one(model_dir: Path, explicit_name: str, *, human: bool) -> Optional[str]:
    """解析单个模型路径；explicit 非空直接拼接（须存在），否则按特征扫描。"""
    if explicit_name:
        path = model_dir / explicit_name
        return str(path) if path.is_file() else None
    matches = sorted(model_dir.glob(MODEL_GLOB))
    for match in matches:
        if (_HUMAN_MODEL_PATTERN.search(match.name) is not None) == human:
            return str(match)
    return None


def resolve_models(
    *,
    model_dir: str | Path,
    standard_model: str = "",
    human_model: str = "",
) -> EngineModels:
    """解析标准/人类模型路径（空=自动扫描）。

    - 标准模型缺失 → 抛 `ConfigError`（**引擎**不可用降级：不阻碍进入，人人对弈与复盘照常
      可用，BUG-090；PRD §4.1.1）；
    - 人类模型缺失 → `human_model_path=None`（仅标准风格可用，引擎仍挂标准模型）。
    """
    base = Path(model_dir)
    standard_path = _resolve_one(base, standard_model, human=False)
    if standard_path is None:
        raise ConfigError(
            f"标准模型缺失：{base} 下未找到标准模型（引擎不可用；不影响人人对弈与复盘）",
            code="standard_model_missing",
        )
    human_path = _resolve_one(base, human_model, human=True)
    return EngineModels(standard_model_path=standard_path, human_model_path=human_path)
