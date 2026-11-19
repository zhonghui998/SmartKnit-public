# API 契约（对外）

> 系统的对外接口设计。所有请求/响应均为 `application/json`（图片接口返回二进制流）。

## 1. 产品与模板

### `GET /api/products`
返回可定制产品列表。

```json
[
  { "id": "myo_h_tote", "name": "Horizontal Tote Bag", "kind": "bag" },
  { "id": "myo_coaster", "name": "Knitted Coaster", "kind": "coaster" }
]
```

### `GET /api/product/{pid}/template`
返回该产品的定制模板：可选组件、色板、文字区域、尺寸。

```json
{
  "template": {
    "name": "Horizontal Tote Bag",
    "size": { "width_cm": 38, "height_cm": 33 },
    "palette": { "fabric": ["#FFFFFF", "#000000", "#1A5276"] },
    "components": [
      { "id": "body", "artwork": { "source": "ai_redraw" } }
    ],
    "text_areas": []
  }
}
```

### `POST /api/product/{pid}/spec`
**返回该产品的生成规格**——这是系统的核心设计：调用方可先确认「这个产品能表达什么」，再决定是否生成、如何引导用户。

```json
{
  "stitch": { "w": 266, "h": 176 },
  "tier": "large",
  "colors": 6,
  "palette": ["white", "black", "teal", "deep navy"],
  "min_block": 7,
  "no_scene": false,
  "fill_pct": 45
}
```

| 字段 | 含义 |
|---|---|
| `stitch` | 目标针织网格尺寸 |
| `tier` | 画布档位（tiny / small / large） |
| `colors` | 允许使用的颜色数 |
| `palette` | 建议色板（从产品纱线色中按照片主色吸附） |
| `min_block` | 最小可表达色块（针） |
| `no_scene` | 是否禁止背景场景 |
| `fill_pct` | 主体应占画面比例 |

## 2. 图案生成

### `POST /api/product/{pid}/ai-redraw`
照片 → 针织图案。

**请求**
```json
{ "image": "<base64>", "style": "standard" }
```

**响应**
```json
{
  "design": "<base64 png>",
  "mode": "image",
  "subject": "摩天轮"
}
```

当产品配置为「智能分流」时，同一端点会自动识别内容类型：

- 识别为文字 → 返回字体排版结果（`mode: "text"`），耗时约 10 秒
- 识别为图形 → 返回 AI 重绘结果（`mode: "image"`），耗时 60–180 秒

### `POST /api/product/{pid}/composite`
把当前设计合成到产品图上。

**请求**
```json
{ "design": "<base64>", "bag_color": "#FFFFFF" }
```

**响应**：`image/jpeg` 二进制（预览）或 `image/png`（`full: true` 时全分辨率）

## 3. 换色

### `POST /api/region-analyze`
分析图案中的可换色区域。

**请求**
```json
{ "design": "<base64>", "product_type": "myo_h_tote" }
```

**响应**
```json
{
  "map_id": "a1b2c3d4e5f6",
  "regions": [
    { "id": 1, "hex": "#40CAFC", "cells": 11284 },
    { id: 2, "hex": "#8CE13F", "cells": 8193 }
  ],
  "bg_ids": [1, 2],
  "region_index": "<base64 png>"
}
```

`bg_ids` 是会被镂空显示为袋身色的背景区域，前端不提供换色入口。

### `POST /api/region-recolor`
按区域换色。区域编号在 `map_id` 生命周期内保持不变。

**请求**
```json
{ "map_id": "a1b2c3d4e5f6", "assignments": { "3": "#FF0000" } }
```

**响应**
```json
{ "design": "<base64 png>" }
```

**语义保证**：只替换目标区域中与该区域代表色相近的像素，其他区域像素不变、区域内暗部细节保留。

## 4. 订单与生产

### `POST /api/product/{pid}/save`
保存设计并生成订单记录。

### `POST /api/product/{pid}/production-email`
生成生产工单并投递给工厂。

**请求**
```json
{ "design": "<base64>", "text": "HAPPY", "order_ref": "SK-20261119-001" }
```

## 5. 错误约定

```json
{ "error": "缺少图片数据" }
```

| 状态码 | 含义 |
|---|---|
| 400 | 请求参数缺失或非法 |
| 404 | 产品模板不存在 |
| 500 | 服务端处理失败 |
| 503 | 依赖服务不可用（识别/生图），前端应回落手动模式 |
