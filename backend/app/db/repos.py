"""仓储层（纯 SQL 函数，DATABASE §3/§5）。

约定：
- 函数以 `conn`（aiosqlite.Connection）为首参，不持有连接生命周期；
- 读函数仅 SELECT（不开启事务）；
- 写函数自带事务：跨表/读-判-写原子操作使用 `_tx` 事务上下文
  （正常退出 COMMIT / 异常 ROLLBACK），保证 DATABASE §5 的原子性；
- **连接级写锁**（`_write_lock`）：同一连接上的并发写协程交错执行会互相
  污染隐式事务（`BEGIN IMMEDIATE` 嵌套报错 “cannot start a transaction within
  a transaction”/提交被覆盖，BUG-012：并发分析落库静默丢失），故所有写事务
  与单语句写统一经该锁串行化（**禁止嵌套获取**——写函数之间不得相互调用）；
- 各表分组：games / moves+position_analyses / players+scorings。
"""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any, AsyncGenerator, Callable, Optional

import aiosqlite

logger = logging.getLogger(__name__)


def _write_lock(conn: aiosqlite.Connection) -> asyncio.Lock:
    """连接级写锁（惰性创建，挂在连接对象上）。

    - aiosqlite 连接的命令在**单后台线程**串行执行，但 `await` 处协程可交错——
      两个写事务的 BEGIN/COMMIT 交错即产生交叉事务错误（BUG-012）；
    - 锁随连接存活（应用为单连接；测试各自 `:memory:` 连接互不影响）；
    - **禁止嵌套**：写函数之间不得相互调用（非重入锁，嵌套将死锁）。
    """
    lock = getattr(conn, "_tgo_write_lock", None)
    if lock is None:
        lock = asyncio.Lock()
        setattr(conn, "_tgo_write_lock", lock)
    return lock


@asynccontextmanager
async def _tx(conn: aiosqlite.Connection) -> AsyncGenerator[None, None]:
    """隐式写事务（连接级写锁内）：块内首个 DML 自动开启事务；正常退出提交，异常回滚。

    锁保证同一连接上不存在两个并发写事务（BUG-012）；**禁止嵌套**本上下文。
    """
    async with _write_lock(conn):
        try:
            yield
        except BaseException:
            await conn.rollback()
            raise
        else:
            await conn.commit()


@asynccontextmanager
async def _write_tx(conn: aiosqlite.Connection) -> AsyncGenerator[None, None]:
    """显式写锁事务（BEGIN IMMEDIATE）：用于读-判-写原子操作，防止并发交错。"""
    async with _write_lock(conn):
        await conn.execute("BEGIN IMMEDIATE")
        try:
            yield
        except BaseException:
            await conn.rollback()
            raise
        else:
            await conn.commit()


def _now_str() -> str:
    """当前 UTC 时间（与 SQLite datetime('now') 同口径，ISO 文本可字典序比较）。"""
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


async def _fetchone(
    conn: aiosqlite.Connection, sql: str, params: tuple[Any, ...] = ()
) -> Optional[aiosqlite.Row]:
    cur = await conn.execute(sql, params)
    return await cur.fetchone()


async def _fetchall(
    conn: aiosqlite.Connection, sql: str, params: tuple[Any, ...] = ()
) -> list[aiosqlite.Row]:
    cur = await conn.execute(sql, params)
    return list(await cur.fetchall())


async def _scalar(
    conn: aiosqlite.Connection, sql: str, params: tuple[Any, ...] = ()
) -> int:
    row = await _fetchone(conn, sql, params)
    return int(row[0]) if row is not None else 0


# ============================================================
# games — 对局元数据（DATABASE §3.2）
# ============================================================


