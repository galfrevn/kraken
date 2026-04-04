// Kraken Widget for Scriptable (iOS)
// Configured automatically by: kraken widget setup

const KRAKEN_URL = "https://YOUR_TUNNEL.trycloudflare.com";
const KRAKEN_TOKEN = "YOUR_TOKEN_HERE";

const COLORS = {
  bg: new Color("#0d1117"),
  card: new Color("#161b22"),
  accent: new Color("#7c3aed"),
  success: new Color("#22c55e"),
  warning: new Color("#eab308"),
  error: new Color("#ef4444"),
  text: new Color("#e6edf3"),
  muted: new Color("#7d8590"),
};

async function fetchWidget() {
  try {
    const req = new Request(`${KRAKEN_URL}/api/widget?token=${KRAKEN_TOKEN}`);
    req.timeoutInterval = 10;
    const json = await req.loadJSON();
    if (json && json.tasks) return json;
    return null;
  } catch (e) {
    return null;
  }
}

function fmt(s) {
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function createWidget(data) {
  const w = new ListWidget();
  w.backgroundColor = COLORS.bg;
  w.setPadding(12, 14, 12, 14);

  if (!data) {
    const t = w.addText("Kraken");
    t.font = Font.boldSystemFont(16);
    t.textColor = COLORS.text;
    w.addSpacer(4);
    const s = w.addText("offline");
    s.font = Font.systemFont(13);
    s.textColor = COLORS.error;
    return w;
  }

  const header = w.addStack();
  header.centerAlignContent();
  const dot = header.addText("● ");
  dot.font = Font.systemFont(12);
  dot.textColor = COLORS.success;
  const title = header.addText("Kraken");
  title.font = Font.boldSystemFont(16);
  title.textColor = COLORS.text;
  header.addSpacer();
  const up = header.addText(fmt(data.uptime_seconds || 0));
  up.font = Font.systemFont(11);
  up.textColor = COLORS.muted;

  w.addSpacer(8);

  const t = data.tasks || {};
  const row = w.addStack();
  row.spacing = 8;

  function stat(stack, label, value, color) {
    const col = stack.addStack();
    col.layoutVertically();
    const n = col.addText(String(value || 0));
    n.font = Font.boldMonospacedSystemFont(18);
    n.textColor = color;
    const l = col.addText(label);
    l.font = Font.systemFont(9);
    l.textColor = COLORS.muted;
  }

  stat(row, "running", t.running, COLORS.accent);
  stat(row, "pending", t.pending, COLORS.warning);
  stat(row, "done", t.completed, COLORS.success);
  stat(row, "failed", t.failed, COLORS.error);

  w.addSpacer(8);

  const recent = data.recent || [];
  if (recent.length > 0) {
    const div = w.addText("─".repeat(20));
    div.font = Font.systemFont(6);
    div.textColor = COLORS.card;
    w.addSpacer(4);

    for (const task of recent.slice(0, 2)) {
      const r = w.addStack();
      r.centerAlignContent();
      const name = r.addText((task.name || "").slice(0, 28));
      name.font = Font.systemFont(10);
      name.textColor = COLORS.muted;
      name.lineLimit = 1;
      r.addSpacer();
      const cost = r.addText(task.cost || "");
      cost.font = Font.monospacedSystemFont(9);
      cost.textColor = COLORS.muted;
      w.addSpacer(2);
    }
  }

  return w;
}

const data = await fetchWidget();
const widget = createWidget(data);

if (config.runsInWidget) {
  Script.setWidget(widget);
} else {
  widget.presentMedium();
}

Script.complete();
