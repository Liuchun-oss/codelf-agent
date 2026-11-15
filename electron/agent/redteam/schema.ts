// 红队演练资产库的表结构。
//
// 表名 / 列名 / 索引严格保持原样，未做改名 —— 工具实现、报告与计分口径都依赖这些
// 名字，改名会让已有数据与口径全部对不上。
//
// 23 张表分六组：
//   资产测绘 scan_run / segment / asset / asset_name / port / service / fingerprint / observation
//   关系     edge / tag
//   战果     vuln / credential / access_session / webshell / tunnel / score_hit
//   证据     http_evidence / attack_file / attack_step
//   计分     score_point / stage / shot
//   武器库   poc

export const REDTEAM_DDL = `
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS scan_run (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_session_id TEXT, tool TEXT, argv TEXT,
  started_at TEXT, finished_at TEXT, status TEXT DEFAULT 'running'
);

CREATE TABLE IF NOT EXISTS segment (
  cidr TEXT PRIMARY KEY, ip_start TEXT, ip_end TEXT,
  org TEXT, asn TEXT, country TEXT, city TEXT,
  source TEXT, first_seen TEXT, last_seen TEXT
);

CREATE TABLE IF NOT EXISTS asset (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  segment_cidr TEXT NOT NULL, ip TEXT NOT NULL, ip_int INTEGER,
  state TEXT DEFAULT 'unknown', primary_name TEXT, confidence REAL,
  first_seen TEXT, last_seen TEXT, discovered_at TEXT,
  test_status TEXT DEFAULT 'untested', test_notes TEXT, test_surface TEXT,
  test_updated_at TEXT, test_updated_by TEXT, blocked_count INTEGER DEFAULT 0,
  priority TEXT, potential TEXT, assess_reason TEXT, assessed_at TEXT, assessed_by TEXT,
  UNIQUE(segment_cidr, ip)
);

CREATE TABLE IF NOT EXISTS asset_name (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id INTEGER NOT NULL, name TEXT NOT NULL, kind TEXT,
  provenance TEXT, tool TEXT, first_seen TEXT, last_seen TEXT,
  UNIQUE(asset_id, name, kind)
);

CREATE TABLE IF NOT EXISTS port (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id INTEGER NOT NULL, proto TEXT DEFAULT 'tcp', port INTEGER NOT NULL,
  state TEXT DEFAULT 'open', provenance TEXT, tool TEXT, banner TEXT,
  url TEXT, title TEXT,
  first_seen TEXT, last_seen TEXT,
  UNIQUE(asset_id, proto, port)
);

CREATE TABLE IF NOT EXISTS service (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  port_id INTEGER NOT NULL, name TEXT, product TEXT, version TEXT, cpe TEXT,
  provenance TEXT, tool TEXT, first_seen TEXT, last_seen TEXT
);

CREATE TABLE IF NOT EXISTS fingerprint (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id INTEGER NOT NULL, port_id INTEGER,
  category TEXT, vendor TEXT, product TEXT, version TEXT,
  evidence TEXT, confidence REAL, provenance TEXT, tool TEXT,
  first_seen TEXT, last_seen TEXT
);

CREATE TABLE IF NOT EXISTS observation (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_kind TEXT NOT NULL, entity_id INTEGER NOT NULL,
  attr TEXT, value TEXT, provenance TEXT, tool TEXT,
  scan_run_id INTEGER, collected_at TEXT, raw_ref TEXT
);

CREATE TABLE IF NOT EXISTS edge (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  src_kind TEXT NOT NULL, src_id TEXT NOT NULL,
  dst_kind TEXT NOT NULL, dst_id TEXT NOT NULL,
  relation TEXT NOT NULL, confidence REAL, scan_run_id INTEGER,
  first_seen TEXT, last_seen TEXT,
  UNIQUE(src_kind, src_id, dst_kind, dst_id, relation)
);

CREATE TABLE IF NOT EXISTS tag (
  entity_kind TEXT NOT NULL, entity_id INTEGER NOT NULL, tag TEXT NOT NULL,
  note TEXT, created_by TEXT, created_at TEXT,
  PRIMARY KEY (entity_kind, entity_id, tag)
);

CREATE TABLE IF NOT EXISTS vuln (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id INTEGER, port_id INTEGER, cve TEXT, title TEXT, severity TEXT,
  source TEXT, confidence REAL, status TEXT, evidence TEXT, target TEXT,
  found_by_agent TEXT, found_at TEXT, gained TEXT, agent TEXT
);

CREATE TABLE IF NOT EXISTS score_point (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE,
  name TEXT NOT NULL,
  category TEXT,
  points INTEGER DEFAULT 0,
  max_hits INTEGER DEFAULT 1,
  description TEXT,
  enabled INTEGER DEFAULT 1,
  sort_order INTEGER DEFAULT 0,
  created_at TEXT, updated_at TEXT,
  src INTEGER,
  rule INTEGER,
  tier TEXT,
  cap INTEGER DEFAULT 0,
  dedup_scope TEXT DEFAULT 'service',
  legacy INTEGER DEFAULT 0,
  builtin INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS stage (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  subtitle TEXT,
  color TEXT,
  goal TEXT,
  sections TEXT,
  tools TEXT,
  transition TEXT,
  sort_order INTEGER DEFAULT 0,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS score_hit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  point_id INTEGER NOT NULL,
  asset_id INTEGER, vuln_id INTEGER, step_id INTEGER, target TEXT,
  evidence TEXT, note TEXT,
  self_created INTEGER DEFAULT 0,
  port INTEGER,
  recorded_by TEXT, recorded_at TEXT,
  points INTEGER,
  multiplier REAL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS credential (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id INTEGER, host TEXT, username TEXT, secret_type TEXT,
  secret_value TEXT, secret_ref TEXT,
  privilege TEXT, source TEXT, tool TEXT, note TEXT,
  found_by_agent TEXT, found_at TEXT, agent TEXT,
  UNIQUE(host, username, secret_type)
);

CREATE TABLE IF NOT EXISTS access_session (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id INTEGER, host TEXT, username TEXT, method TEXT, privilege TEXT,
  session_ref TEXT, note TEXT, found_by_agent TEXT, obtained_at TEXT
);

CREATE TABLE IF NOT EXISTS webshell (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id INTEGER, url TEXT NOT NULL, shell_type TEXT, pass_key TEXT,
  secret_ref TEXT, privilege TEXT,
  status TEXT DEFAULT 'unknown', last_check TEXT, check_note TEXT, latency_ms INTEGER,
  note TEXT, found_by_agent TEXT, created_at TEXT, updated_at TEXT, agent TEXT,
  UNIQUE(url, pass_key)
);

CREATE TABLE IF NOT EXISTS tunnel (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id INTEGER, webshell_id INTEGER, kind TEXT, listen TEXT,
  entry TEXT, reach TEXT,
  entry_kind TEXT,
  status TEXT DEFAULT 'unknown', last_check TEXT, check_note TEXT, latency_ms INTEGER,
  pid TEXT, command TEXT, note TEXT, found_by_agent TEXT, created_at TEXT, updated_at TEXT, agent TEXT
);

CREATE TABLE IF NOT EXISTS http_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vuln_id INTEGER, asset_id INTEGER, label TEXT,
  method TEXT, url TEXT, status INTEGER,
  request TEXT, response TEXT, note TEXT,
  captured_by TEXT, captured_at TEXT
);

CREATE TABLE IF NOT EXISTS attack_file (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target TEXT NOT NULL, target_kind TEXT, name TEXT NOT NULL, kind TEXT,
  path TEXT NOT NULL, description TEXT, evidence TEXT,
  asset_id INTEGER, vuln_id INTEGER, created_by TEXT, created_at TEXT,
  UNIQUE(target, name)
);

CREATE TABLE IF NOT EXISTS attack_step (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seq INTEGER, stage TEXT, title TEXT, detail TEXT,
  asset_id INTEGER, vuln_id INTEGER, access_id INTEGER, point_id INTEGER,
  evidence_ref TEXT, tool TEXT, agent TEXT, result TEXT,
  recorded_by TEXT, recorded_at TEXT
);

CREATE TABLE IF NOT EXISTS shot (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  point_id INTEGER, hit_id INTEGER, asset_id INTEGER, vuln_id INTEGER,
  target TEXT, label TEXT, note TEXT,
  file TEXT NOT NULL,
  kind TEXT DEFAULT 'screenshot',
  mime TEXT, bytes INTEGER, width INTEGER, height INTEGER, sha256 TEXT,
  source_ref TEXT, captured_at TEXT, found_by_agent TEXT, agent TEXT, created_at TEXT,
  UNIQUE(file)
);

CREATE INDEX IF NOT EXISTS ix_asset_segment ON asset(segment_cidr);
CREATE INDEX IF NOT EXISTS ix_asset_ip_int ON asset(ip_int);
CREATE INDEX IF NOT EXISTS ix_port_asset ON port(asset_id);
CREATE INDEX IF NOT EXISTS ix_port_port ON port(port);
CREATE INDEX IF NOT EXISTS ix_service_port ON service(port_id);
CREATE INDEX IF NOT EXISTS ix_service_name ON service(name, product, version);
CREATE INDEX IF NOT EXISTS ix_fp_asset ON fingerprint(asset_id);
CREATE INDEX IF NOT EXISTS ix_fp_product ON fingerprint(product, version);
CREATE INDEX IF NOT EXISTS ix_edge_src ON edge(src_kind, src_id);
CREATE INDEX IF NOT EXISTS ix_edge_dst ON edge(dst_kind, dst_id);
CREATE INDEX IF NOT EXISTS ix_obs_entity ON observation(entity_kind, entity_id);
CREATE INDEX IF NOT EXISTS ix_vuln_asset ON vuln(asset_id);
CREATE INDEX IF NOT EXISTS ix_vuln_sev ON vuln(severity, status);
CREATE INDEX IF NOT EXISTS ix_vuln_cve ON vuln(cve);
CREATE INDEX IF NOT EXISTS ix_cred_host ON credential(host);
CREATE INDEX IF NOT EXISTS ix_access_host ON access_session(host);
CREATE INDEX IF NOT EXISTS ix_webshell_status ON webshell(status);
CREATE INDEX IF NOT EXISTS ix_tunnel_status ON tunnel(status);
CREATE INDEX IF NOT EXISTS ix_shot_point ON shot(point_id);
CREATE INDEX IF NOT EXISTS ix_shot_hit ON shot(hit_id);
CREATE INDEX IF NOT EXISTS ix_shot_asset ON shot(asset_id);
CREATE INDEX IF NOT EXISTS ix_http_vuln ON http_evidence(vuln_id);
CREATE INDEX IF NOT EXISTS ix_http_asset ON http_evidence(asset_id);
CREATE INDEX IF NOT EXISTS ix_step_seq ON attack_step(seq, id);
CREATE INDEX IF NOT EXISTS ix_attack_target ON attack_file(target);
CREATE INDEX IF NOT EXISTS ix_score_hit_point ON score_hit(point_id);
CREATE INDEX IF NOT EXISTS ix_score_hit_time ON score_hit(recorded_at, id);
CREATE INDEX IF NOT EXISTS ix_score_hit_vuln ON score_hit(vuln_id);
CREATE INDEX IF NOT EXISTS ix_score_hit_step ON score_hit(step_id);
CREATE INDEX IF NOT EXISTS ix_step_asset ON attack_step(asset_id);
CREATE INDEX IF NOT EXISTS ix_step_vuln ON attack_step(vuln_id);
CREATE INDEX IF NOT EXISTS ix_step_recorded ON attack_step(recorded_at);
CREATE INDEX IF NOT EXISTS ix_asset_segment_state ON asset(segment_cidr, state);
CREATE INDEX IF NOT EXISTS ix_http_url ON http_evidence(url);
CREATE INDEX IF NOT EXISTS ix_tunnel_asset ON tunnel(asset_id);
CREATE INDEX IF NOT EXISTS ix_webshell_asset ON webshell(asset_id);
CREATE INDEX IF NOT EXISTS ix_credential_asset ON credential(asset_id);
CREATE INDEX IF NOT EXISTS ix_access_asset ON access_session(asset_id);
CREATE INDEX IF NOT EXISTS ix_score_hit_asset ON score_hit(asset_id);

CREATE VIEW IF NOT EXISTS v_asset_summary AS
SELECT a.id, a.ip, a.segment_cidr, a.state, a.primary_name, a.first_seen, a.last_seen,
  (SELECT COUNT(*) FROM port p WHERE p.asset_id = a.id AND p.state = 'open') AS open_ports,
  (SELECT COUNT(*) FROM observation o WHERE o.entity_kind = 'asset' AND o.entity_id = a.id AND o.provenance = 'passive') AS passive_signals,
  (SELECT COUNT(*) FROM observation o WHERE o.entity_kind = 'asset' AND o.entity_id = a.id AND o.provenance = 'active') AS active_signals
FROM asset a;

CREATE VIEW IF NOT EXISTS v_asset_service AS
SELECT p.asset_id, p.port, p.proto, p.provenance AS port_provenance,
       s.name AS service, s.product, s.version, s.provenance AS service_provenance
FROM port p LEFT JOIN service s ON s.port_id = p.id;
`

