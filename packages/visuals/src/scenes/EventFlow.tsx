import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring } from "remotion";
import { loadFont } from "@remotion/google-fonts/JetBrainsMono";
import { COLORS } from "../constants";

const { fontFamily: mono } = loadFont("normal", {
  weights: ["400", "700"],
  subsets: ["latin"],
});

type EventSource = {
  label: string;
  sublabel: string;
  y: number;
};

const SOURCES: EventSource[] = [
  { label: "cron", sublabel: "0 9 * * *", y: 120 },
  { label: "webhook", sublabel: "github push", y: 310 },
  { label: "watcher", sublabel: "src/**/*.ts", y: 500 },
  { label: "telegram", sublabel: "/command", y: 690 },
];

type WorkerTask = {
  label: string;
  status: "running" | "done";
  sourceIdx: number;
  y: number;
};

const WORKERS: WorkerTask[] = [
  { label: "lint + fix", status: "done", sourceIdx: 0, y: 170 },
  { label: "review PR #42", status: "running", sourceIdx: 1, y: 360 },
  { label: "run tests", status: "running", sourceIdx: 2, y: 550 },
];

// --- Animated connection line ---
const FlowLine: React.FC<{
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  frame: number;
  fps: number;
  delay: number;
  active: boolean;
}> = ({ fromX, fromY, toX, toY, frame, fps, delay, active }) => {
  const progress = interpolate(frame, [delay, delay + 0.4 * fps], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  if (progress <= 0) return null;

  const dx = toX - fromX;
  const dy = toY - fromY;
  const length = Math.sqrt(dx * dx + dy * dy);
  const angle = Math.atan2(dy, dx) * (180 / Math.PI);

  // Pulse
  const pulseFrame = Math.max(0, frame - delay - 0.4 * fps);
  const pulseCycle = 1.2 * fps;
  const pulsePos = active ? (pulseFrame % pulseCycle) / pulseCycle : -1;

  return (
    <div
      style={{
        position: "absolute",
        left: fromX,
        top: fromY,
        width: length * progress,
        height: 0,
        borderTop: `1px solid ${active ? COLORS.textMuted : COLORS.border}`,
        transformOrigin: "0 0",
        transform: `rotate(${angle}deg)`,
        overflow: "visible",
      }}
    >
      {/* Traveling pulse */}
      {active && pulsePos >= 0 && (
        <div
          style={{
            position: "absolute",
            left: `${pulsePos * 100}%`,
            top: -3,
            width: 6,
            height: 6,
            borderRadius: "50%",
            backgroundColor: COLORS.accent,
            boxShadow: `0 0 10px ${COLORS.accent}, 0 0 20px ${COLORS.accent}44`,
          }}
        />
      )}
    </div>
  );
};

// --- Node box ---
const NodeBox: React.FC<{
  x: number;
  y: number;
  width: number;
  label: string;
  sublabel?: string;
  borderColor: string;
  frame: number;
  fps: number;
  delay: number;
}> = ({ x, y, width, label, sublabel, borderColor, frame, fps, delay }) => {
  const scale = spring({ frame, fps, delay, config: { damping: 200 } });
  const opacity = interpolate(frame, [delay, delay + 0.2 * fps], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        width,
        opacity,
        transform: `scale(${scale})`,
        transformOrigin: "center center",
      }}
    >
      <div
        style={{
          backgroundColor: COLORS.element,
          border: `1px solid ${borderColor}`,
          borderRadius: 8,
          padding: "14px 18px",
          textAlign: "center",
        }}
      >
        <div style={{ fontSize: 14, color: COLORS.text, fontWeight: 700 }}>{label}</div>
        {sublabel && (
          <div style={{ fontSize: 11, color: COLORS.textDim, marginTop: 4 }}>{sublabel}</div>
        )}
      </div>
    </div>
  );
};

