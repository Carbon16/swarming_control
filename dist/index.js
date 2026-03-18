import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import express from "express";
const app = express();
const port = Number(process.env.PORT ?? 3000);
const ffmpegPath = process.env.FFMPEG_PATH ?? "ffmpeg";
const cameraDevice = process.env.CAMERA_DEVICE ?? "/dev/video0";
const timelapseDir = process.env.TIMELAPSE_DIR ?? "/home/pi/timelapse";
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
app.get("/", (req, res) => {
    res.type("html").send(`<!doctype html>
<html>
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		<title>Raspberry Pi Camera Stream</title>
		<style>
			body { font-family: Arial, sans-serif; margin: 24px; background: #0f1115; color: #e6e6e6; }
			.frame { max-width: 820px; margin: 0 auto; }
			img { width: 100%; height: auto; border-radius: 8px; border: 1px solid #2d313a; }
			.hint { opacity: 0.7; font-size: 14px; margin-top: 12px; }
		</style>
	</head>
	<body>
		<div class="frame">
			<h1>Camera Stream</h1>
			<img src="/stream.mjpg" alt="Live stream" />
			<div style="margin-top: 14px; display: flex; gap: 8px; flex-wrap: wrap; align-items: center;">
				<label for="runName">Run name:</label>
				<input id="runName" placeholder="e.g. sunrise_day1" />
			</div>
			<div style="margin-top: 18px; display: flex; gap: 12px; flex-wrap: wrap;">
				<button id="setup">Setup Timelapse (every 5 min)</button>
				<button id="preview">Preview Timelapse</button>
				<button id="finalize">Create Full Timelapse</button>
			</div>
			<div class="hint" id="status">Ready.</div>
			<div style="margin-top: 12px; display: flex; gap: 12px; flex-wrap: wrap;">
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
    const ffmpeg = spawn(ffmpegPath, ffmpegArgs, {
        stdio: ["ignore", "pipe", "pipe"],
    });
    let closed = false;
    const cleanup = () => {
        if (closed)
            return;
        closed = true;
        ffmpeg.kill("SIGINT");
    };
    req.on("close", cleanup);
    res.on("close", cleanup);
    ffmpeg.stdout.on("data", (chunk) => {
        if (closed)
            return;
        res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${chunk.length}\r\n\r\n`);
        res.write(chunk);
        res.write("\r\n");
    });
    ffmpeg.stderr.on("data", (chunk) => {
        if (process.env.FFMPEG_LOG === "1") {
            console.error(chunk.toString());
        }
    });
    ffmpeg.on("close", () => {
        cleanup();
        if (!res.headersSent) {
            res.status(500).end("FFmpeg exited");
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
        await Promise.race([
            Promise.all([
                runCommand("sudo", [
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
                ]),
                runCommand("sudo", ["nmcli", "con", "up", "Hotspot"]),
            ]),
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
        const ffmpeg = spawn(ffmpegPath, ["-version"], {
            stdio: ["ignore", "pipe", "pipe"],
        });
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error("FFmpeg check timeout")), 5000);
            ffmpeg.on("close", (code) => {
                clearTimeout(timeout);
                if (code === 0)
                    resolve();
                else
                    reject(new Error(`FFmpeg returned code ${code}`));
            });
            ffmpeg.on("error", reject);
        });
        res.status(200).json({ ok: true, status: "healthy" });
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
        await installCron(runName);
        const { captureScriptPath } = getRunPaths(runName);
        let captureWarning = null;
        try {
            // Capture one frame immediately so a brand-new run has content for preview.
            await runCommand("bash", [captureScriptPath]);
        }
        catch (error) {
            const raw = error instanceof Error ? error.message : String(error);
            const short = raw.length > 220 ? `${raw.slice(0, 220)}...` : raw;
            captureWarning = `Cron installed, but immediate capture failed: ${short}`;
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
