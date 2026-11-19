# 调用示例

## 1. 查到产品能力

```bash
curl -X POST http://localhost:8900/api/product/myo_h_tote/spec \
  -H 'Content-Type: application/json' -d '{}'
```

返回该产品的针数、色数、色板、最小色块等规格。**建议在生成前先调用**，用于判断这个产品能否表达客户想要的内容。

## 2. 生成图案

```bash
IMG=$(base64 -i photo.jpg)
curl -X POST http://localhost:8900/api/product/myo_h_tote/ai-redraw \
  -H 'Content-Type: application/json' \
  -d "{\"image\":\"$IMG\",\"style\":\"standard\"}"
```

响应中的 `design` 是 base64 PNG。

## 3. 合成预览

```bash
curl -X POST http://localhost:8900/api/product/myo_h_tote/composite \
  -H 'Content-Type: application/json' \
  -d "{\"design\":\"<design>\",\"bag_color\":\"#FFFFFF\"}" \
  -o preview.jpg
```

## 4. 换色

```bash
# 先分析可换色区域
curl -X POST http://localhost:8900/api/region-analyze \
  -H 'Content-Type: application/json' \
  -d "{\"design\":\"<design>\",\"product_type\":\"myo_h_tote\"}"

# 再把第 3 区换成红色
curl -X POST http://localhost:8900/api/region-recolor \
  -H 'Content-Type: application/json' \
  -d "{\"map_id\":\"<map_id>\",\"assignments\":{\"3\":\"#FF0000\"}}"
```
