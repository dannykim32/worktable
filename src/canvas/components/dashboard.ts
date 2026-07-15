// Dashboard component renderer (issue 07, ADR-0007). Reference rendering:
// the judged prototype's "Pilot gallery health" artifact — stat tiles, one
// labeled bar chart, sparkline-style lines: thin marks, rounded data ends,
// direct value labels, a single value axis, hairline grid.
//
// The SVG here is built entirely by trusted code via createElementNS;
// model-influenced strings (labels, categories, units) only ever land as
// textContent or aria-label text. Values and labels always wear ink colors
// (--text-primary / --text-secondary / --muted), never series colors.
// Hover tooltips are client-local and invisible to the agent (ADR-0010).
import type {
  ArtifactContent,
  ChartSeries,
  DashboardChart,
  DashboardTile,
} from "../../shared/artifacts.js";

const SVG_NS = "http://www.w3.org/2000/svg";

// ── Scales (exported for unit tests) ─────────────────────────────────────

export interface ValueDomain {
  min: number;
  max: number;
}

/**
 * The value domain always contains 0 — bars and lines are anchored to a
 * true zero baseline. Degenerate inputs (empty, all-zero) widen to [0, 1]
 * so the scale never divides by zero.
 */
export function valueDomain(ys: number[]): ValueDomain {
  let min = 0;
  let max = 0;
  for (const y of ys) {
    if (y < min) min = y;
    if (y > max) max = y;
  }
  if (min === 0 && max === 0) max = 1;
  return { min, max };
}

/** Round-numbered tick values covering the domain; always includes 0. */
export function tickValues(domain: ValueDomain, target = 5): number[] {
  const span = domain.max - domain.min;
  const pow = 10 ** Math.floor(Math.log10(span / target));
  const step =
    [1, 2, 5, 10].map((m) => m * pow).find((s) => span / s <= target) ??
    10 * pow;
  const ticks: number[] = [];
  const first = Math.ceil(domain.min / step - 1e-9);
  const last = Math.floor(domain.max / step + 1e-9);
  for (let i = first; i <= last; i++) {
    // Snap away floating-point noise (0.30000000000000004 → 0.3).
    ticks.push(Number((i * step).toPrecision(12)));
  }
  return ticks;
}

