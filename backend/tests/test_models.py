"""T2.x 引擎模型解析测试（首启引导，PRD §4.1.1 人类模型缺失降级）。

用例 ID: MOD-*
"""

import pytest

from app.config import ConfigError
from app.engine.models import resolve_models


def _make_dir(tmp_path, files):
    for name in files:
        (tmp_path / name).write_bytes(b"fake")
    return tmp_path


class TestResolveStandard:
    def test_auto_scan_finds_standard(self, tmp_path):
        d = _make_dir(tmp_path, ["kata1-b28c512nbt.bin.gz", "b18c384nbt-humanv0.bin.gz"])
        m = resolve_models(model_dir=d)
        assert m.standard_model_path == str(d / "kata1-b28c512nbt.bin.gz")
        assert m.human_model_path == str(d / "b18c384nbt-humanv0.bin.gz")
        assert m.human_model_available is True

    def test_standard_scan_excludes_human(self, tmp_path):
        """仅存在人类模型文件时，标准模型视为缺失（引擎不可用降级，不阻碍进入）。"""
        d = _make_dir(tmp_path, ["b18c384nbt-humanv0.bin.gz"])
        with pytest.raises(ConfigError):
            resolve_models(model_dir=d)

    def test_missing_standard_message_is_degradation_not_blocking(self, tmp_path):
        """BUG-090 口径：缺失标准模型文案须为「引擎不可用…不影响人人对弈与复盘」，不得称阻断。"""
        d = _make_dir(tmp_path, ["b18c384nbt-humanv0.bin.gz"])
        with pytest.raises(ConfigError) as exc:
            resolve_models(model_dir=d)
        message = str(exc.value)
        assert "标准模型缺失" in message
        assert "人人对弈与复盘" in message
        assert "阻断" not in message

    def test_explicit_standard_name(self, tmp_path):
        d = _make_dir(tmp_path, ["kata1.bin.gz", "other.bin.gz"])
        m = resolve_models(model_dir=d, standard_model="other.bin.gz")
        assert m.standard_model_path == str(d / "other.bin.gz")

    def test_explicit_standard_missing_raises(self, tmp_path):
        d = _make_dir(tmp_path, ["kata1.bin.gz"])
        with pytest.raises(ConfigError):
            resolve_models(model_dir=d, standard_model="nope.bin.gz")

    def test_missing_standard_raises(self, tmp_path):
        with pytest.raises(ConfigError):
            resolve_models(model_dir=_make_dir(tmp_path, []))


class TestResolveHuman:
    def test_auto_scan_finds_human(self, tmp_path):
        d = _make_dir(tmp_path, ["kata1.bin.gz", "b18c384nbt-humanv0.bin.gz"])
        m = resolve_models(model_dir=d)
        assert m.human_model_path == str(d / "b18c384nbt-humanv0.bin.gz")
        assert m.human_model_available is True

    def test_no_human_model_degrades(self, tmp_path):
        """人类模型缺失：human_model_available=False，标准模型仍正常解析（降级）。"""
        d = _make_dir(tmp_path, ["kata1.bin.gz"])
        m = resolve_models(model_dir=d)
        assert m.human_model_path is None
        assert m.human_model_available is False
        assert m.standard_model_path == str(d / "kata1.bin.gz")

    def test_explicit_human_missing_degrades(self, tmp_path):
        d = _make_dir(tmp_path, ["kata1.bin.gz"])
        m = resolve_models(model_dir=d, human_model="human.bin.gz")
        assert m.human_model_available is False

    def test_explicit_human_name(self, tmp_path):
        d = _make_dir(tmp_path, ["kata1.bin.gz", "human.bin.gz"])
        m = resolve_models(model_dir=d, human_model="human.bin.gz")
        assert m.human_model_path == str(d / "human.bin.gz")
        assert m.human_model_available is True