async def create_game(
    conn: aiosqlite.Connection,
    *,
    mode: str,
    board_size: int = 19,
    rules: str = "chinese",
    komi: float = 7.5,
    handicap: int = 0,
    human_color: str = "B",
    black_player_id: Optional[int] = None,
    black_name: str = "真人",
    black_rank: Optional[str] = None,
    white_player_id: Optional[int] = None,
    white_name: str = "真人",
    white_rank: Optional[str] = None,
    ai_style: Optional[str] = None,
    ai_level: Optional[int] = None,
    adaptive_enabled: bool = False,
    adaptive_initial_level: Optional[str] = None,
    coaching_enabled: bool = False,
    parent_game_id: Optional[int] = None,
    chain_visits: int = 0,
) -> int:
    """创建对局（status 默认 `created`），返回 game_id。

    ``chain_visits``：创建时**冻结的链精度**（BUG-026；由服务层按当时配置与对局参数
    计算传入，整局不变；0 = 未冻结——仅限迁移前老对局/测试直建，读取时按当前配置派生）。
    """
    async with _tx(conn):
        cursor = await conn.execute(
            """
            INSERT INTO games (
                mode, board_size, rules, komi, handicap, human_color,
                black_player_id, black_name, black_rank,
                white_player_id, white_name, white_rank,
                ai_style, ai_level, adaptive_enabled, adaptive_initial_level,
                coaching_enabled, parent_game_id, chain_visits
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """,
            (
                mode, board_size, rules, komi, handicap, human_color,
                black_player_id, black_name, black_rank,
                white_player_id, white_name, white_rank,
                ai_style, ai_level, int(adaptive_enabled), adaptive_initial_level,
                int(coaching_enabled), parent_game_id, int(chain_visits),
            ),
        )
    lastrowid = cursor.lastrowid
    assert lastrowid is not None, "create_game: 未获得自增主键"
    return lastrowid


async def get_game(conn: aiosqlite.Connection, game_id: int) -> Optional[dict]:
    """按 id 取对局完整行。"""
    row = await _fetchone(conn, "SELECT * FROM games WHERE id=?", (game_id,))
    return dict(row) if row else None


async def get_game_detail(
    conn: aiosqlite.Connection, game_id: int
) -> Optional[dict]:
    """对局详情：完整行 + moves_count + analyses_count（API §3.1 对局详情用）。"""
    game = await get_game(conn, game_id)
    if game is None:
        return None
    moves_count = await _scalar(conn, "SELECT COUNT(*) FROM moves WHERE game_id=?", (game_id,))
    analyses_count = await _scalar(
        conn, "SELECT COUNT(*) FROM position_analyses WHERE game_id=?", (game_id,)
    )
    return {**game, "moves_count": moves_count, "analyses_count": analyses_count}


def _games_filter_clauses(
    *,
    status: Optional[str | list[str]] = None,
    favorite: Optional[bool] = None,
    mode: Optional[str] = None,
    name: Optional[str] = None,
) -> tuple[list[str], list[Any]]:
    """列表过滤条件（clauses + params）——``list_games`` 与 ``locate_game_page``
    共用同一口径（防两处漂移；过滤均为 AND 组合）。"""
    clauses: list[str] = []
    params: list[Any] = []
    if status is not None:
        statuses = [status] if isinstance(status, str) else list(status)
        if statuses:
            placeholders = ",".join("?" for _ in statuses)
            clauses.append(f"status IN ({placeholders})")
            params.extend(statuses)
    if favorite is not None:
        clauses.append("favorite = ?")
        params.append(int(favorite))
    if mode is not None:
        clauses.append("mode = ?")
        params.append(mode)
    if name is not None and str(name).strip():
        clauses.append("(black_name LIKE ? OR white_name LIKE ?)")
        like = f"%{name.strip()}%"
        params.extend([like, like])
    return clauses, params


def _where_of(clauses: list[str]) -> str:
    """clauses → ``WHERE`` 片段（空列表 → 空串）。"""
    return ("WHERE " + " AND ".join(clauses)) if clauses else ""


