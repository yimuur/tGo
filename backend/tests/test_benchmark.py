"""T2.4 首次自动 tune 进度解析测试。

用例 ID: BMRK-*
依据 KataGo opencltuner.cpp 真实 stderr 输出（Performing autotuning / Tuning N/M ... /
Done tuning 等），以 stdout/stderr 为唯一事实源（不依据缓存文件存在性）。
"""

from app.engine.benchmark import BenchmarkParser


class TestParser:
    def test_detect_start_performing_autotuning(self):
        """真实启动行：'Performing autotuning' 触发会话开始。"""
        events = []
        parser = BenchmarkParser(on_benchmark_start=lambda: events.append("start"))
        parser.feed("Performing autotuning")
        assert parser.active is True
        assert events == ["start"]

    def test_detect_start_be_patient(self):
        """真实启动行：'*** ... please be patient ***' 触发会话开始。"""
        parser = BenchmarkParser()
        parser.feed("*** On some systems, this may take several minutes, please be patient ***")
        assert parser.active is True

    def test_detect_start_beginning_gpu_tuning(self):
        """真实启动行：'Beginning GPU tuning for ...' 触发会话开始。"""
        parser = BenchmarkParser()
        parser.feed("Beginning GPU tuning for NVIDIA GeForce GTX 1660 modelVersion 8 channels 192")
        assert parser.active is True

    def test_start_fires_once(self):
        """连续 tune 行只触发一次 start。"""
        events = []
        parser = BenchmarkParser(on_benchmark_start=lambda: events.append("start"))
        parser.feed("Performing autotuning")
        parser.feed("Beginning GPU tuning for NVIDIA GeForce GTX 1660 modelVersion 8 channels 192")
        parser.feed("Tuning 0/54 ...")
        assert events == ["start"]

    def test_progress_ratio(self):
        """真实进度行 'Tuning N/M ...' → 百分比。"""
        percents = []
        parser = BenchmarkParser(on_progress=lambda p, _: percents.append(p))
        parser.feed("Performing autotuning")
        parser.feed("Tuning 3/10 ...")
        assert percents == [30]

    def test_progress_ratio_larger(self):
        percents = []
        parser = BenchmarkParser(on_progress=lambda p, _: percents.append(p))
        parser.feed("Beginning GPU tuning for NVIDIA GeForce GTX 1660 modelVersion 8 channels 192")
        parser.feed("Tuning 12/54 ...")
        assert percents == [22]

    def test_progress_percent_bracket(self):
        percents = []
        parser = BenchmarkParser(on_progress=lambda p, _: percents.append(p))
        parser.feed("Performing autotuning")
        parser.feed("Tuning (45%)")
        assert percents == [45]

    def test_done_tuning_deactivates(self):
        """关键回归：真实结束行 'Done tuning'（done 在 tuning 之前）必须终止会话。"""
        events = []
        parser = BenchmarkParser(
            on_benchmark_start=lambda: events.append("start"),
            on_benchmark_end=lambda: events.append("end"),
        )
        parser.feed("Performing autotuning")
        assert parser.active is True
        parser.feed("Done tuning")
        assert parser.active is False
        assert events == ["start", "end"]

    def test_done_tuning_saved_results_deactivates(self):
        """真实结束行 'Done tuning, saved results to ...' 终止会话。"""
        parser = BenchmarkParser()
        parser.feed("Performing autotuning")
        parser.feed("Done tuning, saved results to C:\\KataGo\\KataGoData\\opencltuning\\tune13_gpuNVIDIA.txt")
        assert parser.active is False

    def test_all_configs_autotuned_deactivates(self):
        """autoTuneEverything 结束标志 'All neural net configs autotuned' 终止会话。"""
        parser = BenchmarkParser()
        parser.feed("Performing autotuning for ALL neural net configurations needed for the run!")
        parser.feed("All neural net configs autotuned")
        assert parser.active is False

    def test_unknown_lines_ignored(self):
        events = []
        parser = BenchmarkParser(on_benchmark_start=lambda: events.append("start"))
        parser.feed("Loaded model kata1-b28c512nbt.bin.gz")
        parser.feed("Engine started")
        parser.feed("Analysis Engine starting...")
        assert parser.active is False
        assert events == []

    def test_irrelevant_line_does_not_start(self):
        parser = BenchmarkParser()
        parser.feed("Warning: some config issue")
        assert parser.active is False

    def test_loaded_tuning_parameters_not_start(self):
        """回归（真实引擎复现发现）：缓存命中日志 'Loaded tuning parameters from: ...tune11...txt'
        含 'tuning' 字样，但并非自动调优——不得触发会话（误置 benchmarking 会绕过 120s 启动超时、
        把启动失败拖到最长 900s，表现即“一直停留在加载阶段”）。"""
        events = []
        parser = BenchmarkParser(on_benchmark_start=lambda: events.append("start"))
        parser.feed(
            "Loaded tuning parameters from: "
            "C:\\KataGo\\KataGoData\\opencltuning\\tune11_gpuNVIDIAGeForceGTX1660_x19_y19_c384_mv14.txt"
        )
        parser.feed("OpenCL backend thread 0: Model version 14")
        assert parser.active is False
        assert events == []

    def test_loaded_cached_config_windows_path_not_start(self):
        """Windows 盘符 + 反斜杠路径中的 opencltuning 目录名不得触发会话。"""
        parser = BenchmarkParser()
        parser.feed("Loaded tuning parameters from: E:\\tGO\\engine\\katago\\KataGoData\\opencltuning\\tune11.txt")
        assert parser.active is False

    def test_tuning_progress_line_starts(self):
        """真实进度行 'Tuning 3/10 ...' 可独立触发会话开始（错过开始行时的兜底）。"""
        events = []
        parser = BenchmarkParser(on_benchmark_start=lambda: events.append("start"))
        parser.feed("Tuning 3/10 ...")
        assert parser.active is True
        assert events == ["start"]

    def test_reset(self):
        parser = BenchmarkParser()
        parser.feed("Performing autotuning")
        assert parser.active is True
        parser.reset()
        assert parser.active is False
