# Plotimo 应用名称与图标

- 应用名称：`Plotimo`。
- 命名含义：以 Plot（剧情）为核心的自创名称，适合英语短剧应用。
- 后台英文简介：`Watch short dramas packed with romance, suspense, and unexpected twists.`
- 图标：`plotimo-app-icon-1024.png`。珊瑚橙与杏色的 P 形胶片图案结合播放符号，配深紫实底。
- 导出规格：1024 × 1024 像素，PNG，无透明通道。
- 制作方式：使用内置 `image_gen` 生成并修整背景与边缘；最后通过 `sips` 等比例导出上传尺寸，保留生成原稿。
- 平台规格依据：[TikTok 应用注册说明](https://developers.tiktok.com/docs/en/getting-started-create-an-app)：1024 × 1024，JPEG/JPG/PNG，不超过 5 MB。
- 名称作为本次创意方案，未验证 TikTok 后台名称可用性。

## 原始生成提示词

以下为实际提交给生成工具的提示词。

```text
Use case: logo-brand.
Asset type: final upload-ready mobile app icon for an English-language short-drama TikTok Mini app named Plotimo.
Generate ONE image, exactly square 1024 x 1024 pixels. Full-bleed opaque solid deep aubergine background (#231529), extending to all four edges; square canvas, do not bake in rounded outer corners.
Primary subject: one striking, original, centered sculptural-geometric P monogram, merging a film ribbon and a right-pointing play symbol. The broad rounded P loop has a very clear large right-pointing triangular negative-space cutout in the background color. A strong short descending stem anchors the P, with one clean diagonal ribbon-fold termination. Optically centered, emblem occupies around 66 percent of the canvas height and 61 percent width, generous clear safe area on every side.
Visual style: beautifully proportioned professional entertainment app branding; bold silhouette, precise smooth curves, minimal flat vector-like design with just a refined warm coral-to-apricot gradient across the ribbon (#FF6D67 to #FFB46A), clean geometry. Rich high contrast, immediately readable at 48px. Energetic but sophisticated.
Constraints: only this single emblem and plain full-bleed background. No wordmark, no label, no slogan, no small text, no frame, no border, no watermark, no phone or UI mockup, no multiple options, no unrelated symbols. Do not imitate TikTok's musical-note mark or its cyan/red glitch treatment. No strong 3D bevel, no drop shadow, no glow, no stars or sparkles, no film perforations, no fine details. Deliver the standalone app icon artwork itself.
```

## 最终修整提示词

```text
Edit this image into a finished opaque square mobile APP ICON TILE for Plotimo. Preserve the existing warm coral/apricot ribbon P monogram with its right-pointing triangle counter and overall silhouette. The ONLY needed changes are background, edge cleanup, and output sizing. Replace ALL transparent areas with an absolutely solid, opaque, even dark aubergine (#231529) background filling the entire square canvas, including inside the P triangle. Remove all speckles/fringe outside the emblem and in its counter, so the colored P edges are clean and smooth. No transparent pixels anywhere, no alpha cutout anywhere. This image is a full square printed graphic with a background, not an isolated transparent logo. The deep aubergine background is an essential visible part of the artwork and must not be removed. Maintain generous 16% safe margin. No words, no new elements, no mockup, no outer rounded corners. Output exactly 1024 x 1024 pixels if supported.
```