/** Tabular-context number formatting (rendered with tabular-nums via CSS). */
export function formatValue(v: number): string {
  return v.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

// ── DOM/SVG helpers ──────────────────────────────────────────────────────

function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function svgEl<K extends keyof SVGElementTagNameMap>(
  doc: Document,
  tag: K,
  attrs: Record<string, string | number> = {},
  text?: string,
): SVGElementTagNameMap[K] {
  const node = doc.createElementNS(SVG_NS, tag) as SVGElementTagNameMap[K];
  for (const [key, value] of Object.entries(attrs)) {
    node.setAttribute(key, String(value));
  }
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Categorical palette slot for series i — fixed order, never cycled. */
function seriesSlot(index: number): string {
  return `s${index + 1}`;
}

// ── Tiles ────────────────────────────────────────────────────────────────

function renderTiles(tiles: DashboardTile[], mount: HTMLElement): void {
  const doc = mount.ownerDocument;
  const grid = el(doc, "div", "tiles");
  for (const tile of tiles) {
    const card = el(doc, "div", "tile");
    card.appendChild(el(doc, "div", "label", tile.label));
    card.appendChild(el(doc, "div", "value", String(tile.value)));
    if (tile.delta) {
      card.appendChild(
        el(doc, "div", `delta tone-${tile.delta.tone}`, tile.delta.text),
      );
    }
    grid.appendChild(card);
  }
  mount.appendChild(grid);
}

// ── Charts ───────────────────────────────────────────────────────────────

/** Categorical x slots in fixed first-appearance order across all series. */
function categorySlots(series: ChartSeries[]): (string | number)[] {
  const slots: (string | number)[] = [];
  const seen = new Set<string>();
  for (const s of series) {
    for (const point of s.points) {
      const key = `${typeof point.x}:${String(point.x)}`;
      if (!seen.has(key)) {
        seen.add(key);
        slots.push(point.x);
      }
    }
  }
  return slots;
}

function slotKey(x: string | number): string {
  return `${typeof x}:${String(x)}`;
}

interface TooltipControl {
  wrap: HTMLElement;
  tip: HTMLElement;
}

/** One hover/focus tooltip per mark; focus also reaches it by keyboard. */
function makeMarkAccessible(
  mark: SVGElement,
  label: string,
  { wrap, tip }: TooltipControl,
): void {
  mark.classList.add("mark");
  mark.setAttribute("tabindex", "0");
  mark.setAttribute("role", "img");
  mark.setAttribute("aria-label", label);
  const show = () => {
    tip.textContent = label;
    // Best-effort positioning; rects are zero under happy-dom, harmless.
    const wrapRect = wrap.getBoundingClientRect();
    const markRect = mark.getBoundingClientRect();
    tip.style.left = `${markRect.left + markRect.width / 2 - wrapRect.left}px`;
    tip.style.top = `${markRect.top - wrapRect.top}px`;
    tip.style.display = "block";
  };
  const hide = () => {
    tip.style.display = "none";
  };
  mark.addEventListener("mouseenter", show);
  mark.addEventListener("mouseleave", hide);
  mark.addEventListener("focus", show);
  mark.addEventListener("blur", hide);
}

function markLabel(
  chart: DashboardChart,
  series: ChartSeries,
  multiSeries: boolean,
  x: string | number,
  y: number,
): string {
  const prefix = multiSeries ? `${series.label} · ` : "";
  const unit = chart.unit ? ` ${chart.unit}` : "";
  return `${prefix}${String(x)}: ${formatValue(y)}${unit}`;
}

/** Rounded 4px data-end anchored square at the baseline (prototype idiom). */
function barPath(x0: number, x1: number, yTop: number, h: number): string {
  const r = 4;
  if (Math.abs(x1 - x0) < 2 * r || h < 2 * r) {
    return `M ${x0} ${yTop} H ${x1} V ${yTop + h} H ${x0} Z`;
  }
  return x1 > x0
    ? `M ${x0} ${yTop} H ${x1 - r} a${r} ${r} 0 0 1 ${r} ${r} ` +
        `v ${h - 2 * r} a${r} ${r} 0 0 1 -${r} ${r} H ${x0} Z`
    : `M ${x0} ${yTop} H ${x1 + r} a${r} ${r} 0 0 0 -${r} ${r} ` +
        `v ${h - 2 * r} a${r} ${r} 0 0 0 ${r} ${r} H ${x0} Z`;
}

const CHART_W = 640;

function renderBarChart(
  chart: DashboardChart,
  svg: SVGSVGElement,
  control: TooltipControl,
): void {
  const doc = svg.ownerDocument;
  const slots = categorySlots(chart.series);
  const seriesN = Math.max(1, chart.series.length);
  const multi = chart.series.length > 1;
  const barH = multi ? 12 : 18;
  const groupGap = 12;
  // 2px surface gap between adjacent bars in a group.
  const groupH = seriesN * barH + (seriesN - 1) * 2 + groupGap;
  const padL = 110;
  const padR = 48;
  const padT = 8;
  const padB = 24;
  const H = padT + padB + Math.max(1, slots.length) * groupH;
  const innerW = CHART_W - padL - padR;
  svg.setAttribute("viewBox", `0 0 ${CHART_W} ${H}`);

  const domain = valueDomain(
    chart.series.flatMap((s) => s.points.map((p) => p.y)),
  );
  const x = (v: number) =>
    padL + ((v - domain.min) / (domain.max - domain.min)) * innerW;

  // Hairline grid + tick labels (ink, tabular-nums), behind the marks.
  for (const t of tickValues(domain)) {
    svg.appendChild(
      svgEl(doc, "line", {
        class: "grid",
        x1: x(t),
        y1: padT,
        x2: x(t),
        y2: H - padB,
      }),
    );
    svg.appendChild(
      svgEl(
        doc,
        "text",
        { class: "tick", x: x(t), y: H - 8, "text-anchor": "middle" },
        formatValue(t),
      ),
    );
  }
  // The single baseline, anchored at 0.
  svg.appendChild(
    svgEl(doc, "line", {
      class: "baseline",
      x1: x(0),
      y1: padT,
      x2: x(0),
      y2: H - padB,
    }),
  );

  slots.forEach((slot, slotIndex) => {
    const groupTop = padT + slotIndex * groupH + groupGap / 2;
    const groupMid = groupTop + (seriesN * barH + (seriesN - 1) * 2) / 2;
    svg.appendChild(
      svgEl(
        doc,
        "text",
        {
          class: "cat-label",
          x: padL - 8,
          y: groupMid + 4,
          "text-anchor": "end",
        },
        String(slot),
      ),
    );
    chart.series.forEach((series, seriesIndex) => {
      const point = series.points.find((p) => slotKey(p.x) === slotKey(slot));
      if (!point) return;
      const yTop = groupTop + seriesIndex * (barH + 2);
      const from = x(0);
      const to = x(point.y);
      // A true-zero value still gets a visible 1.5px sliver at the baseline.
      const drawTo =
        Math.abs(to - from) < 1.5 ? from + 1.5 * Math.sign(to - from || 1) : to;
      const bar = svgEl(doc, "path", {
        class: seriesSlot(seriesIndex),
        d: barPath(from, drawTo, yTop, barH),
        "data-series": series.label,
        "data-x": String(point.x),
        "data-y": String(point.y),
        "data-from": String(from),
        "data-to": String(to),
      });
      bar.classList.add("bar-mark");
      makeMarkAccessible(
        bar,
        markLabel(chart, series, multi, point.x, point.y),
        control,
      );
      svg.appendChild(bar);
      // Direct value label on the bar end — ink, never the series color.
      const negative = point.y < 0;
      svg.appendChild(
        svgEl(
          doc,
          "text",
          {
            class: "value-label",
            x: negative ? to - 6 : to + 6,
            y: yTop + barH / 2 + 4,
            "text-anchor": negative ? "end" : "start",
          },
          formatValue(point.y),
        ),
      );
    });
  });
}

function renderLineChart(
  chart: DashboardChart,
  svg: SVGSVGElement,
  control: TooltipControl,
): void {
  const doc = svg.ownerDocument;
  const slots = categorySlots(chart.series);
  const multi = chart.series.length > 1;
  const padL = 48;
  const padR = 96; // room for direct series labels at line ends
  const padT = 10;
  const padB = 24;
  const H = 190;
  const innerW = CHART_W - padL - padR;
  const innerH = H - padT - padB;
  svg.setAttribute("viewBox", `0 0 ${CHART_W} ${H}`);

  const domain = valueDomain(
    chart.series.flatMap((s) => s.points.map((p) => p.y)),
  );
  const y = (v: number) =>
    padT + (1 - (v - domain.min) / (domain.max - domain.min)) * innerH;
  const slotX = (i: number) =>
    slots.length < 2 ? padL + innerW / 2 : padL + (i / (slots.length - 1)) * innerW;
  const slotIndex = new Map(slots.map((s, i) => [slotKey(s), i]));

  for (const t of tickValues(domain)) {
    svg.appendChild(
      svgEl(doc, "line", {
        class: "grid",
        x1: padL,
        y1: y(t),
        x2: CHART_W - padR,
        y2: y(t),
      }),
    );
    svg.appendChild(
      svgEl(
        doc,
        "text",
        { class: "tick", x: padL - 8, y: y(t) + 4, "text-anchor": "end" },
        formatValue(t),
      ),
    );
  }
  svg.appendChild(
    svgEl(doc, "line", {
      class: "baseline",
      x1: padL,
      y1: y(0),
      x2: CHART_W - padR,
      y2: y(0),
    }),
  );
  slots.forEach((slot, i) => {
    svg.appendChild(
      svgEl(
        doc,
        "text",
        { class: "cat-label", x: slotX(i), y: H - 8, "text-anchor": "middle" },
        String(slot),
      ),
    );
  });

  chart.series.forEach((series, seriesIndex) => {
    const placed = series.points
      .map((p) => ({ p, i: slotIndex.get(slotKey(p.x)) }))
      .filter((e): e is { p: (typeof series.points)[number]; i: number } =>
        e.i !== undefined,
      )
      .map(({ p, i }) => ({ p, x: slotX(i), y: y(p.y) }));
    if (placed.length === 0) return;
    // Thin 2px line, rounded caps — the prototype's sparkline conventions.
    if (placed.length > 1) {
      const line = svgEl(doc, "polyline", {
        class: seriesSlot(seriesIndex),
        points: placed.map((e) => `${e.x},${e.y}`).join(" "),
      });
      line.classList.add("line");
      svg.appendChild(line);
    }
    for (const entry of placed) {
      const dot = svgEl(doc, "circle", {
        class: seriesSlot(seriesIndex),
        cx: entry.x,
        cy: entry.y,
        r: 4,
        "data-series": series.label,
        "data-x": String(entry.p.x),
        "data-y": String(entry.p.y),
      });
      dot.classList.add("dot");
      makeMarkAccessible(
        dot,
        markLabel(chart, series, multi, entry.p.x, entry.p.y),
        control,
      );
      svg.appendChild(dot);
    }
    // Direct series label at the line end — ink, never the series color.
    const last = placed[placed.length - 1]!;
    svg.appendChild(
      svgEl(
        doc,
        "text",
        { class: "series-label", x: last.x + 8, y: last.y + 4 },
        series.label,
      ),
    );
  });
}

function renderChart(chart: DashboardChart, mount: HTMLElement): void {
  const doc = mount.ownerDocument;
  const titleText = chart.unit ? `${chart.title} (${chart.unit})` : chart.title;
  mount.appendChild(el(doc, "div", "chart-title", titleText));

  // Identity is never color-alone: ≥2 series get a legend AND direct labels.
  if (chart.series.length > 1) {
    const legend = el(doc, "div", "chart-legend");
    chart.series.forEach((series, i) => {
      const key = el(doc, "span", "key");
      key.appendChild(el(doc, "span", `swatch ${seriesSlot(i)}`));
      key.appendChild(el(doc, "span", undefined, series.label));
      legend.appendChild(key);
    });
    mount.appendChild(legend);
  }

  const wrap = el(doc, "div", "chart-wrap");
  const svg = svgEl(doc, "svg", {
    class: `chart-svg ${chart.kind}`,
    role: "img",
    "aria-label": `${chart.kind} chart: ${chart.title}`,
    width: "100%",
  });
  const tip = el(doc, "div", "tooltip");
  wrap.append(svg, tip);
  mount.appendChild(wrap);

  const control: TooltipControl = { wrap, tip };
  if (chart.kind === "bar") renderBarChart(chart, svg, control);
  else renderLineChart(chart, svg, control);
}

export function renderDashboard(
  content: ArtifactContent,
  mount: HTMLElement,
): void {
  if (content.type !== "dashboard") return;
  mount.classList.add("dash");
  if (content.tiles.length > 0) renderTiles(content.tiles, mount);
  for (const chart of content.charts) renderChart(chart, mount);
}
