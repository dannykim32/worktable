// Issue 07 unit layer: dashboard schema boundary (series cap, second-axis
// impossibility), scale edge cases (neg/zero/single-point), tile/bar/line
// renderers, tooltip + keyboard marks, and the XSS canary.
import { describe, expect, test } from "bun:test";
import type { DashboardContent } from "../src/shared/artifacts.js";
import {
  formatValue,
  renderDashboard,
  tickValues,
  valueDomain,
} from "../src/canvas/components/dashboard.js";
import { componentRegistry } from "../src/canvas/components/registry.js";
import {
  validateArtifactContent,
  ValidationError,
} from "../src/server/validate.js";
import { makeDom } from "./dom.js";

const XSS = "<img src=x onerror=alert(1)>";

/** The golden fixture from the acceptance criteria: 4 tiles + bar + line. */
const golden: DashboardContent = {
  type: "dashboard",
  title: "Pilot gallery health",
  tiles: [
    {
      label: "Artifacts published",
      value: 24,
      delta: { text: "↑ 7 this session", tone: "good" },
    },
    {
      label: "Legibility gate pass",
      value: "87%",
      delta: { text: "↑ 4 pts after repair round", tone: "good" },
    },
    {
      label: "Hostile fixtures",
      value: "42/42",
      delta: { text: "all neutralized", tone: "neutral" },
    },
    {
      label: "Ask-backs pending",
      value: 3,
      delta: { text: "2 waiting a full day", tone: "bad" },
    },
  ],
  charts: [
    {
      kind: "bar",
      title: "Artifacts by type (this workspace)",
      series: [
        {
          label: "count",
          points: [
            { x: "document", y: 9 },
            { x: "svg sketch", y: 7 },
            { x: "dashboard", y: 5 },
            { x: "compare", y: 3 },
          ],
        },
      ],
    },
    {
      kind: "line",
      title: "Publishes per session",
      unit: "publishes",
      series: [
        {
          label: "publishes",
          points: [
            { x: "s1", y: 2 },
            { x: "s2", y: 4 },
            { x: "s3", y: 3 },
            { x: "s4", y: 6 },
            { x: "s5", y: 8 },
          ],
        },
      ],
    },
  ],
};

function rejectPath(input: unknown): string {
  try {
    validateArtifactContent(input);
  } catch (err) {
    if (err instanceof ValidationError) return err.path;
    throw err;
  }
  throw new Error("expected a ValidationError");
}

describe("dashboard schema boundary", () => {
  test("accepts the golden fixture at the tool boundary", () => {
    const content = validateArtifactContent(golden);
    expect(content.type).toBe("dashboard");
    if (content.type === "dashboard") {
      expect(content.tiles).toHaveLength(4);
      expect(content.charts).toHaveLength(2);
    }
  });

  test("rejects >4 series at the boundary — never a legend explosion", () => {
    const series = Array.from({ length: 5 }, (_, i) => ({
      label: `s${i}`,
      points: [{ x: "a", y: i }],
    }));
    expect(
      rejectPath({
        type: "dashboard",
        title: "t",
        tiles: [],
        charts: [{ kind: "bar", title: "c", series }],
      }),
    ).toBe("/charts/0/series");
  });

  test("points per series are capped at 200 (bound large inputs)", () => {
    const chartWith = (n: number) => ({
      type: "dashboard",
      title: "t",
      tiles: [],
      charts: [
        {
          kind: "line",
          title: "c",
          series: [
            {
              label: "s",
              points: Array.from({ length: n }, (_, i) => ({ x: i, y: i })),
            },
          ],
        },
      ],
    });
    const ok = validateArtifactContent(chartWith(200)); // 200 exactly is fine
    expect(ok.type).toBe("dashboard");
    expect(rejectPath(chartWith(201))).toBe("/charts/0/series/0/points");
  });

  test("a second y-axis is impossible by construction (unknown field)", () => {
    expect(
      rejectPath({
        type: "dashboard",
        title: "t",
        tiles: [],
        charts: [{ kind: "line", title: "c", series: [], y2: { max: 100 } }],
      }),
    ).toBe("/charts/0/y2");
  });

  test("rejects tile/chart overflow and bad leaf values with JSON paths", () => {
    const tile = { label: "l", value: 1 };
    expect(
      rejectPath({
        type: "dashboard",
        title: "t",
        tiles: Array.from({ length: 9 }, () => tile),
        charts: [],
      }),
    ).toBe("/tiles");
    const chart = { kind: "bar", title: "c", series: [] };
    expect(
      rejectPath({
        type: "dashboard",
        title: "t",
        tiles: [],
        charts: Array.from({ length: 5 }, () => chart),
      }),
    ).toBe("/charts");
    expect(
      rejectPath({
        type: "dashboard",
        title: "t",
        tiles: [{ label: "l", value: 1, delta: { text: "d", tone: "great" } }],
        charts: [],
      }),
    ).toBe("/tiles/0/delta/tone");
    expect(
      rejectPath({
        type: "dashboard",
        title: "t",
        tiles: [],
        charts: [
          {
            kind: "bar",
            title: "c",
            series: [{ label: "s", points: [{ x: "a", y: "9" }] }],
          },
        ],
      }),
    ).toBe("/charts/0/series/0/points/0/y");
  });
});

