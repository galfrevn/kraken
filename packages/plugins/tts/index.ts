import { definePlugin } from "@kraken/sdk";
import type { Tool, ToolResult } from "@kraken/sdk";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";

const IS_WINDOWS = process.platform === "win32";
const IS_MAC = process.platform === "darwin";

const AUDIO_DIR = resolve(homedir(), ".kraken", "audio");

function escapeForShell(text: string): string {
  if (IS_WINDOWS) {
    // Escape single quotes for PowerShell by doubling them
    return text.replace(/'/g, "''");
  }
  // Escape single quotes for sh by ending quote, adding escaped quote, resuming quote
  return text.replace(/'/g, "'\\''");
}

async function findLinuxTtsCommand(): Promise<"espeak" | "spd-say" | null> {
  for (const cmd of ["espeak", "spd-say"] as const) {
    try {
      const proc = Bun.spawn(["which", cmd], { stdout: "pipe", stderr: "pipe" });
      const exitCode = await proc.exited;
      if (exitCode === 0) return cmd;
    } catch {
      // not found, try next
    }
  }
  return null;
}

async function runCommand(cmd: string[], cwd?: string): Promise<ToolResult> {
  try {
    const spawnedProcess = Bun.spawn(cmd, {
      stdout: "pipe",
      stderr: "pipe",
      cwd,
    });

    const exitCode = await spawnedProcess.exited;
    const stdout = await new Response(spawnedProcess.stdout).text();
    const stderr = await new Response(spawnedProcess.stderr).text();

    if (exitCode !== 0) {
      const errorOutput = stderr.trim() || stdout.trim() || `Command exited with code ${exitCode}`;
      return { success: false, output: errorOutput };
    }

    return { success: true, output: stdout.trim() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, output: `Command failed: ${message}` };
  }
}

// ---------------------------------------------------------------------------
// Tool: tts_speak
// ---------------------------------------------------------------------------
const ttsSpeakTool: Tool = {
  definition: {
    name: "tts_speak",
    description:
      "Speak text aloud using the system's native text-to-speech engine. " +
      "Works cross-platform: Windows (System.Speech), macOS (say), Linux (espeak/spd-say).",
    parameters: [
      { name: "text", type: "string", description: "The text to speak aloud.", required: true },
      {
        name: "rate",
        type: "number",
        description: "Speech rate in words per minute. Optional. Windows: mapped to -10..10 range. macOS: passed directly to say -r. Linux/espeak: passed as -s value.",
        required: false,
      },
    ],
  },
  async execute(parameters): Promise<ToolResult> {
    const text = parameters["text"] as string;
    if (!text) return { success: false, output: "text parameter is required" };

    const rate = parameters["rate"] as number | undefined;
    const escaped = escapeForShell(text);

    if (IS_WINDOWS) {
      // Map WPM to SpeechSynthesizer Rate property (-10 to 10). 150 WPM is roughly "normal" (Rate 0).
      let rateSnippet = "";
      if (rate !== undefined) {
        const mapped = Math.max(-10, Math.min(10, Math.round((rate - 150) / 15)));
        rateSnippet = `$synth.Rate = ${mapped}; `;
      }
      const psScript = `Add-Type -AssemblyName System.Speech; $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer; ${rateSnippet}$synth.Speak('${escaped}')`;
      return runCommand(["powershell", "-NoProfile", "-Command", psScript]);
    }

    if (IS_MAC) {
      const args = ["say"];
      if (rate !== undefined) args.push("-r", String(rate));
      args.push(escaped);
      return runCommand(args);
    }

    // Linux
    const linuxCmd = await findLinuxTtsCommand();
    if (!linuxCmd) {
      return {
        success: false,
        output: "No TTS engine found. Install espeak (apt install espeak) or spd-say (apt install speech-dispatcher).",
      };
    }

    if (linuxCmd === "espeak") {
      const args = ["espeak"];
      if (rate !== undefined) args.push("-s", String(rate));
      args.push(escaped);
      return runCommand(args);
    }

    // spd-say does not support rate in WPM directly, but accepts -r (percentage, -100 to 100)
    const args = ["spd-say"];
    if (rate !== undefined) {
      const mapped = Math.max(-100, Math.min(100, Math.round(((rate - 150) / 150) * 100)));
      args.push("-r", String(mapped));
    }
    args.push(escaped);
    return runCommand(args);
  },
};

// ---------------------------------------------------------------------------
// Tool: tts_save
// ---------------------------------------------------------------------------
const ttsSaveTool: Tool = {
  definition: {
    name: "tts_save",
    description:
      "Save spoken text to an audio file using the system's native TTS. " +
      "Files are saved in ~/.kraken/audio/ by default. " +
      "Windows: WAV, macOS: AIFF, Linux: WAV.",
    parameters: [
      { name: "text", type: "string", description: "The text to convert to audio.", required: true },
      {
        name: "filename",
        type: "string",
        description: "Output filename (saved in ~/.kraken/audio/). Defaults to tts-<timestamp>.wav (.aiff on macOS).",
        required: false,
      },
    ],
  },
  async execute(parameters): Promise<ToolResult> {
    const text = parameters["text"] as string;
    if (!text) return { success: false, output: "text parameter is required" };

    mkdirSync(AUDIO_DIR, { recursive: true });

    const escaped = escapeForShell(text);
    const timestamp = Date.now();

    if (IS_WINDOWS) {
      const filename = (parameters["filename"] as string) ?? `tts-${timestamp}.wav`;
      const outputPath = resolve(AUDIO_DIR, filename);
      const psScript =
        `Add-Type -AssemblyName System.Speech; ` +
        `$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer; ` +
        `$synth.SetOutputToWaveFile('${outputPath.replace(/'/g, "''")}'); ` +
        `$synth.Speak('${escaped}'); ` +
        `$synth.Dispose()`;
      const result = await runCommand(["powershell", "-NoProfile", "-Command", psScript]);
      if (result.success) {
        return { success: true, output: `Audio saved to ${outputPath}` };
      }
      return result;
    }

    if (IS_MAC) {
      const filename = (parameters["filename"] as string) ?? `tts-${timestamp}.aiff`;
      const outputPath = resolve(AUDIO_DIR, filename);
      const result = await runCommand(["say", "-o", outputPath, escaped]);
      if (result.success) {
        return { success: true, output: `Audio saved to ${outputPath}` };
      }
      return result;
    }

    // Linux
    const linuxCmd = await findLinuxTtsCommand();
    if (!linuxCmd) {
      return {
        success: false,
        output: "No TTS engine found. Install espeak (apt install espeak) or spd-say (apt install speech-dispatcher).",
      };
    }

    if (linuxCmd === "espeak") {
      const filename = (parameters["filename"] as string) ?? `tts-${timestamp}.wav`;
      const outputPath = resolve(AUDIO_DIR, filename);
      const result = await runCommand(["espeak", "-w", outputPath, escaped]);
      if (result.success) {
        return { success: true, output: `Audio saved to ${outputPath}` };
      }
      return result;
    }

    // spd-say does not support file output
    return {
      success: false,
      output: "spd-say does not support saving to file. Install espeak for file output: apt install espeak",
    };
  },
};

// ---------------------------------------------------------------------------
// Tool: tts_voices
// ---------------------------------------------------------------------------
const ttsVoicesTool: Tool = {
  definition: {
    name: "tts_voices",
    description: "List available text-to-speech voices on the system.",
    parameters: [],
  },
  async execute(): Promise<ToolResult> {
    if (IS_WINDOWS) {
      const psScript =
        `Add-Type -AssemblyName System.Speech; ` +
        `$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer; ` +
        `$synth.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name + ' (' + $_.VoiceInfo.Culture.Name + ')' }`;
      return runCommand(["powershell", "-NoProfile", "-Command", psScript]);
    }

    if (IS_MAC) {
      return runCommand(["say", "-v", "?"]);
    }

    // Linux
    const linuxCmd = await findLinuxTtsCommand();
    if (!linuxCmd) {
      return {
        success: false,
        output: "No TTS engine found. Install espeak (apt install espeak) or spd-say (apt install speech-dispatcher).",
      };
    }

    if (linuxCmd === "espeak") {
      return runCommand(["espeak", "--voices"]);
    }

    // spd-say: list via spd-say -L (output modules) — limited voice listing
    return runCommand(["spd-say", "-L"]);
  },
};

// ---------------------------------------------------------------------------
// Plugin export
// ---------------------------------------------------------------------------
export default definePlugin({
  name: "tts",
  version: "0.1.0",
  description:
    "Text-to-speech plugin using the operating system's native TTS engine. " +
    "Speak text aloud, save audio files, and list available voices. No external API required.",
  author: "kraken",

  toolDisplayNames: {
    tts_speak: "Speak Text",
    tts_save: "Save Audio",
    tts_voices: "List Voices",
  },

  tools: [ttsSpeakTool, ttsSaveTool, ttsVoicesTool],

  promptExtension:
    "You have text-to-speech tools from the 'tts' plugin. These use the system's native TTS engine " +
    "(Windows: System.Speech, macOS: say, Linux: espeak/spd-say) — no external API key is needed.\n" +
    "Use tts_speak to read text aloud, tts_save to export speech to an audio file (~/.kraken/audio/), " +
    "and tts_voices to list available voices on the current system.\n" +
    "The optional rate parameter controls speech speed in words per minute (default ~150 WPM).",

  activate: async () => {
    if (IS_WINDOWS) {
      console.log("[tts] activated (Windows System.Speech)");
    } else if (IS_MAC) {
      console.log("[tts] activated (macOS say)");
    } else {
      const cmd = await findLinuxTtsCommand();
      if (cmd) {
        console.log(`[tts] activated (Linux ${cmd})`);
      } else {
        console.log("[tts] WARNING: No TTS engine found. Install espeak or speech-dispatcher.");
      }
    }
  },

  deactivate: async () => {
    console.log("[tts] deactivated");
  },
});
