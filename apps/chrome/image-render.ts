export type ImageRegion = { source: string; translation: string; score: number; x: number; y: number; width: number; height: number; positioned?: boolean };
export type ImageLabel = { index: number; x: number; y: number; width: number; height: number; padding: number; fontSize: number; lineHeight: number; lines: string[]; positioned?: boolean };

export function imageRegions(items: unknown, width: number, height: number): ImageRegion[] {
  if (!Array.isArray(items) || items.length > 256) throw new Error("인식 영역이 너무 많거나 잘못되었습니다. 이미지의 일부를 확대해 다시 시도하세요.");
  return items.map(item => {
    if (!item || typeof item.text !== "string" || item.text.length > 16384 || !Number.isFinite(item.score)
      || !Array.isArray(item.poly) || item.poly.length !== 4 || !item.poly.every((point: unknown) => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite))) throw new Error("OCR 결과를 읽을 수 없습니다.");
    const xs = item.poly.map((point: number[]) => point[0]); const ys = item.poly.map((point: number[]) => point[1]);
    const x = Math.max(0, Math.min(width - 1, Math.min(...xs))); const y = Math.max(0, Math.min(height - 1, Math.min(...ys)));
    return { source: item.text.trim(), translation: "", score: item.score, x, y,
      width: Math.max(1, Math.min(width - x, Math.max(...xs) - x)), height: Math.max(1, Math.min(height - y, Math.max(...ys) - y)) };
  }).filter(region => region.source);
}

// One measured layout drives DOM labels and PNG export.
export function imageLabels(context: CanvasRenderingContext2D, regions: ImageRegion[], width = context.canvas.width, height = context.canvas.height, fontScale = 1): ImageLabel[] {
  return regions.flatMap((region, index) => {
    if (!region.translation.trim()) return [];
    const normalSize = Math.max(12, Math.min(32, Math.round(region.height * 0.8))) * 0.7;
    let fontSize = Math.round(normalSize * fontScale);
    const padding = Math.min(6, width / 8);
    const boxWidth = Math.min(width, Math.max(region.width, fontSize * 9));
    let lines: string[]; let boxHeight: number;
    do {
      context.font = `600 ${fontSize}px system-ui, sans-serif`;
      lines = []; let line = "";
      for (const character of region.translation) {
        if (character === "\n" || (line && context.measureText(line + character).width > boxWidth - 2 * padding)) { lines.push(line); line = ""; }
        if (character !== "\n") line += character;
      }
      if (line) lines.push(line);
      boxHeight = lines.length * fontSize * 1.4 + padding * 2;
      if (boxHeight > height && fontSize > 6) fontSize--;
      else break;
    } while (fontSize >= 6);
    return [{ index, x: region.positioned ? region.x : Math.max(0, Math.min(width - boxWidth, region.x)), y: region.positioned ? region.y : Math.max(0, Math.min(height - boxHeight, region.y)),
      width: boxWidth, height: boxHeight, padding, fontSize, lineHeight: fontSize * 1.4, lines, positioned: !!region.positioned }];
  });
}

export function drawImageTranslations(canvas: HTMLCanvasElement, regions: ImageRegion[], image: ImageBitmap, fontScale = 1) {
  const context = canvas.getContext("2d");
  if (!context) throw new Error("이미지를 그릴 수 없습니다.");
  const width = image.width; const height = image.height;
  const labels = imageLabels(context, regions, width, height, fontScale);
  const left = Math.floor(Math.min(0, ...labels.map(label => label.x))); const top = Math.floor(Math.min(0, ...labels.map(label => label.y)));
  canvas.width = Math.ceil(Math.max(width, ...labels.map(label => label.x + label.width))) - left;
  canvas.height = Math.ceil(Math.max(height, ...labels.map(label => label.y + label.height))) - top;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, -left, -top);
  for (const label of labels) {
    context.fillStyle = "rgba(20, 23, 33, 0.88)"; context.fillRect(label.x - left, label.y - top, label.width, label.height);
    context.fillStyle = "#fff"; context.textBaseline = "top"; context.font = `600 ${label.fontSize}px system-ui, sans-serif`;
    label.lines.forEach((text, index) => { context.fillText(text, label.x - left + label.padding, label.y - top + label.padding + index * label.lineHeight); });
  }
}
