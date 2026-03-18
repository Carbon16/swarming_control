# swarming_control

Express + FFmpeg MJPEG streaming server for a Raspberry Pi camera, with timelapse setup and preview.

## Requirements

- Raspberry Pi with a camera (USB or CSI, exposed as `/dev/video0`)
- FFmpeg installed (`sudo apt-get install ffmpeg`)
- **Bun** (Pi 4+, ARMv8) or **Node.js** (all architectures)

## From executable
You can also run the server without installing Bun or Node by downloading the latest release from the [Releases](https://github.com/carbon16/swarming_control/releases).

```bash
chmod +x swarming_control
FFMPEG_PATH=ffmpeg CAMERA_DEVICE=/dev/video0 PORT=3000 ./swarming_control
```
### Architectures
- `swarming_control-arm64`: For Raspberry Pi 4 and later (ARMv8)

You can check your Pi's architecture with `uname -m`:
- `aarch64` = ARMv8 (use `swarming_control-arm64`)
- `armv7l` = ARMv7 (32-bit) and `armv6l` = ARMv6 (Pi Zero/Zero W): Bun compile targets do not support these. Run with Bun/Node on-device instead (see below).


## With bun (ARMv8 / Pi 4+)

### Install

```bash
curl -fsSL https://bun.sh/install | bash
cd ~/swarming_control
bun install
```

### Run

```bash
FFMPEG_PATH=ffmpeg CAMERA_DEVICE=/dev/video0 PORT=3000 bun run index.ts
```

## With Node.js (all architectures / ARMv6, ARMv7, ARMv8)

For older Pi models (ARMv6/ARMv7), use Node.js with `tsx` (TypeScript executor):

### Install

```bash
sudo apt-get update
sudo apt-get install -y nodejs npm
cd ~/swarming_control
npm install
npx tsx index.ts  # First run (installs tsx)
```

### Run (subsequent times)

```bash
FFMPEG_PATH=ffmpeg CAMERA_DEVICE=/dev/video0 PORT=3000 npx tsx index.ts
```

Or pre-compile to JavaScript:

```bash
npx tsc
FFMPEG_PATH=ffmpeg CAMERA_DEVICE=/dev/video0 PORT=3000 node dist/index.js
```

### Build for Raspberry Pi (binary)

Build on any machine and copy the binary to the Pi:

```bash
bun run build:pi:arm64
```

Outputs:

- `dist/swarming_control-arm64`

For ARMv7/ARMv6 Pis (older models), compile on your desktop and copy the binary, or run with Bun/Node on-device directly.

## Optional hotspot setup

If you want the Pi to start a Wi-Fi hotspot before launching the server, pass `--hotspot`:

```bash
FFMPEG_PATH=ffmpeg CAMERA_DEVICE=/dev/video0 PORT=3000 bun run index.ts --hotspot
```

This runs:

```bash
sudo nmcli con add type wifi ifname wlan0 con-name Hotspot autoconnect yes ssid PiGallery mode ap ipv4.method shared
sudo nmcli con up Hotspot
```

Open `http://<pi-ip>:3000` in your browser.

## Environment variables

- `FFMPEG_PATH`: Path to the ffmpeg binary (default: `ffmpeg`)
- `CAMERA_DEVICE`: V4L2 device (default: `/dev/video0`)
- `STREAM_MODE`: `v4l2` (default, USB cameras) or `rpicam` (CSI cameras via `rpicam-vid`)
- `PORT`: HTTP port (default: `3000`)
- `TIMELAPSE_DIR`: Where timelapse images and videos are stored (default: `/home/pi/timelapse`)
- `CRON_SCHEDULE`: Cron schedule for captures (default: `*/5 * * * *`)
- `CAPTURE_COMMAND`: Custom capture command (default uses `rpicam-still`)
- `FFMPEG_LOG`: Set to `1` to print ffmpeg stderr output

For CSI cameras (like IMX708) where `rpicam-still` works but live stream is blank, start with:

```bash
STREAM_MODE=rpicam PORT=3000 node dist/index.js
```

## Timelapse workflow

1. Open the page and position the camera using the live preview.
2. Click "Setup Timelapse" to install the cron job that captures a frame every 5 minutes.
3. Click "Preview Timelapse" to build a low-res preview from existing frames.
4. Click "Create Full Timelapse" at the end to render the full resolution video.

This project was created using `bun init` in bun v1.3.8. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
