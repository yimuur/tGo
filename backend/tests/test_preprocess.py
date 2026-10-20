"""T2.6 响应预处理测试：字段瘦身、截断、舍入、健壮性（DATABASE §3.4.1）。

使用录制样本 tests/samples/analysis_response.sample.json。
用例 ID: PP-*
"""

import json
from pathlib import Path

from app.engine.preprocess import preprocess_analysis_response

SAMPLE = json.loads(
    (Path(__file__).parent / "samples" / "analysis_response.sample.json").read_text(encoding="utf-8")
)


class TestFieldSlimming:
    def test_dropped_fields_removed(self):
        result = preprocess_analysis_response(SAMPLE, max_moves=5, analysis_pv_len=10)
        # 剔除：isDuringSearch / scoreMean / utilityLcb / symHash / thisHash
        assert "isDuringSearch" not in result
        assert "scoreMean" not in result["moveInfos"][0]
        assert "utilityLcb" not in result["moveInfos"][0]
        assert "symHash" not in result["rootInfo"]
        assert "thisHash" not in result["rootInfo"]

    def test_kept_fields_present(self):
        result = preprocess_analysis_response(SAMPLE, max_moves=5, analysis_pv_len=10)
        assert result["id"] == "sample-1"
        assert result["turnNumber"] == 2
        assert result["rootInfo"]["currentPlayer"] == "B"
        assert result["rootInfo"]["winrate"] is not None
        first = result["moveInfos"][0]
        assert first["move"] == "Q5"
        assert first["order"] == 0
        assert "visits" in first
        assert "pv" in first

    def test_ownership_present(self):
        result = preprocess_analysis_response(SAMPLE, max_moves=5, analysis_pv_len=10)
        assert result["ownership"] == [0.723, -0.123, 0.0, 1.0]


class TestTruncation:
    def test_candidates_truncated_to_max_moves(self):
        result = preprocess_analysis_response(SAMPLE, max_moves=2, analysis_pv_len=10)
        assert len(result["moveInfos"]) == 2

    def test_pv_truncated(self):
        result = preprocess_analysis_response(SAMPLE, max_moves=5, analysis_pv_len=5)
        assert len(result["moveInfos"][0]["pv"]) == 5


class TestRounding:
    def test_float_rounding_3(self):
        result = preprocess_analysis_response(SAMPLE, max_moves=5, analysis_pv_len=10)
        first = result["moveInfos"][0]
        assert first["scoreLead"] == 8.185
        assert first["winrate"] == 0.867
        assert result["rootInfo"]["scoreLead"] == 8.22
        # 整数不误舍入
        assert first["visits"] == 495
        assert first["order"] == 0


class TestRobustness:
    def test_unknown_fields_ignored(self):
        """KataGo 版本新增字段不崩溃（健壮忽略）。"""
        raw = {
            "id": "x",
            "turnNumber": 1,
            "rootInfo": {"winrate": 0.5, "newField": 123},
            "moveInfos": [{"move": "C4", "visits": 1, "brandNew": {"a": 1}}],
            "futureField": {"x": 1},
        }
        result = preprocess_analysis_response(raw, max_moves=5, analysis_pv_len=10)
        assert "futureField" not in result
        assert "brandNew" not in result["moveInfos"][0]
        assert "newField" not in result["rootInfo"]

    def test_missing_sections_ok(self):
        result = preprocess_analysis_response({"id": "y"}, max_moves=5, analysis_pv_len=10)
        assert result == {"id": "y"}
        assert "moveInfos" not in result
        assert "rootInfo" not in result

    def test_empty_move_infos(self):
        raw = {"id": "z", "moveInfos": [], "rootInfo": {"winrate": 0.5}}
        result = preprocess_analysis_response(raw, max_moves=5, analysis_pv_len=10)
        assert result["moveInfos"] == []
