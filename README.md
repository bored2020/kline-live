# K线直播间

一个给粉丝直播讲 K 线的网站。主播在页面上切换品种、画线、标注，所有观众的浏览器实时同步看到。

- 支持 A 股（沪/深/北交所、指数）和国内期货（主力连续、具体合约）
- 周期：1分、5分、15分、30分、60分、日K、周K、月K
- 指标：主图 MA / EMA / BOLL，副图 VOL / MACD / KDJ / RSI
- 画线：线段、直线、射线、水平线、垂直线、价格线、平行线、通道、斐波那契、矩形、文字
- 同步内容：品种、周期、指标、画线、图表缩放和拖动位置、主播鼠标位置、主播观点文字
- 画线按「品种 + 周期」自动保存，下次打开还在
- 行情由服务器统一拉取后推送，观众越多也不会多请求数据源，每个观众平均不到 0.1KB/s

行情数据来自新浪财经公开接口，仅供学习交流，不构成投资建议。

## 本地运行

需要 [Node.js](https://nodejs.org/) 18 或更高版本（推荐 20 LTS）。

```bash
git clone https://github.com/bored2020/kline-live.git
cd kline-live
npm install
```

启动时用环境变量 `HOST_PASSWORD` 设置主播密码。不设置的话，每次启动会随机生成一个并打印在终端里。

```bash
# Git Bash / macOS / Linux
HOST_PASSWORD=你的密码 npm start

# Windows PowerShell
$env:HOST_PASSWORD="你的密码"; npm start

# Windows CMD
set HOST_PASSWORD=你的密码&& npm start
```

默认端口是 3000，可以用环境变量 `PORT` 修改。

| 环境变量 | 说明 | 默认值 |
|---|---|---|
| `HOST_PASSWORD` | 主播密码 | 每次启动随机生成 |
| `PORT` | 监听端口 | `3000` |

启动后终端会打印：

```
K线直播间已启动: http://localhost:3000
主播入口:        http://localhost:3000/?host
主播密码:        你的密码
```

## 使用说明

### 观众

打开 `http://你的地址:3000/`，不用登录。页面会自动跟随主播的品种、周期和视角。

- 观众可以自己拖动或缩放图表查看历史。这时会暂停跟随，点右上角「回到主播视角」就能回到主播视角
- 主播鼠标所在的位置会显示一个圆圈
- 右上角显示当前在线人数

### 主播

打开 `http://你的地址:3000/?host`，输入主播密码。密码只在当前浏览器标签页里有效，关掉标签页要重新输入。

- **切换品种**：顶部搜索框输入代码、名称或拼音首字母，比如 `600519`、`茅台`、`rb`、`螺纹`，用上下键选中后回车
  - 股票代码格式：`sh600519`、`sz000001`、`bj430047`
  - 期货代码格式：主力连续用 `RB0`、`IF0`，具体合约用 `RB2510`
- **周期和指标**：顶部点选，观众同步切换
- **画线**：左侧工具栏选择工具，在图上依次点击几个点就画好了
  - 「磁吸」打开后，点会自动吸附到 K 线的开高低收
  - 点选已有的线可以拖动修改，右键或按 `Delete` 删除
  - `Ctrl+Z` 撤销上一条，`Esc` 取消正在画的线，「清空」删除当前品种和周期下的全部画线
  - 颜色在工具栏顶部选择
- **主播观点**：页面底部输入框输入文字后回车，所有观众页面顶部会显示这条观点，内容为空时不显示
- 也可以用「删除选中」按钮删除选中的画线

## 不用云服务器，用自己的网络直播

服务跑在自己电脑上，再让外网能访问到就行。三种方式：

1. **内网穿透（最简单）**：用 [cpolar](https://www.cpolar.com/)、花生壳或 Cloudflare Tunnel，把本机 3000 端口映射到一个公网地址，把这个地址发给粉丝
2. **公网 IP + 端口映射**：宽带有公网 IP 的话，在路由器上把 3000 端口转发到这台电脑，再在 Windows 防火墙放行 3000 端口
3. **局域网**：同一个 Wi-Fi 下的人访问 `http://电脑局域网IP:3000/`

直播期间电脑不能休眠，终端窗口也不能关。

## 部署到云服务器

下面以 Ubuntu 22.04 / 24.04 为例，阿里云、腾讯云、华为云等都适用。1 核 1G 的配置就够用，流量主要看带宽：每个观众首次打开大约 90KB，之后基本不占流量。

### 1. 安装 Node.js 和 Git

```bash
ssh root@你的服务器IP

curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs git
node -v   # 显示 v20.x 就行
```

### 2. 拉取代码

```bash
sudo mkdir -p /opt && cd /opt
git clone https://github.com/bored2020/kline-live.git
cd kline-live
npm install --omit=dev
```

### 3. 用 PM2 后台运行，开机自启

```bash
sudo npm install -g pm2

HOST_PASSWORD='换成你的强密码' pm2 start server.js --name kline-live
pm2 save
pm2 startup   # 按提示复制执行它打印的那行命令
```

常用命令：

```bash
pm2 status              # 查看运行状态
pm2 logs kline-live     # 查看日志
pm2 restart kline-live  # 重启
```

要修改密码，带上 `--update-env` 重启：

```bash
HOST_PASSWORD='新密码' pm2 restart kline-live --update-env && pm2 save
```

### 4. 开放端口

在云服务商控制台的「安全组 / 防火墙」里放行 TCP 3000 端口。服务器上如果启用了 ufw，也要放行：

```bash
sudo ufw allow 3000/tcp
```

这时访问 `http://服务器IP:3000/` 就能打开了。

### 5. 绑定域名并开启 HTTPS（推荐）

主播密码是通过网络发送的，用了 HTTPS 才会加密。准备好一个已经解析到服务器 IP 的域名（国内服务器的域名需要先备案）。

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
sudo nano /etc/nginx/sites-available/kline-live
```

写入下面的配置，把 `kline.example.com` 换成你的域名：

```nginx
server {
    listen 80;
    server_name kline.example.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        # WebSocket 必需
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 3600s;
    }
}
```

启用配置并申请免费证书：

```bash
sudo ln -s /etc/nginx/sites-available/kline-live /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d kline.example.com
```

完成后，观众访问 `https://kline.example.com/`，主播访问 `https://kline.example.com/?host`。页面会自动改用加密的 WebSocket（wss），不需要改代码。

用了 Nginx 之后，可以在安全组里关掉 3000 端口，只开放 80 和 443，这样外网就不能绕过 HTTPS 直接访问了。

### 6. 更新代码

本地修改后推送到 GitHub：

```bash
git add .
git commit -m "修改说明"
git push
```

服务器上拉取并重启：

```bash
cd /opt/kline-live
git pull
npm install --omit=dev
pm2 restart kline-live
```

### 数据备份

画线记录保存在 `data/store.json`，这个文件不会提交到 Git。迁移服务器时记得把它复制过去：

```bash
scp root@旧服务器IP:/opt/kline-live/data/store.json ./store.json
```

## 项目结构

```
server.js          服务端：行情代理、WebSocket 同步、画线存储
public/
  index.html       页面
  style.css        样式
  js/app.js        页面逻辑：主播操作、观众同步
  js/chart.js      图表初始化、指标、画线坐标转换
  js/sync.js       WebSocket 连接与自动重连
data/store.json    画线和主播状态（运行时生成）
```

## 常见问题

**页面一直显示「加载中」**：新浪接口偶尔会超时，刷新一下就好。境外服务器访问新浪可能比较慢或被限制，建议用国内服务器。

**观众看不到画线**：确认主播已经输入密码，右上角显示「主播」。另外，观众的品种和周期要和主播一致，如果观众自己拖动过图表，点「回到主播视角」即可。

**WebSocket 连不上**：用了 Nginx 的话，检查配置里有没有 `Upgrade` 和 `Connection` 这两行。

**忘记密码**：密码就是启动时设置的 `HOST_PASSWORD`，用新密码重启即可，见上面 PM2 部分。