async def list_games(
    conn: aiosqlite.Connection,
    *,
    status: Optional[str | list[str]] = None,
    favorite: Optional[bool] = None,
    mode: Optional[str] = None,
    name: Optional[str] = None,
    page: int = 1,
    page_size: int = 20,
) -> tuple[int, list[dict]]:
    """对局列表（status/favorite/mode/name 过滤 + 分页），返回 (total, items)。

    - ``status``：单值或值数组（同值 OR，如 ``['created','active','scoring']`` 表"进行中"）；
    - ``name``：按黑/白玩家名模糊搜索（LIKE ``%name%``，API §3.1 前端列表搜索）；
    - 过滤条件均为 AND 组合；
    - **排序：最近更新优先（``updated_at`` 倒序，同时间戳以 id 倒序稳定）**——
      2026/09/13 人工反馈/BUG-060：旧口径 ``created_at`` 导致打完一局/落子后
      该对局不会回到列表顶部。
    """
    clauses, params = _games_filter_clauses(
        status=status, favorite=favorite, mode=mode, name=name
    )
    where = _where_of(clauses)

    total = await _scalar(conn, f"SELECT COUNT(*) FROM games {where}", tuple(params))

    page = max(page, 1)
    page_size = max(1, min(page_size, 200))
    rows = await _fetchall(
        conn,
        f"SELECT * FROM games {where} ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?",
        (*params, page_size, (page - 1) * page_size),
    )
    return total, [dict(r) for r in rows]


async def locate_game_page(
    conn: aiosqlite.Connection,
    game_id: int,
    *,
    status: Optional[str | list[str]] = None,
    favorite: Optional[bool] = None,
    mode: Optional[str] = None,
    name: Optional[str] = None,
    page_size: int = 20,
) -> Optional[int]:
    """对局在**当前过滤与排序**下的页码（1 基）；不存在 / 不匹配过滤 → ``None``。

    与 ``list_games`` 同一 ORDER BY（``updated_at DESC, id DESC``）与过滤口径：
    页码 = COUNT(排序键在目标之前) // page_size + 1——**不依赖 OFFSET 扫描**。
    前端「复盘页返回列表」定位来源对局用（API §3.1 ``focus_id``/``focus_page``）。
    """
    target = await _fetchone(
        conn, "SELECT id, updated_at FROM games WHERE id=?", (int(game_id),)
    )
    if target is None:
        return None
    clauses, params = _games_filter_clauses(
        status=status, favorite=favorite, mode=mode, name=name
    )
    size = max(1, min(int(page_size), 200))
    # 目标须落在过滤集合内（否则不存在于任何页）
    matched = await _scalar(
        conn,
        f"SELECT COUNT(*) FROM games {_where_of([*clauses, 'id = ?'])}",
        (*params, int(game_id)),
    )
    if not matched:
        return None
    # 排序在目标之前的条数：updated_at 更晚，或同时间戳 id 更大（同 ORDER BY 口径）
    before = await _scalar(
        conn,
        "SELECT COUNT(*) FROM games "
        f"{_where_of([*clauses, '(updated_at > ? OR (updated_at = ? AND id > ?))'])}",
        (*params, target["updated_at"], target["updated_at"], int(game_id)),
    )
    return int(before) // size + 1


async def get_active_latest(conn: aiosqlite.Connection) -> Optional[dict]:
    """服务器“最近的进行中对局”：仅 `active`（PLAYING），按 updated_at 倒序取最新。

    约定（API §3.1）：`created`/`scoring` 不自动恢复。
    """
    row = await _fetchone(
        conn,
        "SELECT * FROM games WHERE status='active' "
        "ORDER BY updated_at DESC, id DESC LIMIT 1",
    )
    return dict(row) if row else None


async def update_game_status(
    conn: aiosqlite.Connection, game_id: int, status: str
) -> None:
    """更新对局状态（与 GameFlow FSM 一一对应）。"""
    async with _tx(conn):
        await conn.execute(
            "UPDATE games SET status=?, updated_at=datetime('now') WHERE id=?",
            (status, game_id),
        )


async def set_game_last_move_no(
    conn: aiosqlite.Connection, game_id: int, move_no: int
) -> None:
    """更新对局当前手数（同步 updated_at）。"""
    async with _tx(conn):
        await conn.execute(
            "UPDATE games SET last_move_no=?, updated_at=datetime('now') WHERE id=?",
            (move_no, game_id),
        )


async def set_game_result(conn: aiosqlite.Connection, game_id: int, result: str) -> None:
    """终局落定：status='finished' + result + finished_at。"""
    async with _tx(conn):
        await conn.execute(
            "UPDATE games SET status='finished', result=?, finished_at=datetime('now'),"
            " updated_at=datetime('now') WHERE id=?",
            (result, game_id),
        )


