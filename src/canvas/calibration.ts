// Legibility calibration gallery (issue 11): a standalone authed canvas route
// that renders every svg Version with its gate findings drawn as outline boxes,
// and lets the human rule each finding correct / false-positive. Those rulings
// are the evidence ADR-0007 requires before the gate may ever enforce.
//
// Security invariants carried from the main canvas:
//   · the SVG is shown ONLY as an inert data:image/svg+xml <img> (Image
//     Isolation) — never inline, never an iframe;
//   · every model-influenced string (title, finding message, element ref)
//     reaches the DOM via textContent — never innerHTML.
import "./styles.css";

type CheckName = "text-overlap" | "edge-straddle" | "clipped" | "sub-legible";
type Verdict = "correct" | "false-positive";

interface Bbox {
  x: number;
  y: number;
  w: number;
  h: number;
}
interface Finding {
  check: CheckName;
  elements: string[];
  bbox: Bbox;
  message: string;
}
interface GalleryItem {
  artifact_id: string;
  version: number;
  title: string;
  svg: string;
  findings: Finding[];
}
interface CheckPrecision {
  check: CheckName;
  correct: number;
  falsePositive: number;
  precision: number | null;
}
interface Summary {
  perCheck: CheckPrecision[];
  totalRulings: number;
}
interface Ruling {
  artifact_id: string;
  version: number;
  finding_index: number;
  verdict: Verdict;
}

const CHECK_LABEL: Record<CheckName, string> = {
  "text-overlap": "text overlap",
  "edge-straddle": "edge straddle",
  clipped: "clipped",
  "sub-legible": "sub-legible",
};

const MAX_DISPLAY_WIDTH = 720;

