import { visibleWidth } from "@earendil-works/pi-tui";

/** Tool- and host-independent geometry. Exterior space is never painted. */
export interface CardGeometry {
  width: number;
  marginLeft: number;
  marginRight: number;
  borderWidth: number;
  paddingLeft: number;
  paddingRight: number;
  panelX: number;
  panelWidth: number;
  contentX: number;
  contentWidth: number;
  contentY: number;
}
export interface CardPaint {
  panel(text: string): string;
  border(text: string): string;
}

export function cardGeometry(width: number, outputPad = 1): CardGeometry {
  width = Math.max(0, Math.floor(width));
  const margin = outputPad === 0 ? 0 : 1;
  let spare = Math.max(0, width - 1);
  const borderWidth = Math.min(1, spare); spare -= borderWidth;
  const padding = Math.min(2, spare); spare -= padding;
  const paddingLeft = Math.ceil(padding / 2), paddingRight = Math.floor(padding / 2);
  const marginLeft = Math.min(margin, Math.floor(spare / 2));
  const marginRight = Math.min(margin, spare - marginLeft);
  return {
    width, marginLeft, marginRight, borderWidth, paddingLeft, paddingRight,
    panelX: marginLeft, panelWidth: width - marginLeft - marginRight,
    contentX: marginLeft + borderWidth + paddingLeft,
    contentWidth: width - marginLeft - marginRight - borderWidth - paddingLeft - paddingRight,
    contentY: 1,
  };
}

/** The caller renders its content at contentWidth; framing does not truncate it. */
export function frameRows(geometry: CardGeometry, body: readonly string[], paint: CardPaint): string[] {
  if (!geometry.width) return [];
  return ["", ...body, ""].map((row) => {
    const size = visibleWidth(row);
    if (size > geometry.contentWidth) throw new RangeError("Card content exceeds its allocated width");
    const border = geometry.borderWidth ? paint.border("┃") : "";
    const panel = " ".repeat(geometry.paddingLeft) + row +
      " ".repeat(geometry.contentWidth - size + geometry.paddingRight);
    // Child background/full resets are not a stack: reopen the panel after each one.
    // Keep the reset itself (including its foreground effects) and all child colors.
    const painted = panel.split(/(?<=\x1b\[(?:0|49)m)/u).map((part) => paint.panel(part)).join("");
    return frameShell(geometry, border, painted);
  });
}

/** Prepared children already paint every cell with complete styles. Do not scan
 * their ANSI or reopen a parent style across their explicit resets. */
export function frameMeasuredRow(geometry: CardGeometry, row: string, cells: number, paint: CardPaint): string {
  if (!Number.isSafeInteger(cells) || cells < 0 || cells > geometry.contentWidth)
    throw new RangeError("Card content exceeds its allocated width");
  if (!geometry.width) return "";
  const border = geometry.borderWidth ? paint.border("┃") : "";
  return frameShell(geometry, border, paint.panel(" ".repeat(geometry.paddingLeft)) + row +
    paint.panel(" ".repeat(geometry.contentWidth - cells + geometry.paddingRight)));
}

function frameShell(geometry: CardGeometry, border: string, panel: string): string {
  // Reset inherited background before the stripe; exterior space stays unpainted.
  return "\x1b[49m" + " ".repeat(geometry.marginLeft) + border + panel + " ".repeat(geometry.marginRight);
}

/** Coordinates are component-local; callers remove any outside transcript separator. */
export function insidePanel(geometry: CardGeometry, height: number, x: number, y: number): boolean {
  return geometry.width > 0 && x >= geometry.panelX && x < geometry.panelX + geometry.panelWidth && y >= 0 && y < height;
}