async def set_game_favorite(
    conn: aiosqlite.Connection, game_id: int, favorite: bool
) -> None:
    """收藏/取消收藏。"""
    async with _tx(conn):
        await conn.execute(
            "UPDATE games SET favorite=? WHERE id=?", (int(favorite), game_id)
        )


async def update_game_ai_level(
    conn: aiosqlite.Connection, game_id: int, ai_level: int
) -> None:
    """更新对局当前 AI 匹配档位（自适应难度写回，断点恢复不丢失，PRD §4.1.3）。"""
    async with _tx(conn):
        await conn.execute(
            "UPDATE games SET ai_level=?, updated_at=datetime('now') WHERE id=?",
            (ai_level, game_id),
        )


async def add_captures(
    conn: aiosqlite.Connection, game_id: int, color: str, count: int
) -> None:
    """累计提子数（ISSUE-047 方案 1）：落子吃子后对执色方 +count（0 则跳过）。"""
    if count <= 0:
        return
    column = "black_captures" if color == "B" else "white_captures"
    async with _tx(conn):
        await conn.execute(
            f"UPDATE games SET {column}={column}+?, updated_at=datetime('now') WHERE id=?",
            (count, game_id),
        )


async def set_captures(
    conn: aiosqlite.Connection,
    game_id: int,
    *,
    black_captures: int,
    white_captures: int,
) -> None:
    """回写提子计数器（BUG-031：悔棋/重开/复弈/SGF 导入后按棋谱回算，非增量）。"""
    async with _tx(conn):
        await conn.execute(
            "UPDATE games SET black_captures=?, white_captures=?,"
            " updated_at=datetime('now') WHERE id=?",
            (int(black_captures), int(white_captures), game_id),
        )


async def delete_game(conn: aiosqlite.Connection, game_id: int) -> bool:
    """删除对局（moves/position_analyses/scorings 由外键 ON DELETE CASCADE 级联清理）。"""
    async with _tx(conn):
        cursor = await conn.execute("DELETE FROM games WHERE id=?", (game_id,))
        rowcount = cursor.rowcount
    return rowcount > 0


# ============================================================
# moves — 落子序列（DATABASE §3.3）
# ============================================================


async def append_move(
    conn: aiosqlite.Connection,
    *,
    game_id: int,
    move_no: int,
    color: str,
    x: Optional[int] = None,
    y: Optional[int] = None,
    is_pass: bool = False,
) -> None:
    """单事务写入落子 + 更新 games.last_move_no（DATABASE §5）。

    新落子**不重置** `undo_count`（ISSUE-039：全局悔棋计数只增不减）。
    """
    async with _tx(conn):
        await conn.execute(
            "INSERT INTO moves(game_id, move_no, color, x, y, is_pass) VALUES (?,?,?,?,?,?)",
            (game_id, move_no, color, x, y, int(is_pass)),
        )
        await conn.execute(
            "UPDATE games SET last_move_no=?, updated_at=datetime('now')"
            " WHERE id=?",
            (move_no, game_id),
        )


async def list_moves(conn: aiosqlite.Connection, game_id: int) -> list[dict]:
    """对局全部落子（按 move_no 升序）。"""
    rows = await _fetchall(
        conn, "SELECT * FROM moves WHERE game_id=? ORDER BY move_no", (game_id,)
    )
    return [dict(r) for r in rows]


async def append_moves_batch(
    conn: aiosqlite.Connection,
    *,
    game_id: int,
    moves: list[dict],
) -> None:
    """批量写入落子（单事务，SGF 导入用，M-6）：全部落子 + 回写 last_move_no。

    ``moves`` 元素须含 ``color``/``x``/``y``/``is_pass``；move_no 从 1 顺序编号。
    """
    async with _tx(conn):
        for i, m in enumerate(moves, start=1):
            await conn.execute(
                "INSERT INTO moves(game_id, move_no, color, x, y, is_pass)"
                " VALUES (?,?,?,?,?,?)",
                (game_id, i, m["color"], m.get("x"), m.get("y"), int(bool(m.get("is_pass")))),
            )
        await conn.execute(
            "UPDATE games SET last_move_no=?, updated_at=datetime('now') WHERE id=?",
            (len(moves), game_id),
        )


