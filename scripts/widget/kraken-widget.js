// Kraken Widget for Scriptable (iOS)
// Copy this file into the Scriptable app and add it as a widget.
//
// Setup:
// 1. Set KRAKEN_URL to your tunnel URL or VPS IP
// 2. Set KRAKEN_TOKEN to match the widget.token in kraken.jsonc
// 3. Run the script once to verify it works
// 4. Add a Scriptable widget to your home screen and select this script

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
  const url = `${KRAKEN_URL}/api/widget?token=${KRAKEN_TOKEN}`;
  const req = new Request(url);
  req.timeoutInterval = 10;
  try {
    return await req.loadJSON();
  } catch {
    return null;
  }
}

function formatUptime(seconds) {
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

function createWidget(data) {
  const w = new ListWidget();
  w.backgroundColor = COLORS.bg;
  w.setPadding(12, 14, 12, 14);

  if (!data) {
    const offline = w.addText("Kraken");
    offline.font = Font.boldSystemFont(16);
    offline.textColor = COLORS.text;
    w.addSpacer(4);
    const status = w.addText("offline");
    status.font = Font.systemFont(13);
    status.textColor = COLORS.error;
    return w;
  }

  // Header
  const header = w.addStack();
  header.centerAlignContent();
  const dot = header.addText("● ");
  dot.font = Font.systemFont(12);
  dot.textColor = COLORS.success;
  const title = header.addText("Kraken");
  title.font = Font.boldSystemFont(16);
  title.textColor = COLORS.text;
  header.addSpacer();
  const uptime = header.addText(formatUptime(data.uptime_seconds));
  uptime.font = Font.systemFont(11);
  uptime.textColor = COLORS.muted;

  w.addSpacer(8);

  // Tasks row
  const tasks = data.tasks;
  const taskRow = w.addStack();
  taskRow.spacing = 8;

  function addStat(stack, label, value, color) {
    const col = stack.addStack();
    col.layoutVertically();
    const num = col.addText(String(value));
    num.font = Font.boldMonospacedSystemFont(18);
    num.textColor = color;
    const lbl = col.addText(label);
    lbl.font = Font.systemFont(9);
    lbl.textColor = COLORS.muted;
  }

  addStat(taskRow, "running", tasks.running, COLORS.accent);
  addStat(taskRow, "pending", tasks.pending, COLORS.warning);
  addStat(taskRow, "done", tasks.completed, COLORS.success);
  addStat(taskRow, "failed", tasks.failed, COLORS.error);

  w.addSpacer(8);

  // Recent tasks
  if (data.recent && data.recent.length > 0) {
    const divider = w.addText("─".repeat(20));
    divider.font = Font.systemFont(6);
    divider.textColor = COLORS.card;
    w.addSpacer(4);

    for (const task of data.recent.slice(0, 2)) {
      const row = w.addStack();
      row.centerAlignContent();
      const name = row.addText(task.name.slice(0, 28));
      name.font = Font.systemFont(10);
      name.textColor = COLORS.muted;
      name.lineLimit = 1;
      row.addSpacer();
      const cost = row.addText(task.cost);
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