// 武器库表：上游单独建（不随主 DDL 走），core 套件不含 poc 工具，但表一并建好，
// 后续加 poc_* 工具时不必再迁移一次。
export const REDTEAM_POC_DDL = `
CREATE TABLE IF NOT EXISTS poc (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  title TEXT NOT NULL,
  kind TEXT,
  category TEXT,
  cve TEXT,
  component TEXT,
  versions TEXT,
  severity TEXT,
  language TEXT,
  source TEXT,
  source_url TEXT,
  description TEXT,
  usage TEXT,
  content TEXT,
  path TEXT,
  verified INTEGER DEFAULT 0,
  verified_note TEXT,
  hit_count INTEGER DEFAULT 0,
  used_on TEXT,
  engagement_id TEXT,
  engagement_name TEXT,
  asset_target TEXT,
  found_by_agent TEXT,
  tags TEXT,
  created_by TEXT, created_at TEXT, updated_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_poc_cve ON poc(cve);
CREATE INDEX IF NOT EXISTS ix_poc_component ON poc(component);
CREATE INDEX IF NOT EXISTS ix_poc_kind ON poc(kind, verified);
`

export const POC_CATEGORIES: ReadonlyArray<{ code: string; name: string; hint: string }> = [
  { code: 'rce', name: '远程命令执行', hint: '框架/中间件/组件 RCE、表达式注入、模板注入' },
  { code: 'deserialization', name: '反序列化', hint: 'Java/PHP/.NET 反序列化链、fastjson/jackson 等' },
  { code: 'file-upload', name: '文件上传 getshell', hint: '上传绕过、解析漏洞、二次渲染、竞争' },
  { code: 'sqli', name: 'SQL 注入', hint: '注入点验证、拖库、写文件、提权' },
  { code: 'unauthorized', name: '未授权访问', hint: '未鉴权接口/服务（Redis、Docker、Actuator、Swagger 调用）' },
  { code: 'auth-bypass', name: '认证绕过 / 越权', hint: '登录绕过、JWT 缺陷、越权读写、逻辑缺陷' },
  { code: 'weak-password', name: '弱口令 / 口令爆破', hint: '管理端弱口令、数据库弱口令、默认口令' },
  { code: 'ssrf', name: 'SSRF', hint: '服务端请求伪造、云元数据、内网探测跳板' },
  { code: 'xxe', name: 'XXE', hint: 'XML 外部实体读取与 SSRF' },
  { code: 'path-traversal', name: '目录穿越 / 任意文件读取', hint: '路径穿越、任意文件读、源码/配置读取' },
  { code: 'info-leak', name: '信息泄露', hint: '配置/凭据/源码/备份泄露（能升级为得分的那些）' },
  { code: 'privesc', name: '提权 / 横向', hint: '本地提权、凭据复用、Pass-the-Hash、横向工具' },
  { code: 'tunnel', name: '隧道 / 代理', hint: 'suo5、frp、chisel、Neo-ReGeorg、内网代理' },
  { code: 'other', name: '其它', hint: '不属于上面任何一类（写清用途）' }
]