async def get_move(
    conn: aiosqlite.Connection, game_id: int, move_no: int
) -> Optional[dict]:
    row = await _fetchone(
        conn,
        "SELECT * FROM moves WHERE game_id=? AND move_no=?",
        (game_id, move_no),
    )
    return dict(row) if row else None


async def truncate_moves_after(
    conn: aiosqlite.Connection, *, game_id: int, move_no: int
) -> None:
    """悔棋/重开单事务级联清理（DATABASE §5）：删除 `move_no > N` 的 moves 与
    同范围 position_analyses，并回写 games.last_move_no。

    position_analyses 仅主谱键 `main:{move_no}` 落库，按数字后缀清理。
    """
    async with _tx(conn):
        await conn.execute(
            "DELETE FROM moves WHERE game_id=? AND move_no > ?", (game_id, move_no)
        )
        await conn.execute(
            "DELETE FROM position_analyses WHERE game_id=? AND position_key LIKE 'main:%'"
            " AND CAST(substr(position_key, 6) AS INTEGER) > ?",
            (game_id, move_no),
        )
        await conn.execute(
            "UPDATE games SET last_move_no=?, pass_reset_move_no=MIN(pass_reset_move_no, ?),"
            " updated_at=datetime('now') WHERE id=?",
            (move_no, move_no, game_id),
        )


async def undo_moves_after(
    conn: aiosqlite.Connection, *, game_id: int, move_no: int, steps: int = 1
) -> None:
    """悔棋单事务（ISSUE-039）：清理 `move_no > N` 的 moves/analyses、回写 last_move_no，
    并将 `undo_count + steps`（全局悔棋计数只增不减，每撤一步 +1，达上限后拒绝）。

    BUG-025：双 PASS 计数边界同时收敛（`MIN(边界, N)`）——悔棋后手数回退、新落子
    会复用旧手数，边界须不高于回退点，否则“边界后的两个新 PASS”永不可达。
    """
    async with _tx(conn):
        await conn.execute(
            "DELETE FROM moves WHERE game_id=? AND move_no > ?", (game_id, move_no)
        )
        await conn.execute(
            "DELETE FROM position_analyses WHERE game_id=? AND position_key LIKE 'main:%'"
            " AND CAST(substr(position_key, 6) AS INTEGER) > ?",
            (game_id, move_no),
        )
        await conn.execute(
            "UPDATE games SET last_move_no=?, undo_count=undo_count+?,"
            " pass_reset_move_no=MIN(pass_reset_move_no, ?),"
            " updated_at=datetime('now') WHERE id=?",
            (move_no, steps, move_no, game_id),
        )


async def reset_game_undo_count(conn: aiosqlite.Connection, game_id: int) -> None:
    """重开（同参数重置）：视为新对局，全局悔棋计数归零（ISSUE-039）。"""
    async with _tx(conn):
        await conn.execute(
            "UPDATE games SET undo_count=0 WHERE id=?", (game_id,)
        )


async def set_game_pass_reset_move_no(
    conn: aiosqlite.Connection, game_id: int, move_no: int
) -> None:
    """双 PASS 计数边界（BUG-025）：≤该手数的 PASS 不参与“连续双 PASS”判定。

    - 结算取消（``scoring.cancel``）时写当前 ``last_move_no``（落实「需再次双 PASS
      才可进入结算」，防取消前旧 PASS 与取消后新 PASS 配对误入结算）；
    - 重开（``restart``）重置为 0（落子已清空）。
    """
    async with _tx(conn):
        await conn.execute(
            "UPDATE games SET pass_reset_move_no=? WHERE id=?", (move_no, game_id)
        )


# ============================================================
# position_analyses — 每局面分析结果（DATABASE §3.4，合并规则 §5；仅链精度落库，BUG-026）
# ============================================================


