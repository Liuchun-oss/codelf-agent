// 内置得分点（《突破入侵类得分规则》合并版）。
// 未改动分值/上限/去重口径 —— 这三项决定「同一成果算几分」，改一个数就会让分数对不上规则。
//
// 字段含义：
//   rule        规则号（同一 rule 的得分点共用该规则的累计上限）
//   tier        同规则内的档位（普通/管理员/加成…），面板与报告按它分组
//   points      默认单次分值
//   cap         该规则累计上限，0 = 不设上限
//   dedup_scope service（同资产同端口只算最高一条）/ system（同系统只算最高权限一次）
//               / target（整个目标只算一次）/ none（按台累加）

export interface BuiltinScorePoint {
  src: number
  rule: number
  tier: string
  code: string
  name: string
  category: string
  points: number
  cap: number
  dedup_scope: string
  description: string
}

export const BUILTIN_SCORE_POINTS: ReadonlyArray<BuiltinScorePoint> = [
  {
    src: 1,
    rule: 1,
    tier: "一级 50 / 二级 20 分/个",
    code: "domain-control",
    name: "域名控制权限",
    category: "GENERAL",
    points: 50,
    cap: 400,
    dedup_scope: "system",
    description: "**一级域名 50 分/个，二级域名 20 分/个**，按域名类型给分；本项上限 400 分（G3）。\n记分时在 evidence 里写明域名与其类型；拿到二级域名时把单次分值调整为 20。"
  },
  {
    src: 2,
    rule: 2,
    tier: "5 / 10 分/台",
    code: "terminal-access",
    name: "终端权限（手机、Pad、PC、打印机、摄像头、wifi 路由器等）",
    category: "GENERAL",
    points: 10,
    cap: 600,
    dedup_scope: "system",
    description: "**打印机、wifi 路由器 5 分/台；PC、Pad、手机、摄像头、电子大屏 10 分/台**（G4），按台累加；本项上限 600 分（G3）。\n控制的终端设备需能证明与目标单位的关系（G7）；拿到 5 分档设备时把单次分值调整为 5。\n钓鱼获取的终端同样按本项计分，在 evidence 里写明目标人员角色（普通办公 / IT 运维 / 业务运营）。"
  },
  {
    src: 3,
    rule: 3,
    tier: "普通 10 / 管理员 50 分/个",
    code: "server-host",
    name: "服务器主机权限（含 webshell 权限）",
    category: "GENERAL",
    points: 50,
    cap: 600,
    dedup_scope: "system",
    description: "**普通权限 10 分/个，管理员权限 50 分/个**；本项上限 600 分（G3）。\n同一主机只按最高权限计一次（G1）——拿到 root/SYSTEM 后同主机不再累加普通权限。\n获取 1 台服务器主机不扣分；拿到普通权限时把单次分值调整为 10。"
  },
  {
    src: 4,
    rule: 4,
    tier: "普通 10 / 管理员 50 / 未授权 10 分/个",
    code: "db-credential",
    name: "数据库连接账号密码（含 SQL 注入）",
    category: "GENERAL",
    points: 50,
    cap: 400,
    dedup_scope: "system",
    description: "**普通用户权限 10 分/个，管理员权限 50 分/个；redis 和其他空密码、未授权访问成果统一 10 分/个**；本项上限 400 分（G3）。\n同一数据库的同等权限（含管理员）只得一次分；同一主机上的系统权限、应用权限、数据库权限按最高权限只得一次分（G1）。\n数据成果单独计分（G2）；拿到普通权限/未授权时把单次分值调整为 10。"
  },
  {
    src: 5,
    rule: 5,
    tier: "管理员 100 / 普通 50 分/个",
    code: "web-app",
    name: "邮箱系统 / 办公自动化与业务生产系统 / 其他 Web 应用系统权限",
    category: "WEB",
    points: 100,
    cap: 2000,
    dedup_scope: "system",
    description: "**管理员权限 100 分/个，普通用户权限 50 分/个；同一个系统只计算一次最高权限分**（G1）；本项上限 2000 分（G3）。\n本项合并原表第 5、6 项（规则与上限完全相同），**即\"控制 Web 应用系统\"这一类**；记分时在 evidence 里写明是哪类系统：\n· **邮箱系统**；\n· **办公自动化与业务生产系统**（办公 OA、ERP、直报即时通讯、财务系统、业务生产系统、数据仓库等被控或瘫痪后影响行业或单位业务生产、运行管理、日常办公的系统）；\n· **其他 Web 应用系统（兜底归类）**：用凭据清单里的账号**实测能登录**的 HTTP/HTTPS 站点，凡不归入其他更具体的得分点类别（集权系统走第 7 项、大数据系统走第 8 项、云管理平台走第 11 项、物联网管控平台走第 12 项、安全设备走第 13 项等），统一按本项计分（管理员 100 / 普通 50）。**凭据里只登记了 `host:port`、没写系统名或业务归属的 Web 登录（后台、管理端、运营平台、自研业务系统等）也走这一条**——先判是否有更贴切的类别，没有就归入\"控制 Web 应用系统\"，不因\"看不出是不是邮箱/OA\"而漏记。记分时 `target` 写实际登录 URL（带端口），evidence 写清\"什么站点 + 什么账号 + 管理员/普通档\"，并按红线一先实测登录。\n邮件数据按重要程度再单独计分（G2）；拿到普通用户权限时把单次分值调整为 50。"
  },
  {
    src: 7,
    rule: 6,
    tier: "管理员 500 / 普通 50 分/个",
    code: "central-system",
    name: "集权系统权限（运维 / 身份 / 组网 / 终端管理后台）",
    category: "CENTRAL",
    points: 500,
    cap: 4000,
    dedup_scope: "system",
    description: "**系统管理员权限 500 分/个，普通权限 50 分/个**；同一权限只给一次分，即获取管理员和普通权限只给管理员权限分（G1）；本项上限 4000 分（G3）。\n集权系统包括四类：\n· **运维集权类**：堡垒机、集中监控、统一资源发布等；\n· **身份权限管理类**：SSO、4A、IAM 等；\n· **组网集权类**：域控、证书认证、SDWAN 统一控制器等；\n· **终端主机管理后台类**：终端管理软件后台、零信任控制中心等。\n⚠️ 集权系统**托管的主机、终端等设备跨类引用\"控制一般系统\"的分值**（如 PC、移动终端 10 分/台，G4）——**不要按集权系统最高档 500 分算**，那会严重偏高；批量控制需提供证明：至少登录托管节点数量的 20%，最多登录 20 台即可。"
  },
  {
    src: 8,
    rule: 7,
    tier: "管理员 1000 / 普通 100 分/个",
    code: "bigdata-system",
    name: "大数据系统权限",
    category: "BIGDATA",
    points: 1000,
    cap: 4000,
    dedup_scope: "system",
    description: "**管理员权限 1000 分，普通权限 100 分/个**；同一权限只给一次分，既获取管理员和普通权限只给管理员权限分（G1）；本项上限 4000 分（G3）。\n数据单独计分（G2）；**有效数据量小于 5 亿条或 1TB 的按普通数据库计算**（即改用第 4 项分值）。"
  },
  {
    src: 9,
    rule: 8,
    tier: "普通 100 / 管理员 200 / 加成 200·1000 分",
    code: "netdev",
    name: "网络设备权限（防火墙、路由器、交换机、网闸、光闸、摆渡机、VPN 等）",
    category: "NETINFRA",
    points: 200,
    cap: 2000,
    dedup_scope: "service",
    description: "**普通用户权限 100 分，管理员权限 200 分**；本项上限 2000 分（G3）。需提供路由表等证据或连接量截图（G7）。\n在同一台设备上做到下列动作**再加分**（按做到的那一档记分）：\n· 借助该设备进行**网络重定向或业务劫持**：+200 分；\n· 在该设备上**植入远控程序并成功进行后续攻击**：1000 分。\n拿到普通权限或加成分时，把单次分值按实际档位调整。"
  },
  {
    src: 10,
    rule: 9,
    tier: "管理员 200 / 设备 10 分/个",
    code: "iiot",
    name: "工业互联网系统权限",
    category: "NETINFRA",
    points: 200,
    cap: 2000,
    dedup_scope: "system",
    description: "**管理后台管理员权限 200 分；托管的互联设备 10 分/个**（G4）；本项上限 2000 分（G3）。\n含车联网、智能制造、远程诊断、智能交通等。设备按个累加时用另起的命中记录（分值调为 10）。"
  },
  {
    src: 11,
    rule: 10,
    tier: "管理员 500 / 节点 10 分/台",
    code: "cloud-platform",
    name: "云管理平台控制权（含 PaaS 云平台，如 K8S、红帽 OpenShift 等）",
    category: "NETINFRA",
    points: 500,
    cap: 2000,
    dedup_scope: "system",
    description: "**管理员权限 500 分；云上主机、容器 10 分/台**（G4）；本项上限 2000 分（G3）。云上业务系统按重要系统规则单独计分。\n通过 ak/sk 批量控制默认**只计算被控节点分数、不计算管理员分数**，除非提供证明具有管理员权限（如新增云上节点、用户权限管理等）。\n⚠️ **节点数量小于 100 的按普通 Web 应用给分，节点不给分**（即走第 5、6 项口径）。"
  },
  {
    src: 12,
    rule: 11,
    tier: "平台 200 / 连接点 10 / 核心网 +5000 分",
    code: "iot-platform",
    name: "物联网设备管控平台权限",
    category: "NETINFRA",
    points: 200,
    cap: 2000,
    dedup_scope: "system",
    description: "**带控制功能的物联网平台 200 分；按平台上连接点数计算 10 分/台**（G4）；本项上限 2000 分（G3）。\n**通过物联网端点设备打入核心网并控制业务生产等重要系统的，单独加 5000 分**（不受本项 2000 分上限约束，单独记一条命中）。"
  },
  {
    src: 13,
    rule: 12,
    tier: "管理员 200 分",
    code: "secdev",
    name: "安全设备权限（IPS、IDS、审计设备、WAF 等非集权类安全设备）",
    category: "NETINFRA",
    points: 200,
    cap: 1000,
    dedup_scope: "service",
    description: "**管理员权限 200 分**；本项上限 1000 分（G3）。仅限非集权类安全设备（集权类走第 7 项）。"
  },
  {
    src: 14,
    rule: 13,
    tier: "管理员 50 / 普通 10 分/个",
    code: "file-storage",
    name: "文件存储类系统权限（FTP、对象存储、企业 NAS、企业网盘等）",
    category: "STORAGE",
    points: 50,
    cap: 500,
    dedup_scope: "system",
    description: "**管理员权限 50 分/个；普通用户权限、空系统或只含有测试数据的系统 10 分/个**；本项上限 500 分（G3）。\n含 FTP、对象存储（按系统计分）、企业 NAS、企业网盘等；数据单独计分（G2）。拿到普通权限时把单次分值调整为 10。"
  },
  {
    src: 15,
    rule: 14,
    tier: "100–500 分/个",
    code: "ai-agent",
    name: "模型智能体、skill 等 agent 工具（并能操作 agent 进行攻击）",
    category: "MODEL",
    points: 100,
    cap: 4000,
    dedup_scope: "service",
    description: "**100–500 分/个**，区间分，按控制与操作深度研判；本项上限 4000 分（G3）。\n含模型智能体、skill 等 agent 工具；记分时在 evidence 里写明控制/操作深度，并按研判档位调整单次分值。"
  },
  {
    src: 16,
    rule: 15,
    tier: "系统管理权限 500 分/个",
    code: "model-compute",
    name: "算力管理平台权限 / 训练数据与知识库系统权限",
    category: "MODEL",
    points: 500,
    cap: 4000,
    dedup_scope: "system",
    description: "**获取系统管理权限 500 分/个**；本项上限 4000 分（G3）。\n本项合并原表第 16、17 项（规则逐字相同），记分时在 evidence 里写明是哪类系统：\n· **算力管理平台**（可管控调度算力资源等）；\n· **训练数据、知识库等相关系统**（可窃取篡改训练数据或知识库、实施数据投毒等）。\n含大量数据系统（超 1 亿条或 10TB）**得分翻倍**、控制知识库相关系统**得分翻倍**（G5）。"
  },
  {
    src: 18,
    rule: 16,
    tier: "系统管理员权限 500 分/个",
    code: "model-data",
    name: "模型相关数据系统权限",
    category: "MODEL",
    points: 500,
    cap: 4000,
    dedup_scope: "system",
    description: "**获取系统管理员权限 500 分/个**；本项上限 4000 分（G3）。\n可干扰模型训练、推理、运营服务，窃取篡改模型权重文件等。\n⚠️ 与第 16、17 项的差异**不可抹平**：本项**没有\"控制知识库相关系统得分翻倍\"**，但有\"数据资产成果参照数据评分\"（G2）；超大数据规模系统（超 1 亿条或超 10TB）得分翻倍（G5）。"
  },
  {
    src: 19,
    rule: 17,
    tier: "管理员 500 分/个",
    code: "computepower-admin",
    name: "算力基础设施 · 管理员权限",
    category: "MODEL",
    points: 500,
    cap: 2000,
    dedup_scope: "system",
    description: "**管理员权限 500 分/个**；本项上限 2000 分（含路径分，G3）。\n本项与「算力基础设施 · 算力卡资源」同属第 19 项、共用 2000 分上限，三项（管理员权限 / 大量算力卡资源 / 算力卡池化平台）可分别得分但受本条总上限约束。"
  },
  {
    src: 19,
    rule: 18,
    tier: "10 分/卡",
    code: "computepower-cards",
    name: "算力基础设施 · 算力卡资源 / 算力卡池化平台",
    category: "MODEL",
    points: 10,
    cap: 2000,
    dedup_scope: "none",
    description: "**10 分/卡**，按卡累加（G4）；获取大量算力卡资源得分、获取算力卡池化平台直接得分，各上限 2000 分，且与「管理员权限」共用第 19 项总上限 2000 分。\n记分时在 evidence 里写明卡数或平台名称。"
  },
  {
    src: 22,
    rule: 19,
    tier: "1000 分",
    code: "boundary-logical",
    name: "进入逻辑隔离业务内网",
    category: "BOUNDARY",
    points: 1000,
    cap: 0,
    dedup_scope: "target",
    description: "**1000 分**。适用范围：整个目标单位突破同一类网络边界只给一次分。\n证明材料（G7）：防火墙隔离设备的控制截图、能访问内网的截图证明等。"
  },
  {
    src: 23,
    rule: 20,
    tier: "10000 分",
    code: "boundary-strong",
    name: "进入逻辑强隔离业务内网",
    category: "BOUNDARY",
    points: 10000,
    cap: 0,
    dedup_scope: "target",
    description: "**10000 分**。适用范围：整个目标单位突破同一类网络边界只给一次分。\n证明材料（G7）：网闸类隔离设备的控制截图、能访问内网的截图证明等。"
  },
  {
    src: 24,
    rule: 21,
    tier: "30000 分",
    code: "boundary-physical",
    name: "进入物理隔离内网、核心生产网",
    category: "BOUNDARY",
    points: 30000,
    cap: 0,
    dedup_scope: "target",
    description: "**30000 分**。适用范围：整个目标单位突破同一类网络边界只给一次分。\n证明材料（G7）：防火墙、VPN、多网卡主机、网络设备、网闸类隔离设备的控制截图，能访问内网的截图证明等。\n如铁路调度专网、银行核心账务网、电力生产控制大区、运营商信令网、能源生产物联网等。"
  },
  {
    src: 25,
    rule: 22,
    tier: "1000 分（最多 3000）",
    code: "boundary-supply",
    name: "借助供应链运维通道或云服务进入内网",
    category: "BOUNDARY",
    points: 1000,
    cap: 3000,
    dedup_scope: "service",
    description: "按三种情形计分：\n· 进入**同一主防单位内网**：1000 分；\n· 借助**一家**供应链单位或云服务进入**多家**主防单位内网：1000 分/每家主防单位；\n· 借助**多家**供应链单位或云服务进入**一家**主防单位内网不同网络区域：1000 分/个，最多 3000 分。\n记分时在 evidence 里写明属于哪种情形、涉及哪家主防单位/哪个网络区域。"
  },
  {
    src: 9,
    rule: 23,
    tier: "重定向 / 业务劫持 +200 分",
    code: "netdev-redirect",
    name: "网络设备 · 借助该设备进行网络重定向或业务劫持",
    category: "NETINFRA",
    points: 200,
    cap: 2000,
    dedup_scope: "none",
    description: "**在原「网络设备权限」分之上另加 200 分**（文档第 9 项）。\n适用：改路由/策略把流量引向我方可控节点、DNS 劫持、业务流量劫持等实际生效的重定向。\n需要提供证据（G7）：路由表、策略配置或连接量截图；evidence 里写清重定向方向与验证方式。"
  },
  {
    src: 9,
    rule: 24,
    tier: "植入远控 + 后续攻击 1000 分",
    code: "netdev-implant",
    name: "网络设备 · 植入远控程序并成功进行后续攻击",
    category: "NETINFRA",
    points: 1000,
    cap: 2000,
    dedup_scope: "none",
    description: "**在原「网络设备权限」分之上另加 1000 分**（文档第 9 项）。\n需要证明「植入成功 **且** 借它完成了后续攻击」两件事：远控进程/持久化证据 + 经该设备发起的后续成果。"
  },
  {
    src: 12,
    rule: 25,
    tier: "核心网 +5000 分",
    code: "iot-corenet",
    name: "物联网 · 经端点设备打入核心网并控制重要系统",
    category: "NETINFRA",
    points: 5000,
    cap: 5000,
    dedup_scope: "none",
    description: "**文档第 12 项明确「单独加 5000 分」**，不占该条 2000 分的上限。\n适用：从物联网端点设备横向进入核心网，并控制业务生产等重要系统；\nevidence 里写清：从哪个端点进、核心网里控了什么系统、拿到了什么权限。"
  },
]
