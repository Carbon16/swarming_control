# swarming_control

Express + FFmpeg MJPEG streaming server for a Raspberry Pi camera, with timelapse setup and preview.

## Requirements

- Raspberry Pi with a camera (USB or CSI, exposed as `/dev/video0`)
- FFmpeg installed (`sudo apt-get install ffmpeg`)
- Bun or Node to run the server

## Install

```bash
bun install
```

## Run

```bash
FFMPEG_PATH=ffmpeg CAMERA_DEVICE=/dev/video0 PORT=3000 bun run index.ts
```

Open `http://<pi-ip>:3000` in your browser.

## Environment variables

- `FFMPEG_PATH`: Path to the ffmpeg binary (default: `ffmpeg`)
- `CAMERA_DEVICE`: V4L2 device (default: `/dev/video0`)
- `PORT`: HTTP port (default: `3000`)
- `TIMELAPSE_DIR`: Where timelapse images and videos are stored (default: `/home/pi/timelapse`)
- `CRON_SCHEDULE`: Cron schedule for captures (default: `*/5 * * * *`)
- `CAPTURE_COMMAND`: Custom capture command (default uses `rpicam-still`)
- `FFMPEG_LOG`: Set to `1` to print ffmpeg stderr output

## Timelapse workflow

1. Open the page and position the camera using the live preview.
2. Click "Setup Timelapse" to install the cron job that captures a frame every 5 minutes.
3. Click "Preview Timelapse" to build a low-res preview from existing frames.
4. Click "Create Full Timelapse" at the end to render the full resolution video.

This project was created using `bun init` in bun v1.3.8. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
