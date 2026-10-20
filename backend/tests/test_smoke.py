"""T0.1 冒烟测试：验证测试骨架可运行、app 包可导入。"""


def test_smoke_import_app_package():
    """后端 app 包可正常导入（包结构成立）。"""
    import app  # noqa: F401

    assert app.__doc__


def test_smoke_dependencies_importable():
    """核心运行依赖均可导入。"""
    import aiosqlite  # noqa: F401
    import fastapi  # noqa: F401
    import psutil  # noqa: F401
    import pydantic  # noqa: F401

    assert True