async def _upsert_one(
    conn: aiosqlite.Connection,
    *,
    game_id: int,
    position_key: str,
    data_json: str,
    max_visits: int,
    ts: str,
) -> str:
    """单键合并写入（调用方须持有事务）：`max_visits` 大者恒优先，同值新者替换。

    返回动作: ``inserted`` / ``replaced`` / ``discarded``。
    """
    row = await _fetchone(
        conn,
        "SELECT max_visits, updated_at FROM position_analyses"
        " WHERE game_id=? AND position_key=?",
        (game_id, position_key),
    )
    if row is None:
        await conn.execute(
            "INSERT INTO position_analyses(game_id, position_key, data_json,"
            " max_visits, updated_at) VALUES (?,?,?,?,?)",
            (game_id, position_key, data_json, max_visits, ts),
        )
        return "inserted"
    old_max = int(row["max_visits"])
    old_ts = str(row["updated_at"])
    if max_visits > old_max or (max_visits == old_max and ts >= old_ts):
        await conn.execute(
            "UPDATE position_analyses SET data_json=?, max_visits=?, updated_at=?"
            " WHERE game_id=? AND position_key=?",
            (data_json, max_visits, ts, game_id, position_key),
        )
        return "replaced"
    return "discarded"


async def upsert_position_analysis(
    conn: aiosqlite.Connection,
    *,
    game_id: int,
    position_key: str,
    data_json: str,
    max_visits: int,
    updated_at: Optional[str] = None,
    stale_check: Optional[Callable[[], bool]] = None,
) -> str:
    """按合并规则写入单局面分析（DATABASE §5 分析结果写入）：

    - 以 `(game_id, position_key)` 为键，**精度 = `max_visits`，大者恒优先**；
    - 同 `max_visits` 时 `updated_at` 新者替换，否则丢弃；
    - 使用写锁事务（读-判-写原子），防止并发交错；
    - ``stale_check``（M-5）：**事务内**（入写锁后、写入前）求值的过期回调——
      悔棋/重开恰落在「结果到达检查」与「落库」之间时，命中即返回 ``stale`` 不写入。

    返回动作: ``inserted`` / ``replaced`` / ``discarded`` / ``stale``。
    """
    ts = updated_at or _now_str()
    async with _write_tx(conn):
        if stale_check is not None and stale_check():
            return "stale"
        return await _upsert_one(
            conn,
            game_id=game_id,
            position_key=position_key,
            data_json=data_json,
            max_visits=max_visits,
            ts=ts,
        )


async def delete_position_analysis_if_match(
    conn: aiosqlite.Connection,
    *,
    game_id: int,
    position_key: str,
    updated_at: str,
    max_visits: int,
) -> bool:
    """条件删除（M-5 补偿删除）：仅当行仍与本次写入指纹（ts + max_visits）一致时删除。

    写后复核发现任务已过期时调用；期间已有更新写入（不同指纹）则保留新行。
    """
    async with _write_tx(conn):
        cursor = await conn.execute(
            "DELETE FROM position_analyses WHERE game_id=? AND position_key=?"
            " AND updated_at=? AND max_visits=?",
            (game_id, position_key, updated_at, max_visits),
        )
        rowcount = cursor.rowcount
    return rowcount > 0


async def bulk_upsert_position_analyses(
    conn: aiosqlite.Connection,
    *,
    game_id: int,
    items: list[tuple[str, str, int]],
    updated_at: Optional[str] = None,
) -> dict[str, int]:
    """**单事务批量**合并写入（复弈落盘等原子批量场景，DATABASE §5）。

    - `items`: `(position_key, data_json, max_visits)` 元组列表；
    - 整个批次置于一个 `BEGIN IMMEDIATE` 写锁事务内，逐键按合并规则写入
      （`max_visits` 大者优先、同值新者替换），**全部成功统一提交，任一失败整体回滚**；
    - 返回动作统计 `{"inserted": n, "replaced": n, "discarded": n}`。
    """
    ts = updated_at or _now_str()
    stats = {"inserted": 0, "replaced": 0, "discarded": 0}
    async with _write_tx(conn):
        for position_key, data_json, max_visits in items:
            action = await _upsert_one(
                conn,
                game_id=game_id,
                position_key=position_key,
                data_json=data_json,
                max_visits=max_visits,
                ts=ts,
            )
            stats[action] += 1
    return stats


async def get_position_analysis(
    conn: aiosqlite.Connection, game_id: int, position_key: str
) -> Optional[dict]:
    row = await _fetchone(
        conn,
        "SELECT * FROM position_analyses WHERE game_id=? AND position_key=?",
        (game_id, position_key),
    )
    return dict(row) if row else None


