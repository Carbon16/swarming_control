import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import express from "express";
const app = express();
const port = Number(process.env.PORT ?? 3000);
const ffmpegPath = process.env.FFMPEG_PATH ?? "ffmpeg";
const cameraDevice = process.env.CAMERA_DEVICE ?? "/dev/video0";
const streamMode = (process.env.STREAM_MODE ?? "v4l2").toLowerCase();
const defaultTimelapseDir = process.env.HOME
    ? path.join(process.env.HOME, "timelapse")
    : "/tmp/timelapse";
const timelapseDir = process.env.TIMELAPSE_DIR ?? defaultTimelapseDir;
const cronSchedule = process.env.CRON_SCHEDULE ?? "*/5 * * * *";
const captureCommandTemplate = process.env.CAPTURE_COMMAND ??
    "rpicam-still -o \"$RUN_DIR/$DATE.jpg\"";
const cronMarker = "# timelapse-capture";
const lowSpaceThresholdBytes = 7 * 1024 * 1024 * 1024;
const shouldEnableHotspot = process.argv.includes("--hotspot");
app.use(express.json());
const ffmpegArgs = [
    "-f",
    "v4l2",
    "-i",
    cameraDevice,
    "-vf",
    "scale=640:-1",
    "-r",
    "15",
    "-f",
    "mjpeg",
    "pipe:1",
];
const rpicamVidArgs = [
    "--codec",
    "mjpeg",
    "--nopreview",
    "--width",
    "1280",
    "--height",
    "720",
    "--framerate",
    "15",
    "-t",
    "0",
    "-o",
    "-",
];
const findJpegStart = (buffer, startAt = 0) => {
    for (let i = startAt; i < buffer.length - 1; i += 1) {
        if (buffer[i] === 0xff && buffer[i + 1] === 0xd8)
            return i;
    }
    return -1;
};
const findJpegEnd = (buffer, startAt = 0) => {
    for (let i = startAt; i < buffer.length - 1; i += 1) {
        if (buffer[i] === 0xff && buffer[i + 1] === 0xd9)
            return i + 1;
    }
    return -1;
};
const activeStreamers = new Set();
const stopActiveStreams = async () => {
    if (activeStreamers.size === 0)
        return;
    const waiters = Array.from(activeStreamers).map((streamer) => new Promise((resolve) => {
        if (streamer.exitCode !== null) {
            activeStreamers.delete(streamer);
            resolve();
            return;
        }
        const onClose = () => {
            activeStreamers.delete(streamer);
            resolve();
        };
        streamer.once("close", onClose);
        streamer.kill("SIGINT");
        setTimeout(() => {
            if (streamer.exitCode === null)
                streamer.kill("SIGKILL");
        }, 1500);
    }));
    await Promise.race([
        Promise.all(waiters),
        new Promise((resolve) => setTimeout(resolve, 2500)),
    ]);
};
app.get("/", (req, res) => {
    res.type("html").send(`<!doctype html>
<html>
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		<title>Raspberry Pi Camera Stream</title>
		<style>
			:root {
				--bg-1: #0b1217;
				--bg-2: #152630;
				--panel: rgba(18, 32, 40, 0.88);
				--panel-border: #2c4857;
				--text: #e8f1f4;
				--muted: #a9bbc4;
				--accent: #52b788;
				--accent-2: #2d6a4f;
			}

			* { box-sizing: border-box; }
			body {
				font-family: "Segoe UI", "Trebuchet MS", sans-serif;
				margin: 0;
				padding: 24px;
				color: var(--text);
				background:
					radial-gradient(1100px 500px at -10% -20%, #24485a 0%, transparent 55%),
					radial-gradient(900px 420px at 120% -10%, #1f3a48 0%, transparent 58%),
					linear-gradient(165deg, var(--bg-1), var(--bg-2));
			}
			.frame {
				max-width: 900px;
				margin: 0 auto;
				padding: 18px 18px 16px;
				border: 1px solid var(--panel-border);
				border-radius: 14px;
				background: var(--panel);
				box-shadow: 0 10px 28px rgba(0, 0, 0, 0.28);
			}
			h1 {
				margin: 0 0 14px;
				font-size: 1.6rem;
				font-weight: 700;
				letter-spacing: 0.3px;
			}
			img {
				width: 100%;
				height: auto;
				border-radius: 10px;
				border: 1px solid #385665;
				background: #071015;
			}
			.row {
				margin-top: 14px;
				display: flex;
				gap: 10px;
				flex-wrap: wrap;
				align-items: center;
			}
			label {
				font-size: 14px;
				color: var(--muted);
			}
			input {
				background: #0f1f27;
				color: var(--text);
				border: 1px solid #365464;
				border-radius: 8px;
				padding: 9px 10px;
				min-width: 220px;
			}
			button {
				background: linear-gradient(180deg, var(--accent), var(--accent-2));
				color: #f5fff8;
				border: 0;
				border-radius: 8px;
				padding: 10px 13px;
				font-weight: 600;
				cursor: pointer;
			}
			button:hover { filter: brightness(1.06); }
			button:active { transform: translateY(1px); }
			a {
				color: #92ffd0;
				text-underline-offset: 2px;
			}
			a:hover { color: #b4ffe1; }
			.hint {
				opacity: 0.95;
				font-size: 14px;
				margin-top: 12px;
				color: var(--muted);
			}
			#status {
				padding: 8px 10px;
				border-radius: 8px;
				border: 1px solid #355566;
				background: rgba(9, 20, 26, 0.7);
				color: #d6e4ea;
			}
			@media (max-width: 640px) {
				body { padding: 14px; }
				.frame { padding: 14px; }
				input { min-width: 100%; width: 100%; }
				button { width: 100%; }
			}
		</style>
	</head>
	<body>
		<div class="frame">
			<h1>Camera Stream</h1>
			<img id="liveStream" src="/stream.mjpg" alt="Live stream" />
			<div class="row">
				<label for="runName">Run name:</label>
				<input id="runName" placeholder="e.g. sunrise_day1" />
			</div>
			<div class="row" style="margin-top: 18px;">
				<button id="setup">Setup Timelapse (every 5 min)</button>
				<button id="preview">Preview Timelapse</button>
				<button id="finalize">Create Full Timelapse</button>
			</div>
			<div class="hint" id="status">Ready.</div>
			<div class="row" style="margin-top: 12px;">
				<a id="previewLink" href="#" target="_blank">Open preview</a>
				<a id="finalLink" href="#" target="_blank">Open full timelapse</a>
			</div>
			<div class="hint">If the image freezes, refresh this page.</div>
		</div>
		<script>
			const statusEl = document.getElementById("status");
			const runNameEl = document.getElementById("runName");
			const setStatus = (text) => { statusEl.textContent = text; };
			const getRunName = () => runNameEl.value.trim();
			const normalizeRunName = (value) => value
				.trim()
				.toLowerCase()
				.replace(/[^a-z0-9_-]+/g, "-")
				.replace(/-+/g, "-")
				.replace(/^-+|-+$/g, "")
				.substring(0, 60);

			const updateLinks = (runName) => {
				document.getElementById("previewLink").href = "/timelapse/" + runName + "/preview.mp4";
				document.getElementById("finalLink").href = "/timelapse/" + runName + "/timelapse.mp4";
			};

			runNameEl.addEventListener("input", () => {
				const runName = normalizeRunName(getRunName());
				if (!runName) {
					document.getElementById("previewLink").href = "#";
					document.getElementById("finalLink").href = "#";
					return;
				}
				updateLinks(runName);
			});

			document.getElementById("previewLink").addEventListener("click", async (event) => {
				event.preventDefault();
				const rawRunName = getRunName();
				if (!rawRunName) {
					setStatus("Enter a run name first.");
					return;
				}

				setStatus("Creating preview timelapse...");
				const res = await fetch("/preview", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ runName: rawRunName }),
				});

				if (!res.ok) {
					const data = await res.json().catch(() => ({}));
					setStatus(data.error ? "Preview failed: " + data.error : "Preview failed.");
					return;
				}

				const data = await res.json();
				const runName = normalizeRunName(rawRunName);
				updateLinks(runName);
				setStatus("Preview ready.");
				window.open(data.path || ("/timelapse/" + runName + "/preview.mp4"), "_blank", "noopener");
			});

			document.getElementById("finalLink").addEventListener("click", (event) => {
				const runName = normalizeRunName(getRunName());
				if (!runName) {
					event.preventDefault();
					setStatus("Enter a run name first.");
					return;
				}
				updateLinks(runName);
			});

			fetch("/status").then(async (res) => {
				if (!res.ok) return;
				const data = await res.json();
				if (data.warning) {
					setStatus(data.warning);
				}
			});

			document.getElementById("setup").addEventListener("click", async () => {
				const runName = getRunName();
				if (!runName) {
					setStatus("Please enter a run name first.");
					return;
				}
				// Release the camera immediately from the live stream request.
				document.getElementById("liveStream").src = "";
				setStatus("Setting up timelapse...");
				const res = await fetch("/setup", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ runName }),
				});
				if (res.ok) {
					const data = await res.json();
					updateLinks(runName);
					setStatus(data.warning ? data.warning : "Timelapse cron installed.");
				} else {
					const data = await res.json().catch(() => ({}));
					setStatus(data.error ? "Setup failed: " + data.error : "Setup failed.");
				}
			});

			document.getElementById("preview").addEventListener("click", async () => {
				const runName = getRunName();
				if (!runName) {
					setStatus("Please enter a run name first.");
					return;
				}
				setStatus("Creating preview timelapse...");
				const res = await fetch("/preview", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ runName }),
				});
				if (res.ok) {
					updateLinks(runName);
					setStatus("Preview ready.");
				} else {
						const data = await res.json().catch(() => ({}));
						setStatus(data.error ? "Preview failed: " + data.error : "Preview failed.");
				}
			});

			document.getElementById("finalize").addEventListener("click", async () => {
				const runName = getRunName();
				if (!runName) {
					setStatus("Please enter a run name first.");
					return;
				}
				setStatus("Creating full timelapse...");
				const res = await fetch("/finalize", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ runName }),
				});
				if (res.ok) {
					updateLinks(runName);
					setStatus("Full timelapse ready. Cron stopped for this run.");
					const shouldDelete = window.confirm("Delete captured JPGs for this run?");
					if (shouldDelete) {
						const cleanupRes = await fetch("/cleanup", {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({ runName }),
						});
						setStatus(cleanupRes.ok ? "JPGs deleted." : "Failed to delete JPGs.");
					}
				} else {
						const data = await res.json().catch(() => ({}));
						setStatus(data.error ? "Full timelapse failed: " + data.error : "Full timelapse failed.");
				}
			});
		</script>
	</body>
</html>`);
});
app.use("/timelapse", express.static(timelapseDir));
app.get("/timelapse/preview.mp4", (req, res) => {
    const runName = normalizeRunName(String(req.query.runName ?? ""));
    if (!runName) {
        res
            .status(400)
            .send("Preview is run-specific. Use /timelapse/<runName>/preview.mp4 or add ?runName=<runName>.");
        return;
    }
    res.redirect(`/timelapse/${runName}/preview.mp4`);
});
app.get("/timelapse/timelapse.mp4", (req, res) => {
    const runName = normalizeRunName(String(req.query.runName ?? ""));
    if (!runName) {
        res
            .status(400)
            .send("Timelapse is run-specific. Use /timelapse/<runName>/timelapse.mp4 or add ?runName=<runName>.");
        return;
    }
    res.redirect(`/timelapse/${runName}/timelapse.mp4`);
});
app.get("/stream.mjpg", (req, res) => {
    res.writeHead(200, {
        "Content-Type": "multipart/x-mixed-replace; boundary=frame",
        "Cache-Control": "no-cache, no-store, must-revalidate",
        Pragma: "no-cache",
        Expires: "0",
        Connection: "close",
    });
    const streamCommand = streamMode === "rpicam" ? "rpicam-vid" : ffmpegPath;
    const streamArgs = streamMode === "rpicam" ? rpicamVidArgs : ffmpegArgs;
    const streamer = spawn(streamCommand, streamArgs, {
        stdio: ["ignore", "pipe", "pipe"],
    });
    activeStreamers.add(streamer);
    let closed = false;
    let sawFrame = false;
    let jpegBuffer = Buffer.alloc(0);
    let stderr = "";
    const cleanup = () => {
        if (closed)
            return;
        closed = true;
        activeStreamers.delete(streamer);
        streamer.kill("SIGINT");
    };
    req.on("close", cleanup);
    res.on("close", cleanup);
    streamer.stdout.on("data", (chunk) => {
        if (closed)
            return;
        jpegBuffer = Buffer.concat([jpegBuffer, chunk]);
        while (!closed) {
            const start = findJpegStart(jpegBuffer);
            if (start < 0) {
                if (jpegBuffer.length > 1024 * 1024) {
                    jpegBuffer = jpegBuffer.subarray(jpegBuffer.length - 1024 * 1024);
                }
                break;
            }
            const end = findJpegEnd(jpegBuffer, start + 2);
            if (end < 0) {
                if (start > 0)
                    jpegBuffer = jpegBuffer.subarray(start);
                break;
            }
            const frame = jpegBuffer.subarray(start, end + 1);
            jpegBuffer = jpegBuffer.subarray(end + 1);
            sawFrame = true;
            res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`);
            res.write(frame);
            res.write("\r\n");
        }
    });
    streamer.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
        if (process.env.FFMPEG_LOG === "1") {
            console.error(chunk.toString());
        }
    });
    streamer.on("close", (code) => {
        cleanup();
        if (!res.headersSent) {
            const details = stderr.trim();
            if (!sawFrame && details) {
                res.status(500).end(`Stream failed: ${details}`);
                return;
            }
            res.status(500).end(`Stream process exited${code !== null ? ` (${code})` : ""}`);
        }
    });
});
const runCommand = (command, args) => new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
        if (code === 0)
            resolve();
        else {
            const details = stderr.trim();
            reject(new Error(`${command} exited with code ${code}${details ? `: ${details}` : ""}`));
        }
    });
});
const setupHotspot = async () => {
    try {
        const setup = async () => {
            let hotspotExists = true;
            try {
                await runCommand("sudo", ["nmcli", "-t", "-f", "NAME", "con", "show", "Hotspot"]);
            }
            catch {
                hotspotExists = false;
            }
            if (!hotspotExists) {
                await runCommand("sudo", [
                    "nmcli",
                    "con",
                    "add",
                    "type",
                    "wifi",
                    "ifname",
                    "wlan0",
                    "con-name",
                    "Hotspot",
                    "autoconnect",
                    "yes",
                    "ssid",
                    "PiGallery",
                    "mode",
                    "ap",
                    "ipv4.method",
                    "shared",
                ]);
            }
            await runCommand("sudo", ["nmcli", "con", "up", "Hotspot"]);
        };
        await Promise.race([
            setup(),
            new Promise((_, reject) => setTimeout(() => reject(new Error("Hotspot setup timeout (3 min)")), 180000)),
        ]);
    }
    catch (error) {
        console.error("Hotspot setup failed:", error);
    }
};
const normalizeRunName = (value) => value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .substring(0, 60);
const getRunPaths = (runName) => {
    const runDir = path.join(timelapseDir, runName);
    return {
        runDir,
        captureScriptPath: path.join(runDir, "capture.sh"),
        previewPath: path.join(runDir, "preview.mp4"),
        finalPath: path.join(runDir, "timelapse.mp4"),
    };
};
const getFreeBytes = async () => {
    try {
        const df = spawn("df", ["-k", timelapseDir], { stdio: ["ignore", "pipe", "pipe"] });
        const output = await new Promise((resolve, reject) => {
            let data = "";
            df.stdout.on("data", (chunk) => (data += chunk.toString()));
            df.on("error", reject);
            df.on("close", () => resolve(data));
        });
        const lines = output.trim().split("\n");
        if (lines.length < 2)
            return null;
        const parts = lines[1]?.split(/\s+/) || [];
        if (parts.length < 4)
            return null;
        const availableKb = Number(parts[3]);
        return Number.isFinite(availableKb) ? availableKb * 1024 : null;
    }
    catch {
        return null;
    }
};
const installCron = async (runName) => {
    const { runDir, captureScriptPath } = getRunPaths(runName);
    await fs.mkdir(runDir, { recursive: true });
    const command = captureCommandTemplate.replace(/\$RUN_DIR/g, runDir);
    const script = `#!/bin/bash\nDATE=$(date +"%Y-%m-%d_%H%M")\n${command}\n`;
    await fs.writeFile(captureScriptPath, script, { mode: 0o755 });
    let existing = "";
    try {
        const crontabList = spawn("crontab", ["-l"], { stdio: ["ignore", "pipe", "pipe"] });
        existing = await new Promise((resolve, reject) => {
            let data = "";
            crontabList.stdout.on("data", (chunk) => (data += chunk.toString()));
            crontabList.stderr.on("data", (chunk) => {
                const msg = chunk.toString().toLowerCase();
                if (!msg.includes("no crontab")) {
                    reject(new Error(`crontab -l failed: ${msg}`));
                }
            });
            crontabList.on("error", reject);
            crontabList.on("close", (code) => {
                if (code === 0 || code === 1)
                    resolve(data);
                else
                    reject(new Error(`crontab -l exited with code ${code}`));
            });
        });
    }
    catch (error) {
        console.error("Warning: could not read existing crontab:", error);
        existing = "";
    }
    const filtered = existing
        .split("\n")
        .filter((line) => line.trim() && !line.includes(`${cronMarker} ${runName}`));
    filtered.push(`${cronSchedule} ${captureScriptPath} ${cronMarker} ${runName}`);
    const newCrontab = `${filtered.join("\n")}\n`;
    await new Promise((resolve, reject) => {
        const crontabSet = spawn("crontab", ["-"], { stdio: ["pipe", "pipe", "pipe"] });
        let stderr = "";
        crontabSet.stderr.on("data", (chunk) => (stderr += chunk.toString()));
        crontabSet.stdin.write(newCrontab);
        crontabSet.stdin.end();
        crontabSet.on("error", reject);
        crontabSet.on("close", (code) => {
            if (code === 0)
                resolve();
            else
                reject(new Error(`crontab installation failed: ${stderr || `code ${code}`}`));
        });
    });
};
const removeCron = async (runName) => {
    let existing = "";
    try {
        const crontabList = spawn("crontab", ["-l"], { stdio: ["ignore", "pipe", "pipe"] });
        existing = await new Promise((resolve, reject) => {
            let data = "";
            crontabList.stdout.on("data", (chunk) => (data += chunk.toString()));
            crontabList.stderr.on("data", (chunk) => {
                const msg = chunk.toString().toLowerCase();
                if (!msg.includes("no crontab")) {
                    reject(new Error(`crontab -l failed: ${msg}`));
                }
            });
            crontabList.on("error", reject);
            crontabList.on("close", (code) => {
                if (code === 0 || code === 1)
                    resolve(data);
                else
                    reject(new Error(`crontab -l exited with code ${code}`));
            });
        });
    }
    catch (error) {
        console.error("Warning: could not read existing crontab:", error);
        existing = "";
    }
    const filtered = existing
        .split("\n")
        .filter((line) => line.trim() && !line.includes(`${cronMarker} ${runName}`));
    const newCrontab = `${filtered.join("\n")}\n`;
    await new Promise((resolve, reject) => {
        const crontabSet = spawn("crontab", ["-"], { stdio: ["pipe", "pipe", "pipe"] });
        let stderr = "";
        crontabSet.stderr.on("data", (chunk) => (stderr += chunk.toString()));
        crontabSet.stdin.write(newCrontab);
        crontabSet.stdin.end();
        crontabSet.on("error", reject);
        crontabSet.on("close", (code) => {
            if (code === 0)
                resolve();
            else
                reject(new Error(`crontab removal failed: ${stderr || `code ${code}`}`));
        });
    });
};
const deleteJpgs = async (runDir) => {
    let entries = [];
    try {
        entries = await fs.readdir(runDir);
    }
    catch {
        return;
    }
    const deletes = entries
        .filter((entry) => entry.toLowerCase().endsWith(".jpg"))
        .map((entry) => fs.unlink(path.join(runDir, entry)).catch(() => undefined));
    await Promise.all(deletes);
};
const buildTimelapse = async (runDir, outputPath, width) => {
    await fs.mkdir(runDir, { recursive: true });
    const scale = `scale=${width}:-2`;
    const entries = await fs.readdir(runDir);
    const jpgFiles = entries
        .filter((entry) => entry.toLowerCase().endsWith(".jpg"))
        .sort()
        .map((entry) => path.join(runDir, entry));
    if (jpgFiles.length === 0) {
        throw new Error(`No JPG frames found in ${runDir}`);
    }
    const globArgs = [
        "-y",
        "-pattern_type",
        "glob",
        "-framerate",
        "24",
        "-i",
        path.join(runDir, "*.jpg"),
        "-vf",
        scale,
        "-pix_fmt",
        "yuv420p",
        outputPath,
    ];
    try {
        await runCommand(ffmpegPath, globArgs);
        return;
    }
    catch (error) {
        if (process.env.FFMPEG_LOG === "1") {
            console.error("FFmpeg glob mode failed, retrying with concat mode:", error);
        }
    }
    const concatListPath = path.join(runDir, "frames.txt");
    const listBody = jpgFiles
        .map((filePath) => `file '${filePath.replace(/'/g, "'\\''")}'`)
        .join("\n");
    await fs.writeFile(concatListPath, `${listBody}\n`);
    const concatArgs = [
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        concatListPath,
        "-vf",
        scale,
        "-r",
        "24",
        "-pix_fmt",
        "yuv420p",
        outputPath,
    ];
    try {
        await runCommand(ffmpegPath, concatArgs);
    }
    finally {
        await fs.unlink(concatListPath).catch(() => undefined);
    }
};
app.get("/status", async (_req, res) => {
    const freeBytes = await getFreeBytes();
    const warning = freeBytes !== null && freeBytes < lowSpaceThresholdBytes
        ? `Warning: low disk space (${(freeBytes / 1024 / 1024 / 1024).toFixed(1)} GB free).`
        : null;
    res.status(200).json({ ok: true, freeBytes, warning });
});
app.get("/health", async (_req, res) => {
    try {
        const command = streamMode === "rpicam" ? "rpicam-vid" : ffmpegPath;
        const args = streamMode === "rpicam" ? ["--version"] : ["-version"];
        const proc = spawn(command, args, {
            stdio: ["ignore", "pipe", "pipe"],
        });
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error("FFmpeg check timeout")), 5000);
            proc.on("close", (code) => {
                clearTimeout(timeout);
                if (code === 0)
                    resolve();
                else
                    reject(new Error(`${command} returned code ${code}`));
            });
            proc.on("error", reject);
        });
        res.status(200).json({ ok: true, status: "healthy", streamMode, cameraDevice });
    }
    catch (error) {
        res.status(503).json({ ok: false, status: "unhealthy", error: String(error) });
    }
});
app.post("/setup", async (req, res) => {
    try {
        const runName = normalizeRunName(req.body?.runName ?? "");
        if (!runName) {
            res.status(400).json({ ok: false, error: "Run name is required" });
            return;
        }
        await stopActiveStreams();
        await installCron(runName);
        const { captureScriptPath } = getRunPaths(runName);
        let captureWarning = null;
        const shouldTryImmediateCapture = process.env.IMMEDIATE_CAPTURE === "1" || streamMode !== "rpicam";
        if (shouldTryImmediateCapture) {
            try {
                // Capture one frame immediately so a brand-new run has content for preview.
                await runCommand("bash", [captureScriptPath]);
            }
            catch (error) {
                const raw = error instanceof Error ? error.message : String(error);
                const lower = raw.toLowerCase();
                if (lower.includes("resource busy") ||
                    lower.includes("device busy") ||
                    lower.includes("v4l2")) {
                    captureWarning =
                        "Cron installed. Immediate capture skipped because camera is busy (likely live stream in use).";
                }
                else {
                    const short = raw.length > 220 ? `${raw.slice(0, 220)}...` : raw;
                    captureWarning = `Cron installed, but immediate capture failed: ${short}`;
                }
            }
        }
        else {
            captureWarning =
                "Cron installed. First frame will be captured by schedule (immediate capture is disabled in rpicam mode).";
        }
        const freeBytes = await getFreeBytes();
        const diskWarning = freeBytes !== null && freeBytes < lowSpaceThresholdBytes
            ? `Warning: low disk space (${(freeBytes / 1024 / 1024 / 1024).toFixed(1)} GB free).`
            : null;
        const warning = [diskWarning, captureWarning].filter(Boolean).join(" ") || null;
        res.status(200).json({ ok: true, runName, warning });
    }
    catch (error) {
        console.error(error);
        res.status(500).json({ ok: false, error: "Failed to install cron" });
    }
});
app.post("/preview", async (req, res) => {
    try {
        const runName = normalizeRunName(req.body?.runName ?? "");
        if (!runName) {
            res.status(400).json({ ok: false, error: "Run name is required" });
            return;
        }
        const { runDir, previewPath } = getRunPaths(runName);
        await buildTimelapse(runDir, previewPath, 640);
        res.status(200).json({ ok: true, path: `/timelapse/${runName}/preview.mp4` });
    }
    catch (error) {
        console.error(error);
        if (error instanceof Error && error.message.includes("No JPG frames found")) {
            res.status(400).json({ ok: false, error: "No frames found for this run yet. Wait for capture or click Setup again." });
            return;
        }
        res.status(500).json({ ok: false, error: "Failed to build preview" });
    }
});
app.post("/finalize", async (req, res) => {
    try {
        const runName = normalizeRunName(req.body?.runName ?? "");
        if (!runName) {
            res.status(400).json({ ok: false, error: "Run name is required" });
            return;
        }
        const { runDir, finalPath } = getRunPaths(runName);
        await buildTimelapse(runDir, finalPath, 1920);
        await removeCron(runName);
        res.status(200).json({ ok: true, path: `/timelapse/${runName}/timelapse.mp4` });
    }
    catch (error) {
        console.error(error);
        if (error instanceof Error && error.message.includes("No JPG frames found")) {
            res.status(400).json({ ok: false, error: "No frames found for this run yet. Wait for capture or click Setup again." });
            return;
        }
        res.status(500).json({ ok: false, error: "Failed to build timelapse" });
    }
});
app.post("/cleanup", async (req, res) => {
    try {
        const runName = normalizeRunName(req.body?.runName ?? "");
        if (!runName) {
            res.status(400).json({ ok: false, error: "Run name is required" });
            return;
        }
        const { runDir } = getRunPaths(runName);
        await deleteJpgs(runDir);
        res.status(200).json({ ok: true });
    }
    catch (error) {
        console.error(error);
        res.status(500).json({ ok: false, error: "Failed to delete JPGs" });
    }
});
const startServer = async () => {
    if (shouldEnableHotspot) {
        console.log("Enabling hotspot...");
        setupHotspot();
    }
    const server = app.listen(port, () => {
        console.log(`Streaming server listening on http://localhost:${port}`);
        console.log(`Camera device: ${cameraDevice}`);
        console.log(`Timelapse directory: ${timelapseDir}`);
        console.log(`Stream mode: ${streamMode}`);
    });
    const gracefulShutdown = (signal) => {
        console.log(`Received ${signal}, shutting down gracefully...`);
        server.close(() => {
            console.log("Server closed");
            process.exit(0);
        });
        setTimeout(() => {
            console.error("Forced shutdown after 10s");
            process.exit(1);
        }, 10000);
    };
    process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
    process.on("SIGINT", () => gracefulShutdown("SIGINT"));
};
startServer().catch((error) => {
    console.error("Failed to start server:", error);
    process.exitCode = 1;
});
