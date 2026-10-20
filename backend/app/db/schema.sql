-- tGo 基线 DDL（DATABASE §3）
-- 所有语句均使用 IF NOT EXISTS，保证迁移执行器可重复执行（幂等）。
-- 2026/09/18：原增量迁移 0001-0005 已全部合并入本基线（games 尾部 5 列）；
-- 增量编号自 0001 重新起算，存量库簿记已同批重置（DATABASE §4）。

CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 3.1 players 姓名/段位档案
CREATE TABLE IF NOT EXISTS players (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  rank       TEXT NOT NULL,               -- 12 档之一 (rank_20k ~ rank_9d)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(name, rank)
);

-- 3.2 games 对局元数据
CREATE TABLE IF NOT EXISTS games (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  mode                   TEXT NOT NULL CHECK(mode IN ('human_ai','human_human')),
  board_size             INTEGER NOT NULL DEFAULT 19,
  rules                  TEXT NOT NULL DEFAULT 'chinese',
  komi                   REAL NOT NULL DEFAULT 7.5,
  handicap               INTEGER NOT NULL DEFAULT 0,
  human_color            TEXT CHECK(human_color IN ('B','W')) DEFAULT 'B',
  status                 TEXT NOT NULL DEFAULT 'created' CHECK(status IN ('created','active','scoring','finished')),
  result                 TEXT,
  black_player_id        INTEGER REFERENCES players(id),
  black_name             TEXT NOT NULL DEFAULT '真人',
  black_rank             TEXT,
  white_player_id        INTEGER REFERENCES players(id),
  white_name             TEXT NOT NULL DEFAULT '真人',
  white_rank             TEXT,
  ai_style               TEXT CHECK(ai_style IN ('standard','human')),
  ai_level               INTEGER CHECK(ai_level BETWEEN 1 AND 12),
  adaptive_enabled       INTEGER NOT NULL DEFAULT 0,
  adaptive_initial_level TEXT,
  coaching_enabled       INTEGER NOT NULL DEFAULT 0,
  favorite               INTEGER NOT NULL DEFAULT 0,
  parent_game_id         INTEGER REFERENCES games(id),
  last_move_no           INTEGER NOT NULL DEFAULT 0,
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at             TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at            TEXT,
  -- 以下 5 列为历史增量迁移合并（2026/09/18：原 0002-0005 已基线化；
  -- 按既有库 ALTER 追加顺序排列，保证新老库物理列序一致）
  undo_count             INTEGER NOT NULL DEFAULT 0,   -- 全局悔棋步数（ISSUE-039：每撤一步 +1，只增不减、新落子不重置；重开归零；达 config.play.max_undo 整次拒绝）
  black_captures         INTEGER NOT NULL DEFAULT 0,   -- 黑方累计提子数（ISSUE-047；派生态：落子 +N，棋谱变更后按回放回算，BUG-031）
  white_captures         INTEGER NOT NULL DEFAULT 0,   -- 白方累计提子数（同上）
  pass_reset_move_no     INTEGER NOT NULL DEFAULT 0,   -- 双 PASS 结算计数边界（BUG-025：结算取消时写入当前手数，仅“边界之后”的两个 PASS 才算双 PASS）
  chain_visits           INTEGER NOT NULL DEFAULT 0    -- 创建时冻结的链精度 V_chain（BUG-026：整局不随配置变化；0=特性上线前老对局，读取时按当前配置派生）
);
CREATE INDEX IF NOT EXISTS idx_games_status ON games(status);
CREATE INDEX IF NOT EXISTS idx_games_favorite ON games(favorite);

-- 3.3 moves 落子序列
CREATE TABLE IF NOT EXISTS moves (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id    INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  move_no    INTEGER NOT NULL,            -- 1..N
  color      TEXT NOT NULL CHECK(color IN ('B','W')),
  x          INTEGER,                     -- 0-18；NULL 表示 PASS
  y          INTEGER,
  is_pass    INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(game_id, move_no)
);
CREATE INDEX IF NOT EXISTS idx_moves_game ON moves(game_id, move_no);

-- 3.4 position_analyses 每局面分析结果（标准/深度合并）
CREATE TABLE IF NOT EXISTS position_analyses (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id      INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  position_key TEXT NOT NULL,             -- 主谱: 'main:{move_no}' (0 = 初始局面)
  data_json    TEXT NOT NULL,             -- 预处理后 Analysis 结果（JSON TEXT，不压缩）
  max_visits   INTEGER NOT NULL,          -- 写入时的查询精度；落库行恒为链精度（BUG-026）
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(game_id, position_key)
);
CREATE INDEX IF NOT EXISTS idx_position_analyses_game ON position_analyses(game_id);

-- 3.5 scorings 终局结算（每对局一条，UPSERT 整体替换）
CREATE TABLE IF NOT EXISTS scorings (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id          INTEGER NOT NULL UNIQUE REFERENCES games(id) ON DELETE CASCADE,
  dead_points_json TEXT NOT NULL DEFAULT '[]',
  black_score      REAL,
  white_score      REAL,
  result           TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
