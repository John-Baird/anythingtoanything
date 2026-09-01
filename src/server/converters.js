const path = require("path");
const fs = require("fs/promises");
const { spawn } = require("child_process");
const sharp = require("sharp");
const ffmpegPath = require("ffmpeg-static");

// ---------------------------------------------------------------------------
// Format registries
// ---------------------------------------------------------------------------

// Images sharp can read.
const IMAGE_INPUT_EXTENSIONS = ["jpg", "jpeg", "png", "webp", "gif", "tiff", "tif", "avif", "svg"];

// Image targets, in display order. `sharp` is the method name passed to toFormat().
const IMAGE_TARGETS = {
	png: { sharp: "png", mime: "image/png", ext: "png" },
	jpg: { sharp: "jpeg", mime: "image/jpeg", ext: "jpg" },
	webp: { sharp: "webp", mime: "image/webp", ext: "webp" },
	avif: { sharp: "avif", mime: "image/avif", ext: "avif" },
	gif: { sharp: "gif", mime: "image/gif", ext: "gif" },
	tiff: { sharp: "tiff", mime: "image/tiff", ext: "tiff" },
};

// Audio ffmpeg can read.
const AUDIO_INPUT_EXTENSIONS = ["mp3", "wav", "flac", "ogg", "oga", "opus", "m4a", "aac", "wma", "aiff", "aif"];

// Audio targets. `args` are the ffmpeg output options.
const AUDIO_TARGETS = {
	mp3: { mime: "audio/mpeg", ext: "mp3", args: ["-codec:a", "libmp3lame", "-q:a", "2"] },
	wav: { mime: "audio/wav", ext: "wav", args: ["-codec:a", "pcm_s16le"] },
	flac: { mime: "audio/flac", ext: "flac", args: ["-codec:a", "flac"] },
	ogg: { mime: "audio/ogg", ext: "ogg", args: ["-codec:a", "libvorbis", "-q:a", "5"] },
	opus: { mime: "audio/opus", ext: "opus", args: ["-codec:a", "libopus", "-b:a", "128k"] },
	m4a: { mime: "audio/mp4", ext: "m4a", args: ["-codec:a", "aac", "-b:a", "192k"] },
};

// Video ffmpeg can read.
const VIDEO_INPUT_EXTENSIONS = ["mp4", "mov", "webm", "mkv", "avi", "m4v", "flv", "wmv"];