export const EventFlow: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Column positions
  const col1 = 140; // Sources
  const col2 = 720; // Daemon
  const col3 = 1300; // Workers

  const sourceWidth = 180;
  const daemonWidth = 240;
  const workerWidth = 200;

  // Title
  const titleOpacity = interpolate(frame, [0, 0.3 * fps], [0, 1], {
    extrapolateRight: "clamp",
  });

  // Column labels
  const labelsOpacity = interpolate(frame, [0.1 * fps, 0.4 * fps], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // Daemon node
  const daemonDelay = 0.3 * fps;

  // Active indicators on daemon
  const activeWorkers = Math.min(Math.floor(Math.max(0, frame - 2.5 * fps) / (fps * 0.5)), 3);

  // Status counters
  const tasksDone = Math.min(Math.floor(Math.max(0, frame - 3.5 * fps) / (fps * 0.4)), 87);
  const tasksRunning = activeWorkers > 0 ? Math.min(activeWorkers, 2) : 0;

  return (
    <AbsoluteFill
      style={{
        backgroundColor: COLORS.bg,
        fontFamily: mono,
      }}
    >
      {/* Title */}
      <div
        style={{
          position: "absolute",
          top: 36,
          left: 0,
          right: 0,
          textAlign: "center",
          opacity: titleOpacity,
        }}
      >
        <span style={{ fontSize: 14, color: COLORS.textDim, letterSpacing: 3 }}>
          EVENT-DRIVEN ARCHITECTURE
        </span>
      </div>

      {/* Column labels */}
      <div style={{ opacity: labelsOpacity }}>
        <div
          style={{
            position: "absolute",
            left: col1,
            top: 72,
            width: sourceWidth,
            textAlign: "center",
            fontSize: 11,
            color: COLORS.textDim,
            letterSpacing: 2,
          }}
        >
          TRIGGERS
        </div>
        <div
          style={{
            position: "absolute",
            left: col2,
            top: 72,
            width: daemonWidth,
            textAlign: "center",
            fontSize: 11,
            color: COLORS.textDim,
            letterSpacing: 2,
          }}
        >
          DAEMON
        </div>
        <div
          style={{
            position: "absolute",
            left: col3,
            top: 72,
            width: workerWidth,
            textAlign: "center",
            fontSize: 11,
            color: COLORS.textDim,
            letterSpacing: 2,
          }}
        >
          WORKERS
        </div>
      </div>

      {/* Source nodes */}
      {SOURCES.map((src, i) => (
        <NodeBox
          key={`src-${i}`}
          x={col1}
          y={src.y}
          width={sourceWidth}
          label={src.label}
          sublabel={src.sublabel}
          borderColor={COLORS.border}
          frame={frame}
          fps={fps}
          delay={0.2 * fps + i * 0.2 * fps}
        />
      ))}

      {/* Daemon central node */}
      <div
        style={{
          position: "absolute",
          left: col2,
          top: 200,
          width: daemonWidth,
          opacity: interpolate(frame, [daemonDelay, daemonDelay + 0.3 * fps], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          }),
          transform: `scale(${spring({ frame, fps, delay: daemonDelay, config: { damping: 200 } })})`,
          transformOrigin: "center center",
        }}
      >
        <div
          style={{
            backgroundColor: COLORS.panel,
            border: `1px solid ${COLORS.accent}55`,
            borderRadius: 12,
            padding: "24px 20px",
            textAlign: "center",
            boxShadow: `0 0 40px ${COLORS.accent}11`,
          }}
        >
          <div style={{ fontSize: 18, color: COLORS.text, fontWeight: 700 }}>kraken</div>
          <div style={{ fontSize: 12, color: COLORS.accent, marginTop: 4 }}>:50051</div>
          <div style={{ height: 1, backgroundColor: COLORS.border, margin: "14px 0" }} />
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
            <span style={{ color: COLORS.textDim }}>running</span>
            <span style={{ color: COLORS.green }}>{tasksRunning}w</span>
          </div>
          <div
            style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginTop: 6 }}
          >
            <span style={{ color: COLORS.textDim }}>completed</span>
            <span style={{ color: COLORS.textMuted }}>{tasksDone}</span>
          </div>

          {/* Activity indicator */}
          <div
            style={{
              marginTop: 14,
              height: 3,
              backgroundColor: COLORS.element,
              borderRadius: 2,
              overflow: "hidden",
            }}
          >
            <div
              style={{
                height: "100%",
                width: `${Math.min(100, (frame / (4 * fps)) * 100)}%`,
                backgroundColor: COLORS.accent,
                borderRadius: 2,
                opacity: 0.6,
              }}
            />
          </div>
        </div>

        {/* Second daemon box: orchestrator detail */}
        <div
          style={{
            marginTop: 16,
            backgroundColor: COLORS.element,
            border: `1px solid ${COLORS.border}`,
            borderRadius: 8,
            padding: "12px 16px",
            fontSize: 12,
            opacity: interpolate(frame, [1.5 * fps, 1.8 * fps], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            }),
          }}
        >
          <div style={{ color: COLORS.textMuted, marginBottom: 6 }}>queue</div>
          <div style={{ color: COLORS.textDim }}>priority sort . FIFO . max 4w</div>
        </div>
      </div>

      {/* Worker nodes */}
      {WORKERS.map((worker, i) => (
        <NodeBox
          key={`wrk-${i}`}
          x={col3}
          y={worker.y}
          width={workerWidth}
          label={`worker-${i + 1}`}
          sublabel={worker.label}
          borderColor={worker.status === "done" ? COLORS.green + "55" : COLORS.cyan + "44"}
          frame={frame}
          fps={fps}
          delay={2.0 * fps + i * 0.4 * fps}
        />
      ))}

      {/* Flow lines: sources → daemon */}
      {SOURCES.map((src, i) => {
        const srcCenterX = col1 + sourceWidth;
        const srcCenterY = src.y + 25;
        const daemonLeftX = col2;
        const daemonCenterY = 320;

        return (
          <FlowLine
            key={`line-s-${i}`}
            fromX={srcCenterX}
            fromY={srcCenterY}
            toX={daemonLeftX}
            toY={daemonCenterY}
            frame={frame}
            fps={fps}
            delay={0.8 * fps + i * 0.15 * fps}
            active={i < 3}
          />
        );
      })}

      {/* Flow lines: daemon → workers */}
      {WORKERS.map((worker, i) => {
        const daemonRightX = col2 + daemonWidth;
        const daemonCenterY = 320;
        const workerLeftX = col3;
        const workerCenterY = worker.y + 25;

        return (
          <FlowLine
            key={`line-w-${i}`}
            fromX={daemonRightX}
            fromY={daemonCenterY}
            toX={workerLeftX}
            toY={workerCenterY}
            frame={frame}
            fps={fps}
            delay={1.8 * fps + i * 0.3 * fps}
            active={worker.status === "running"}
          />
        );
      })}

      {/* Status indicator dots on workers */}
      {WORKERS.map((worker, i) => {
        const dotDelay = 3.2 * fps + i * 0.5 * fps;
        const dotOpacity = interpolate(frame, [dotDelay, dotDelay + 0.2 * fps], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });

        const isDone = worker.status === "done" && frame > dotDelay + 1.0 * fps;
        const pulseOpacity = isDone
          ? 1
          : interpolate(frame % fps, [0, fps / 2, fps], [0.3, 1, 0.3]);

        return (
          <div
            key={`dot-${i}`}
            style={{
              position: "absolute",
              left: col3 + workerWidth + 16,
              top: worker.y + 22,
              width: 8,
              height: 8,
              borderRadius: "50%",
              backgroundColor: isDone ? COLORS.green : COLORS.cyan,
              opacity: dotOpacity * pulseOpacity,
              boxShadow: isDone ? `0 0 8px ${COLORS.green}` : `0 0 8px ${COLORS.cyan}`,
            }}
          />
        );
      })}
    </AbsoluteFill>
  );
};