async def get_main_analysis(
    conn: aiosqlite.Connection, game_id: int, move_no: int
) -> Optional[dict]:
    """主谱第 move_no 手局面的分析（position_key = `main:{move_no}`）。"""
    return await get_position_analysis(conn, game_id, f"main:{move_no}")


async def list_analyses_for_game(
    conn: aiosqlite.Connection, game_id: int
) -> list[dict]:
    """对局全部分析（按 position_key 排序，供报告等按需计算）。"""
    rows = await _fetchall(
        conn,
        "SELECT * FROM position_analyses WHERE game_id=? ORDER BY position_key",
        (game_id,),
    )
    return [dict(r) for r in rows]


async def count_analyses_for_game(
    conn: aiosqlite.Connection, game_id: int
) -> int:
    """对局分析总数。"""
    return await _scalar(
        conn, "SELECT COUNT(*) FROM position_analyses WHERE game_id=?", (game_id,)
    )


async def analysis_coverage(
    conn: aiosqlite.Connection, game_id: int, up_to_move_no: int
) -> int:
    """主谱 0..up_to_move_no 已有分析的局面数（全局分析覆盖率/报告完整性推导）。"""
    return await _scalar(
        conn,
        "SELECT COUNT(*) FROM position_analyses WHERE game_id=? AND position_key LIKE 'main:%'"
        " AND CAST(substr(position_key, 6) AS INTEGER) BETWEEN 0 AND ?",
        (game_id, up_to_move_no),
    )


# ============================================================
# players — 姓名/段位档案（DATABASE §3.1）
# ============================================================


async def upsert_player(
    conn: aiosqlite.Connection, *, name: str, rank: str
) -> int:
    """档案 upsert：`UNIQUE(name, rank)`，已存在则刷新 updated_at（最近使用优先），返回 id。"""
    async with _tx(conn):
        await conn.execute(
            "INSERT INTO players(name, rank) VALUES (?,?)"
            " ON CONFLICT(name, rank) DO UPDATE SET updated_at=datetime('now')",
            (name, rank),
        )
        row = await _fetchone(
            conn, "SELECT id FROM players WHERE name=? AND rank=?", (name, rank)
        )
    assert row is not None
    return int(row["id"])


async def list_players(
    conn: aiosqlite.Connection, name: Optional[str] = None, limit: int = 50
) -> list[dict]:
    """档案列表：`name` 可选模糊匹配（LIKE `%name%`），按 updated_at 倒序（最近使用优先）。"""
    sql = "SELECT * FROM players"
    params: list[Any] = []
    if name:
        sql += " WHERE name LIKE ?"
        params.append(f"%{name}%")
    sql += " ORDER BY updated_at DESC, id DESC LIMIT ?"
    params.append(max(1, min(limit, 200)))
    rows = await _fetchall(conn, sql, tuple(params))
    return [dict(r) for r in rows]


# ============================================================
# scorings — 终局结算（DATABASE §3.5）
# ============================================================


async def upsert_scoring(
    conn: aiosqlite.Connection,
    *,
    game_id: int,
    dead_points_json: str = "[]",
    black_score: Optional[float] = None,
    white_score: Optional[float] = None,
    result: Optional[str] = None,
) -> None:
    """结算 UPSERT：以 `game_id` 为键**整体替换**（支持结算取消后再结算，DATABASE §5）。"""
    async with _tx(conn):
        await conn.execute(
            """
            INSERT INTO scorings (game_id, dead_points_json, black_score, white_score, result)
            VALUES (?,?,?,?,?)
            ON CONFLICT(game_id) DO UPDATE SET
                dead_points_json=excluded.dead_points_json,
                black_score=excluded.black_score,
                white_score=excluded.white_score,
                result=excluded.result
            """,
            (game_id, dead_points_json, black_score, white_score, result),
        )


async def get_scoring(
    conn: aiosqlite.Connection, game_id: int
) -> Optional[dict]:
    row = await _fetchone(conn, "SELECT * FROM scorings WHERE game_id=?", (game_id,))
    return dict(row) if row else None