function boot(): void {
  const app = document.getElementById("app");
  if (!app) return;

  const token = new URLSearchParams(location.search).get("token");
  if (!token) {
    const err = document.createElement("p");
    err.className = "canvas-error";
    err.textContent =
      "Missing capability token. Open this page via the link on the canvas " +
      "(it carries ?token=…).";
    app.appendChild(err);
    return;
  }
  const headers = { Authorization: `Bearer ${token}` };

  const header = document.createElement("header");
  header.className = "canvas-chrome";
  const h1 = document.createElement("h1");
  h1.textContent = "Legibility Calibration";
  const back = document.createElement("a");
  back.className = "cal-back";
  back.href = `/?token=${encodeURIComponent(token)}`;
  back.textContent = "← back to canvas";
  header.append(h1, back);

  const summaryEl = document.createElement("section");
  summaryEl.className = "cal-summary";
  const main = document.createElement("main");
  main.id = "cal-gallery";
  app.append(header, summaryEl, main);

  // Rulings already made, keyed artifact:version:index → verdict.
  const ruled = new Map<string, Verdict>();
  const key = (a: string, v: number, i: number) => `${a}:${v}:${i}`;

  function renderSummary(summary: Summary): void {
    summaryEl.replaceChildren();
    const intro = document.createElement("p");
    intro.className = "cal-intro";
    intro.textContent =
      `Report-only gate. ${summary.totalRulings} finding(s) ruled so far. ` +
      "Precision = correct ÷ ruled, per check:";
    summaryEl.appendChild(intro);
    const row = document.createElement("div");
    row.className = "cal-precision-row";
    for (const c of summary.perCheck) {
      const cell = document.createElement("div");
      cell.className = `cal-precision cal-${c.check}`;
      const name = document.createElement("span");
      name.className = "cal-precision-name";
      name.textContent = CHECK_LABEL[c.check];
      const val = document.createElement("span");
      val.className = "cal-precision-val";
      val.textContent =
        c.precision === null
          ? "— not ruled"
          : `${Math.round(c.precision * 100)}%`;
      const detail = document.createElement("span");
      detail.className = "cal-precision-detail";
      detail.textContent = `${c.correct} ok · ${c.falsePositive} false`;
      cell.append(name, val, detail);
      row.appendChild(cell);
    }
    summaryEl.appendChild(row);
  }

  function parseViewBox(svg: string): Bbox {
    const m = /viewBox="([^"]+)"/.exec(svg);
    if (m) {
      const n = m[1]!.trim().split(/[\s,]+/).map(Number);
      if (n.length === 4 && n.every((x) => Number.isFinite(x))) {
        return { x: n[0]!, y: n[1]!, w: n[2]!, h: n[3]! };
      }
    }
    return { x: 0, y: 0, w: 100, h: 100 };
  }

  async function postRuling(
    item: GalleryItem,
    index: number,
    finding: Finding,
    verdict: Verdict,
  ): Promise<void> {
    const res = await fetch("/api/calibration", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        artifact_id: item.artifact_id,
        version: item.version,
        finding_index: index,
        check: finding.check,
        verdict,
      }),
    });
    if (!res.ok) throw new Error(`POST /api/calibration failed: ${res.status}`);
    const data = (await res.json()) as { summary: Summary };
    ruled.set(key(item.artifact_id, item.version, index), verdict);
    renderSummary(data.summary);
  }

  function renderItem(item: GalleryItem): HTMLElement {
    const vb = parseViewBox(item.svg);
    const scale = vb.w > MAX_DISPLAY_WIDTH ? MAX_DISPLAY_WIDTH / vb.w : 1;
    const dispW = vb.w * scale;
    const dispH = vb.h * scale;

    const card = document.createElement("section");
    card.className = "cal-item";

    const head = document.createElement("div");
    head.className = "cal-item-head";
    const title = document.createElement("h2");
    title.textContent = item.title;
    const meta = document.createElement("span");
    meta.className = "cal-item-meta";
    meta.textContent = `${item.artifact_id} · v${item.version} · ${item.findings.length} finding(s)`;
    head.append(title, meta);

    // Figure: inert image with an absolutely-positioned overlay of boxes.
    const figure = document.createElement("div");
    figure.className = "cal-figure";
    figure.style.width = `${dispW}px`;
    figure.style.height = `${dispH}px`;
    const img = document.createElement("img");
    img.src = `data:image/svg+xml,${encodeURIComponent(item.svg)}`;
    img.alt = item.title;
    img.width = dispW;
    img.height = dispH;
    figure.appendChild(img);

    const overlay = document.createElement("div");
    overlay.className = "cal-overlay";
    item.findings.forEach((f, i) => {
      const box = document.createElement("div");
      box.className = `cal-box cal-${f.check}`;
      box.style.left = `${(f.bbox.x - vb.x) * scale}px`;
      box.style.top = `${(f.bbox.y - vb.y) * scale}px`;
      box.style.width = `${f.bbox.w * scale}px`;
      box.style.height = `${f.bbox.h * scale}px`;
      const tag = document.createElement("span");
      tag.className = "cal-box-tag";
      tag.textContent = String(i + 1);
      box.appendChild(tag);
      overlay.appendChild(box);
    });
    figure.appendChild(overlay);
    card.append(head, figure);

    if (item.findings.length === 0) {
      const clean = document.createElement("p");
      clean.className = "cal-clean";
      clean.textContent = "No findings — the gate rates this version clean.";
      card.appendChild(clean);
      return card;
    }

    const list = document.createElement("ol");
    list.className = "cal-findings";
    item.findings.forEach((f, i) => {
      const li = document.createElement("li");
      li.className = "cal-finding";

      const badge = document.createElement("span");
      badge.className = `cal-finding-check cal-${f.check}`;
      badge.textContent = `${i + 1}. ${CHECK_LABEL[f.check]}`;

      const msg = document.createElement("span");
      msg.className = "cal-finding-msg";
      msg.textContent = f.message;

      const els = document.createElement("span");
      els.className = "cal-finding-els";
      els.textContent = f.elements.join(", ");

      const buttons = document.createElement("div");
      buttons.className = "cal-rule-buttons";
      const verdictLabel = document.createElement("span");
      verdictLabel.className = "cal-verdict";

      const setVerdictLabel = () => {
        const v = ruled.get(key(item.artifact_id, item.version, i));
        verdictLabel.textContent = v ? `ruled: ${v}` : "";
      };

      const mkButton = (verdict: Verdict, label: string) => {
        const b = document.createElement("button");
        b.className = `cal-rule cal-rule-${verdict === "correct" ? "ok" : "fp"}`;
        b.textContent = label;
        b.addEventListener("click", () => {
          void postRuling(item, i, f, verdict)
            .then(setVerdictLabel)
            .catch((err: unknown) => {
              verdictLabel.textContent = `error: ${String(err)}`;
            });
        });
        return b;
      };
      buttons.append(
        mkButton("correct", "correct"),
        mkButton("false-positive", "false positive"),
        verdictLabel,
      );
      setVerdictLabel();

      li.append(badge, msg, els, buttons);
      list.appendChild(li);
    });
    card.appendChild(list);
    return card;
  }

  async function load(): Promise<void> {
    const [galleryRes, calRes] = await Promise.all([
      fetch("/api/calibration/gallery", { headers }),
      fetch("/api/calibration", { headers }),
    ]);
    if (!galleryRes.ok) throw new Error(`gallery ${galleryRes.status}`);
    const gallery = (await galleryRes.json()) as {
      items: GalleryItem[];
      summary: Summary;
    };
    if (calRes.ok) {
      const cal = (await calRes.json()) as { rulings: Ruling[] };
      for (const r of cal.rulings) {
        ruled.set(key(r.artifact_id, r.version, r.finding_index), r.verdict);
      }
    }
    renderSummary(gallery.summary);
    main.replaceChildren();
    if (gallery.items.length === 0) {
      const empty = document.createElement("p");
      empty.className = "gallery-empty";
      empty.textContent =
        "No free-form SVG artifacts yet — publish one to calibrate the gate.";
      main.appendChild(empty);
      return;
    }
    for (const item of gallery.items) main.appendChild(renderItem(item));
  }

  void load().catch((err: unknown) => {
    const note = document.createElement("p");
    note.className = "canvas-error";
    note.textContent = `Could not load the calibration gallery: ${String(err)}`;
    main.appendChild(note);
  });
}

boot();