describe("scale functions", () => {
  test("value domain always anchors 0; degenerate inputs widen to [0, 1]", () => {
    expect(valueDomain([3, 9, 5])).toEqual({ min: 0, max: 9 });
    expect(valueDomain([-4, -2])).toEqual({ min: -4, max: 0 });
    expect(valueDomain([-3, 6])).toEqual({ min: -3, max: 6 });
    expect(valueDomain([7])).toEqual({ min: 0, max: 7 }); // single point
    expect(valueDomain([0, 0])).toEqual({ min: 0, max: 1 }); // all zero
    expect(valueDomain([])).toEqual({ min: 0, max: 1 }); // empty
  });

  test("ticks are round-numbered, cover the domain, and include 0", () => {
    expect(tickValues({ min: 0, max: 10 })).toEqual([0, 2, 4, 6, 8, 10]);
    expect(tickValues({ min: -3, max: 6 })).toEqual([-2, 0, 2, 4, 6]);
    expect(tickValues({ min: 0, max: 1 })).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
    expect(tickValues({ min: 0, max: 7 })).toContain(0);
    expect(formatValue(1234.5)).toBe("1,234.5");
  });
});

describe("dashboard renderer (golden fixture)", () => {
  test("4 tiles + bar + line produce the expected DOM/SVG structure", () => {
    const { mount } = makeDom();
    componentRegistry.dashboard(golden, mount);
    expect(mount.classList.contains("dash")).toBe(true);

    // Tiles: label + value + toned delta, values in ink via CSS classes.
    const tiles = [...mount.querySelectorAll(".tiles .tile")];
    expect(tiles).toHaveLength(4);
    expect(tiles[0]!.querySelector(".label")!.textContent).toBe(
      "Artifacts published",
    );
    expect(tiles[0]!.querySelector(".value")!.textContent).toBe("24");
    expect(tiles[0]!.querySelector(".delta")!.className).toBe(
      "delta tone-good",
    );
    expect(tiles[2]!.querySelector(".delta")!.className).toBe(
      "delta tone-neutral",
    );
    expect(tiles[3]!.querySelector(".delta")!.className).toBe(
      "delta tone-bad",
    );

    // Chart chrome: title (with unit), wrap, one tooltip each.
    const titles = [...mount.querySelectorAll(".chart-title")].map(
      (n) => n.textContent,
    );
    expect(titles).toEqual([
      "Artifacts by type (this workspace)",
      "Publishes per session (publishes)",
    ]);
    const wraps = [...mount.querySelectorAll(".chart-wrap")];
    expect(wraps).toHaveLength(2);
    for (const wrap of wraps) {
      expect(wrap.querySelector("svg")).not.toBeNull();
      expect(wrap.querySelector(".tooltip")).not.toBeNull();
    }
    // Single series → chart title names it; no legend box.
    expect(mount.querySelector(".chart-legend")).toBeNull();

    // Bar chart: fixed slot order, one bar + one ink value label per slot,
    // hairline grid and exactly one baseline.
    const bar = wraps[0]!.querySelector("svg")!;
    const cats = [...bar.querySelectorAll(".cat-label")].map(
      (n) => n.textContent,
    );
    expect(cats).toEqual(["document", "svg sketch", "dashboard", "compare"]);
    expect(bar.querySelectorAll(".bar-mark")).toHaveLength(4);
    expect(
      [...bar.querySelectorAll(".value-label")].map((n) => n.textContent),
    ).toEqual(["9", "7", "5", "3"]);
    expect(bar.querySelectorAll(".grid").length).toBeGreaterThan(2);
    expect(bar.querySelectorAll(".baseline")).toHaveLength(1);
    // First (only) series wears categorical slot 1.
    expect(bar.querySelector(".bar-mark")!.classList.contains("s1")).toBe(true);

    // Line chart: one 2px polyline, a dot mark per point, direct series
    // label at the line end (ink class, not a series fill).
    const line = wraps[1]!.querySelector("svg")!;
    expect(line.querySelectorAll("polyline.line")).toHaveLength(1);
    expect(line.querySelectorAll(".dot")).toHaveLength(5);
    expect(line.querySelector(".series-label")!.textContent).toBe("publishes");
    expect(line.querySelectorAll(".baseline")).toHaveLength(1);
  });

  test("≥2 series get a legend with swatches in fixed slot order", () => {
    const { mount } = makeDom();
    renderDashboard(
      {
        type: "dashboard",
        title: "two series",
        tiles: [],
        charts: [
          {
            kind: "bar",
            title: "a vs b",
            series: [
              { label: "alpha", points: [{ x: "k", y: 1 }] },
              { label: "beta", points: [{ x: "k", y: 2 }] },
            ],
          },
        ],
      },
      mount,
    );
    const keys = [...mount.querySelectorAll(".chart-legend .key")];
    expect(keys).toHaveLength(2);
    expect(keys[0]!.textContent).toBe("alpha");
    expect(keys[0]!.querySelector(".swatch")!.classList.contains("s1")).toBe(
      true,
    );
    expect(keys[1]!.querySelector(".swatch")!.classList.contains("s2")).toBe(
      true,
    );
    // Grouped bars keep the fixed order too.
    const marks = [...mount.querySelectorAll(".bar-mark")];
    expect(marks[0]!.classList.contains("s1")).toBe(true);
    expect(marks[1]!.classList.contains("s2")).toBe(true);
  });

  test("negative and zero y anchor to the 0 baseline (bar and line)", () => {
    const { mount } = makeDom();
    renderDashboard(
      {
        type: "dashboard",
        title: "signed",
        tiles: [],
        charts: [
          {
            kind: "bar",
            title: "deltas",
            series: [
              {
                label: "d",
                points: [
                  { x: "up", y: 6 },
                  { x: "down", y: -4 },
                  { x: "flat", y: 0 },
                ],
              },
            ],
          },
          {
            kind: "line",
            title: "trend",
            series: [
              {
                label: "t",
                points: [
                  { x: "a", y: -2 },
                  { x: "b", y: 0 },
                  { x: "c", y: 2 },
                ],
              },
            ],
          },
        ],
      },
      mount,
    );
    const svgs = [...mount.querySelectorAll(".chart-wrap svg")];

    // Bars: every bar starts at the baseline; sign decides the direction.
    const bar = svgs[0]!;
    const baselineX = Number(bar.querySelector(".baseline")!.getAttribute("x1"));
    const marks = [...bar.querySelectorAll(".bar-mark")];
    const byX = new Map(
      marks.map((m) => [
        m.getAttribute("data-x"),
        {
          from: Number(m.getAttribute("data-from")),
          to: Number(m.getAttribute("data-to")),
        },
      ]),
    );
    for (const { from } of byX.values()) expect(from).toBeCloseTo(baselineX);
    expect(byX.get("up")!.to).toBeGreaterThan(baselineX);
    expect(byX.get("down")!.to).toBeLessThan(baselineX);
    expect(byX.get("flat")!.to).toBeCloseTo(baselineX);

    // Line: y=0 sits exactly on the baseline; SVG y grows downward.
    const line = svgs[1]!;
    const baselineY = Number(
      line.querySelector(".baseline")!.getAttribute("y1"),
    );
    const cy = new Map(
      [...line.querySelectorAll(".dot")].map((d) => [
        d.getAttribute("data-x"),
        Number(d.getAttribute("cy")),
      ]),
    );
    expect(cy.get("b")!).toBeCloseTo(baselineY);
    expect(cy.get("a")!).toBeGreaterThan(baselineY);
    expect(cy.get("c")!).toBeLessThan(baselineY);
  });

  test("a single-point line renders one centered dot and no polyline", () => {
    const { mount } = makeDom();
    renderDashboard(
      {
        type: "dashboard",
        title: "one point",
        tiles: [],
        charts: [
          {
            kind: "line",
            title: "lonely",
            series: [{ label: "s", points: [{ x: "only", y: 5 }] }],
          },
        ],
      },
      mount,
    );
    const svg = mount.querySelector(".chart-wrap svg")!;
    expect(svg.querySelectorAll("polyline")).toHaveLength(0);
    const dots = svg.querySelectorAll(".dot");
    expect(dots).toHaveLength(1);
    expect(Number(dots[0]!.getAttribute("cx"))).toBeGreaterThan(0);
  });

  test("hover tooltip shows label + value per mark, and hides on leave", () => {
    const { window, mount } = makeDom();
    renderDashboard(golden, mount);
    const wrap = mount.querySelector(".chart-wrap")!;
    const tip = wrap.querySelector(".tooltip") as HTMLElement;
    const mark = wrap.querySelector(".bar-mark")!;
    mark.dispatchEvent(new window.Event("mouseenter"));
    expect(tip.style.display).toBe("block");
    expect(tip.textContent).toBe("document: 9");
    mark.dispatchEvent(new window.Event("mouseleave"));
    expect(tip.style.display).toBe("none");
  });

  test("keyboard focus reaches every mark and drives the tooltip", () => {
    const { window, mount } = makeDom();
    renderDashboard(golden, mount);
    const marks = [...mount.querySelectorAll(".mark")];
    expect(marks).toHaveLength(9); // 4 bars + 5 dots
    for (const mark of marks) {
      expect(mark.getAttribute("tabindex")).toBe("0");
      expect(mark.getAttribute("aria-label")).toMatch(/: /);
    }
    const wraps = [...mount.querySelectorAll(".chart-wrap")];
    const lineTip = wraps[1]!.querySelector(".tooltip") as HTMLElement;
    const dot = wraps[1]!.querySelectorAll(".dot")[3]!;
    dot.dispatchEvent(new window.Event("focus"));
    expect(lineTip.style.display).toBe("block");
    expect(lineTip.textContent).toBe("s4: 6 publishes");
    dot.dispatchEvent(new window.Event("blur"));
    expect(lineTip.style.display).toBe("none");
  });

  test("XSS canary: hostile labels render as literal text, never markup", () => {
    const { mount } = makeDom();
    renderDashboard(
      {
        type: "dashboard",
        title: "canary",
        tiles: [{ label: XSS, value: XSS, delta: { text: XSS, tone: "bad" } }],
        charts: [
          {
            kind: "bar",
            title: XSS,
            unit: XSS,
            series: [
              { label: XSS, points: [{ x: XSS, y: 1 }] },
              { label: "other", points: [{ x: XSS, y: 2 }] },
            ],
          },
        ],
      },
      mount,
    );
    expect(mount.querySelector("img")).toBeNull();
    expect(mount.querySelector(".tile .label")!.textContent).toBe(XSS);
    expect(mount.querySelector(".tile .value")!.textContent).toBe(XSS);
    expect(mount.querySelector(".chart-title")!.textContent).toBe(
      `${XSS} (${XSS})`,
    );
    expect(
      mount.querySelector(".chart-legend .key")!.textContent,
    ).toBe(XSS);
    expect(mount.querySelector("svg .cat-label")!.textContent).toBe(XSS);
    // The tooltip/aria path is textContent-only as well.
    expect(
      mount.querySelector(".bar-mark")!.getAttribute("aria-label"),
    ).toContain(XSS);
    expect(mount.querySelectorAll("img, script")).toHaveLength(0);
  });
});
