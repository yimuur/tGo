"""REST 对局/复盘路由（TASK T4.2，API §3.1 强绑定）。

- 创建/列表/active-latest/详情/删除/收藏/曲线/领地/SGF/导入/报告；
- 所有入参 Pydantic 强校验（``api/schemas.py``）；错误统一 ``{code,message}``；
- 路由声明顺序：``/active-latest``、``/import`` 先于 ``/{game_id}``（避免路径冲突）。
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, File, Query, Request, Response, UploadFile

from app.api.deps import get_services
from app.api.public import (
    GameDetailResponse,
    GameInfo,
    GameListResponse,
    to_public_game,
)
from app.api.schemas import (
    CreateGameRequest,
    CreateGameResponse,
    FavoriteRequest,
    GameStatus,
    Mode,
    Perspective,
    RefightRequest,
)
from app.core.errors import AppError, ErrorCode
from app.db import repos
from app.services.game_service import AiParams, CreateGameParams, PlayerInfo
from app.services.sgf_io import (
    SGF_SIZE_LIMIT,
    export_game_sgf,
    game_params_from_parsed,
    parse_sgf,
)

router = APIRouter(prefix="/api/games", tags=["games"])


def _to_create_params(payload: CreateGameRequest) -> CreateGameParams:
    """Schemas → 服务层参数（保持边界强类型）。"""
    ai = payload.ai
    return CreateGameParams(
        mode=payload.mode,
        board_size=payload.board_size,
        rules=payload.rules,
        komi=payload.komi,
        handicap=payload.handicap,
        color=payload.color,
        black=PlayerInfo(name=payload.black.name, rank=payload.black.rank),
        white=PlayerInfo(name=payload.white.name, rank=payload.white.rank),
        ai=(
            AiParams(style=ai.style, level=ai.level, adaptive=ai.adaptive)
            if ai is not None
            else None
        ),
        coaching=payload.coaching,
    )


# ============================================================
# 列表 / 创建 / active-latest / 导入（先于 /{game_id} 声明）
# ============================================================


@router.post("", response_model=CreateGameResponse, status_code=201)
async def create_game(payload: CreateGameRequest, request: Request) -> dict:
    """创建对局（API §3.1.1）。"""
    svc = get_services(request)
    game_id = await svc.game.create(_to_create_params(payload))
    return {"game_id": game_id}


@router.get("", response_model=GameListResponse)
async def list_games(
    request: Request,
    status: Optional[list[GameStatus]] = Query(
        default=None, description="与 GameFlow FSM 一一对应；可重复传参（同值 OR，如 ?status=active&status=scoring）"
    ),
    favorite: Optional[bool] = Query(default=None, description="收藏筛选"),
    mode: Optional[Mode] = Query(default=None, description="模式筛选"),
    name: Optional[str] = Query(default=None, max_length=64, description="按黑/白玩家名模糊搜索（LIKE %name%）"),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=200),
    focus_id: Optional[int] = Query(
        default=None,
        ge=1,
        description="定位查询：返回该对局在当前过滤/排序下所在页码（focus_page）",
    ),
) -> dict:
    """对局列表（API §3.1，过滤 + 分页；输出 GameInfo 白名单 Schema，T6.1/T6.7）。

    - ``status`` 可重复传参实现多状态 OR（如 ?status=active&status=scoring 表"进行中"）；
    - ``name`` 服务端模糊搜索（LIKE，匹配黑/白玩家名）；
    - ``focus_id``（2026/09/14）：定位来源对局——items 仍为 ``page`` 页，
      ``focus_page`` 额外返回该对局所在页码（同过滤/同排序口径；不存在/不匹配 → null）；
      前端「复盘页返回列表」据此翻页并选中（无需扫描分页）。
    """
    svc = get_services(request)
    total, items = await repos.list_games(
        svc.db.conn,
        status=status,
        favorite=favorite,
        mode=mode,
        name=name,
        page=page,
        page_size=page_size,
    )
    focus_page = None
    if focus_id is not None:
        focus_page = await repos.locate_game_page(
            svc.db.conn,
            focus_id,
            status=status,
            favorite=favorite,
            mode=mode,
            name=name,
            page_size=page_size,
        )
    return {
        "total": total,
        "items": [to_public_game(r) for r in items],
        "focus_page": focus_page,
    }


@router.get("/active-latest", response_model=Optional[GameInfo])
async def active_latest(request: Request) -> Optional[dict]:
    """服务器“最近的进行中对局”（仅 status='active'，created/scoring 不恢复）。"""
    svc = get_services(request)
    row = await repos.get_active_latest(svc.db.conn)
    return to_public_game(row) if row else None


@router.post("/import", status_code=201)
async def import_sgf(request: Request, file: UploadFile = File(...)) -> dict:
    """SGF 导入（multipart；编码兼容 + 合法性校验，API §3.1）。

    - 导入生成正式对局记录（``status='finished'``，可复盘/全局补分析）；
    - 解析失败/超限 → ``SGF_INVALID`` / ``SGF_TOO_LARGE``。
    """
    svc = get_services(request)
    # L-7：先按上限+1 分段读取——旧实现全量 read() 后才在 parse_sgf 判 1MB，
    # 超限上传仍被完整读入内存（大文件可先读探测字节，命中即 413 返回）
    content = await file.read(SGF_SIZE_LIMIT + 1)
    if len(content) > SGF_SIZE_LIMIT:
        raise AppError(ErrorCode.SGF_TOO_LARGE, "SGF 文件过大")
    try:
        text = content.decode("utf-8", errors="strict")
    except UnicodeDecodeError:
        raise AppError(ErrorCode.SGF_INVALID, "SGF 编码不支持（需 UTF-8）") from None
    parsed = parse_sgf(text)
    params = game_params_from_parsed(parsed)
    game_id = await svc.game.create(
        CreateGameParams(
            mode=params["mode"],
            board_size=params["board_size"],
            rules=params["rules"],
            komi=params["komi"],
            handicap=params["handicap"],
            black=PlayerInfo(**params["black"]),
            white=PlayerInfo(**params["white"]),
        )
    )
    # M-6：落子批量单事务写入（避免逐手独立 commit）
    if parsed["moves"]:
        await repos.append_moves_batch(svc.db.conn, game_id=game_id, moves=parsed["moves"])
    # BUG-031：提子计数器按导入棋谱回算（SGF 不携带俘虏计数，由回放推导）
    await svc.game.recount_captures(game_id)
    # 导入为已结束记录（正式棋谱，可复盘/全局分析补数据）
    await repos.set_game_result(svc.db.conn, game_id, None)
    return {"game_id": game_id}


# ============================================================
# 单局操作（/{game_id}）
# ============================================================


@router.get("/{game_id}", response_model=GameDetailResponse)
async def get_game_detail(request: Request, game_id: int) -> dict:
    """对局详情 + 落子序列 + analysis_complete（API §3.1；GameInfo 白名单 Schema）。"""
    svc = get_services(request)
    detail = await repos.get_game_detail(svc.db.conn, game_id)
    if detail is None:
        raise AppError(ErrorCode.GAME_NOT_FOUND, "对局不存在")
    moves = await repos.list_moves(svc.db.conn, game_id)
    complete = await svc.review.analysis_complete(game_id)
    # 终局结算目数（双 PASS 确认结算局才有 scorings 行；复盘对局信息卡 hover 用）
    scoring = await repos.get_scoring(svc.db.conn, game_id)
    return {
        **to_public_game(detail),
        "moves": moves,
        "moves_count": detail["moves_count"],
        "analyses_count": detail["analyses_count"],
        "analysis_complete": complete,
        "black_score": scoring["black_score"] if scoring else None,
        "white_score": scoring["white_score"] if scoring else None,
    }


@router.delete("/{game_id}", status_code=204)
async def delete_game(request: Request, game_id: int) -> Response:
    """删除对局及关联数据（moves/position_analyses/scorings 级联）。

    M-6（2026/09/19 决策 B）：经 ``GameService.delete_game`` 串行化——先中止在途
    AI 并取对局锁，再删除并回收内存态（防在途写库命中已删对局、锁条目滞留）。
    """
    svc = get_services(request)
    deleted = await svc.game.delete_game(game_id)
    if not deleted:
        raise AppError(ErrorCode.GAME_NOT_FOUND, "对局不存在")
    # M-2/L-6/L-12：对局删除后统一回收内存态——分析版本/缓存、试下分支与会话槽、
    # 结算预判（`_last`/`_running`）、未决悔棋申请
    svc.analysis.remove_game(game_id)
    svc.review.remove_game(game_id)
    if svc.settlement is not None:
        svc.settlement.forget_game(game_id)
    svc.session.undo_request_clear(game_id)
    return Response(status_code=204)


@router.post("/{game_id}/favorite")
async def set_favorite(
    request: Request, game_id: int, payload: FavoriteRequest
) -> dict:
    """收藏/取消收藏（API §3.1）。"""
    svc = get_services(request)
    await svc.review.set_favorite(game_id, payload.favorite)
    return {"game_id": game_id, "favorite": payload.favorite}


@router.post("/{game_id}/refight")
async def refight(request: Request, game_id: int, payload: RefightRequest) -> dict:
    """复弈（T6.8）：从试下分支生成新对局（``parent_game_id`` 前导）。

    - 新对局 = 主谱前缀（至试下进入手数）+ 试下已落子；
    - 分析批量落盘（单事务）：前导 ``main:{0..N}`` 复制自包含、
      试下 ``trial:{r}`` → 新对局 ``main:{N+r}``（PRD §4.2.3）；
    - 试下分支不存在/越界 → ``ILLEGAL_ACTION``（仅会话作用域，REST 同进程）。
    """
    svc = get_services(request)
    new_id = await svc.review.replay_trial(game_id, payload.trial_id)
    return {"game_id": new_id}


@router.get("/{game_id}/curve")
async def get_curve(request: Request, game_id: int) -> list:
    """胜率/目差曲线（读 position_analyses，黑方视角，引擎无关）。"""
    svc = get_services(request)
    return await svc.review.curve(game_id)


@router.get("/{game_id}/replay")
async def get_replay_bundle(request: Request, game_id: int) -> dict:
    """复盘批量数据（曲线 + 每手推荐/点评；一次拉取前端缓存，2026/09/21 性能优化）。

    - 与 ``GET /{game_id}``（详情 + 落子序列）互补，不重复下发对局/落子；
    - 每手条目与 ``review.recommend`` **同口径同字段**（``variations`` 不含与
      ``moves[i]`` 重复的 ``move``，V2 形态），缺分析的局面为 ``has_data:false`` 空条目；
    - 试下分支不在此列（引擎现算，仍走 WS ``recommend.request``）。
    """
    svc = get_services(request)
    return await svc.review.replay_bundle(game_id)


@router.get("/{game_id}/replay/ownership")
async def get_replay_ownership(request: Request, game_id: int) -> dict:
    """整局领地矩阵（懒加载：前端首次开启 [领地] 时一次性拉取）。

    仅含确有领地数据的局面；缺失局面由前端回落 WS ``ownership.request``
    （服务端缺数据时会触发补分析，不得被批量快照的空值降级为终态无数据）。
    """
    svc = get_services(request)
    return await svc.review.replay_ownership(game_id)


@router.get("/{game_id}/ownership")
async def get_ownership(
    request: Request,
    game_id: int,
    move_no: Optional[int] = Query(default=None, ge=0, description="局面手数（缺省=当前）"),
) -> dict:
    """领地矩阵（读 position_analyses；缺数据 ANALYSIS_INCOMPLETE）。"""
    svc = get_services(request)
    return await svc.review.ownership(game_id, move_no=move_no)


@router.get("/{game_id}/sgf")
async def get_sgf(request: Request, game_id: int) -> Response:
    """SGF 下载（仅标准棋谱，API §3.1）。"""
    svc = get_services(request)
    content = await export_game_sgf(svc.db.conn, game_id)
    return Response(
        content=content,
        media_type="application/x-go-sgf",
        headers={
            "Content-Disposition": f'attachment; filename="game_{game_id}.sgf"'
        },
    )


@router.get("/{game_id}/report")
async def get_report(
    request: Request,
    game_id: int,
    perspective: Perspective = Query(default="B", description="视角 B/W"),
) -> dict:
    """分析报告（按需计算，黑白视角；数据不完整 ANALYSIS_INCOMPLETE）。"""
    svc = get_services(request)
    return await svc.report.generate(game_id, perspective=perspective)