// Video targets. "mp3" here means "extract the audio track"; "gif" means "make a
// short looping gif".
const VIDEO_TARGETS = {
	mp4: {
		mime: "video/mp4",
		ext: "mp4",
		args: ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-c:a", "aac", "-movflags", "+faststart"],
	},
	webm: {
		mime: "video/webm",
		ext: "webm",
		args: ["-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "34", "-c:a", "libopus"],
	},
	mov: {
		mime: "video/quicktime",
		ext: "mov",
		args: ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-c:a", "aac"],
	},
	gif: {
		mime: "image/gif",
		ext: "gif",
		args: ["-vf", "fps=12,scale=480:-1:flags=lanczos", "-loop", "0"],
	},
	mp3: {
		mime: "audio/mpeg",
		ext: "mp3",
		args: ["-vn", "-codec:a", "libmp3lame", "-q:a", "2"],
	},
};

const IMAGE_ORDER = Object.keys(IMAGE_TARGETS);
const AUDIO_ORDER = Object.keys(AUDIO_TARGETS);
const VIDEO_ORDER = Object.keys(VIDEO_TARGETS);

const AUDIO_TIMEOUT_MS = 60_000;
const VIDEO_TIMEOUT_MS = 5 * 60_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fileExtension(name) {
	const match = String(name).toLowerCase().match(/\.([^.]+)$/);
	return match ? match[1] : "";
}

function normalizeImage(ext) {
	if (ext === "jpeg") return "jpg";
	if (ext === "tif") return "tiff";
	return ext;
}

function normalizeAudio(ext) {
	if (ext === "oga") return "ogg";
	if (ext === "aac") return "m4a";
	if (ext === "aif") return "aiff";
	return ext;
}

function normalizeVideo(ext) {
	if (ext === "m4v") return "mp4";
	return ext;
}

class ConversionError extends Error {
	constructor(message, status = 400, detail) {
		super(message);
		this.status = status;
		this.detail = detail;
	}
}

function inputKind(ext) {
	if (IMAGE_INPUT_EXTENSIONS.includes(ext)) return "image";
	if (AUDIO_INPUT_EXTENSIONS.includes(ext)) return "audio";
	if (VIDEO_INPUT_EXTENSIONS.includes(ext)) return "video";
	return "unsupported";
}

// Parse an ffmpeg timestamp like "00:01:23.45" into seconds.
function hmsToSeconds(h, m, s) {
	return Number(h) * 3600 + Number(m) * 60 + parseFloat(s);
}

// ---------------------------------------------------------------------------
// ffmpeg runner (streams progress from stderr)
// ---------------------------------------------------------------------------

function runFfmpeg(inputPath, outputPath, args, timeoutMs, onProgress) {
	return new Promise((resolve, reject) => {
		const proc = spawn(ffmpegPath, ["-y", "-hide_banner", "-i", inputPath, ...args, outputPath]);

		let durationSec = 0;
		let stderrTail = "";
		let timedOut = false;

		const killTimer = setTimeout(() => {
			timedOut = true;
			proc.kill("SIGKILL");
		}, timeoutMs);

		proc.stderr.on("data", (chunk) => {
			const text = chunk.toString();
			stderrTail = (stderrTail + text).slice(-4000);

			const durationMatch = text.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
			if (durationMatch) {
				durationSec = hmsToSeconds(durationMatch[1], durationMatch[2], durationMatch[3]);
			}

			const timeMatch = text.match(/time=\s*(\d+):(\d+):(\d+\.\d+)/);
			if (timeMatch && durationSec > 0) {
				const done = hmsToSeconds(timeMatch[1], timeMatch[2], timeMatch[3]);
				onProgress(Math.max(0, Math.min(0.99, done / durationSec)));
			}
		});

		proc.on("error", (err) => {
			clearTimeout(killTimer);
			reject(err);
		});

		proc.on("close", (code) => {
			clearTimeout(killTimer);

			if (timedOut) {
				return reject(new ConversionError("Conversion timed out — file is too large or too long", 504));
			}
			if (code !== 0) {
				return reject(new ConversionError("Conversion failed", 422, stderrTail.slice(-500)));
			}

			onProgress(1);
			resolve();
		});
	});
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// Which target formats can this filename convert to?
function targetsFor(filename) {
	const ext = fileExtension(filename);
	const kind = inputKind(ext);

	if (kind === "image") {
		return { kind, targets: IMAGE_ORDER.filter((t) => t !== normalizeImage(ext)) };
	}
	if (kind === "audio") {
		return { kind, targets: AUDIO_ORDER.filter((t) => t !== normalizeAudio(ext)) };
	}
	if (kind === "video") {
		return { kind, targets: VIDEO_ORDER.filter((t) => t !== normalizeVideo(ext)) };
	}
	return { kind: "unsupported", targets: [] };
}

// Convert the file at inputPath to `format`. Writes a sibling temp file and
// returns { outputPath, mime, ext, downloadName }.
async function convert({ inputPath, filename, format, onProgress = () => {} }) {
	const target = String(format || "").toLowerCase();
	const kind = inputKind(fileExtension(filename));

	const registry =
		kind === "image" ? IMAGE_TARGETS : kind === "audio" ? AUDIO_TARGETS : kind === "video" ? VIDEO_TARGETS : null;

	const spec = registry && registry[target];
	if (!spec) {
		throw new ConversionError(`Unsupported target format: ${target || "(none)"}`);
	}

	const outputPath = `${inputPath}.out.${spec.ext}`;

	if (kind === "image") {
		try {
			await sharp(inputPath).metadata();
		} catch {
			throw new ConversionError("File is not a readable image");
		}
		await sharp(inputPath).toFormat(spec.sharp).toFile(outputPath);
		onProgress(1);
	} else {
		const timeout = kind === "video" ? VIDEO_TIMEOUT_MS : AUDIO_TIMEOUT_MS;
		try {
			await runFfmpeg(inputPath, outputPath, spec.args, timeout, onProgress);
		} catch (err) {
			await fs.rm(outputPath, { force: true }).catch(() => {});
			throw err;
		}
	}

	const base = filename.replace(/\.[^.]+$/, "") || "converted";
	return { outputPath, mime: spec.mime, ext: spec.ext, downloadName: `${base}.${spec.ext}` };
}

module.exports = { targetsFor, convert, ConversionError };
