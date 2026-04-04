# Pixiv + Douyin Resource Server

一个高性能的本地资源后端服务  
支持 **Pixiv 图片** 和 **Douyin 视频** 的随机获取、查询、文件分发与缓存索引。

---

## ✨ 特性

- ⚡ SQLite 缓存（高性能索引）
- 📂 自动扫描资源目录
- 🔄 实时监听文件变化（新增 / 删除自动同步）
- 🎲 随机资源接口
- 🔍 info 查询接口
- 🖼️ 多图自动分页（Pixiv）
- 🎬 视频 Range 支持（在线播放）
- 🔗 URL 映射优化（无目录暴露）
- 🔒 防盗链（Referer 控制）
- ⚙️ 配置文件驱动（无需改代码）

---

## 📁 目录结构

```

project/
├── src/
│   └── app.js
├── data/
│   ├── config.conf
│   └── cache.db
├── resources/
│   ├── pixiv/
│   └── plus/

````

---

## 🚀 启动

```bash
node src/app.js
````

---

## 📦 安装依赖

```bash
npm install express better-sqlite3
```

---

## ⚙️ 配置

编辑文件：

```
data/config.conf
```

示例：

```
host=0.0.0.0
port=3000

resources=./resources
cache=./data/cache.db

allow_empty_referer=true
referers=http://localhost:3000,http://192.168.2.200:3000
```

---

## 📡 API

### 🎲 随机 Pixiv

```
GET /pixiv/artworks/random
```

返回：

```json
{
  "error": false,
  "message": "success",
  "body": {
    "illustId": "123456",
    "title": "示例作品",
    "pageCount": 3,
    "urls": [
      "http://host/pixiv/artworks/file/xxx_p1.png"
    ]
  }
}
```

---

### 🎲 随机视频

```
GET /plus/artworks/random
```

---

### 🔍 Pixiv 查询

```
GET /pixiv/artworks/info?list=关键词
```

---

### 🔍 视频查询

```
GET /plus/artworks/info?list=关键词
```

特殊：

```
GET /plus/artworks/info?list=all
```

👉 返回所有作者

---

### 🖼️ 文件访问

```
GET /pixiv/artworks/file/:filename
GET /plus/artworks/file/:filename
```

✔ 自动查找真实路径
✔ 不暴露目录结构

---

## 🔒 防盗链

基于 Referer 控制：

* 允许配置域名访问
* 可允许空 Referer（直链）

配置：

```
allow_empty_referer=true
referers=http://localhost:3000
```

---

## 🧠 工作原理

1. 启动时扫描资源目录
2. 写入 SQLite 缓存
3. 查询全部走数据库（极快）
4. 文件变动通过 `fs.watch` 实时更新

---

## ⚡ 性能说明

* 查询：O(1)（SQLite 索引）
* 启动扫描：仅首次执行
* 视频支持 Range（支持播放器拖动）

---

## 🧩 兼容

* Node.js >= 18
* Linux / Windows / NAS

---

## 👤 作者

**tangxifox**

---

## 📜 License

Apache License 2.0
