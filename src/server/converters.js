const os = require("os");
const path = require("path");
const crypto = require("crypto");
const fs = require("fs/promises");
const { execFile } = require("child_process");
const { promisify } = require("util");
const sharp = require("sharp");
const ffmpegPath = require("ffmpeg-static");

const execFileAsync = promisify(execFile);

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

// Audio targets, in display order. `args` are the ffmpeg output options.
const AUDIO_TARGETS = {
	mp3: { mime: "audio/mpeg", ext: "mp3", args: ["-codec:a", "libmp3lame", "-q:a", "2"] },
	wav: { mime: "audio/wav", ext: "wav", args: ["-codec:a", "pcm_s16le"] },
	flac: { mime: "audio/flac", ext: "flac", args: ["-codec:a", "flac"] },
	ogg: { mime: "audio/ogg", ext: "ogg", args: ["-codec:a", "libvorbis", "-q:a", "5"] },
	opus: { mime: "audio/opus", ext: "opus", args: ["-codec:a", "libopus", "-b:a", "128k"] },
	m4a: { mime: "audio/mp4", ext: "m4a", args: ["-codec:a", "aac", "-b:a", "192k"] },
};

const IMAGE_ORDER = Object.keys(IMAGE_TARGETS);
const AUDIO_ORDER = Object.keys(AUDIO_TARGETS);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fileExtension(name) {
	const match = String(name).toLowerCase().match(/\.([^.]+)$/);
	return match ? match[1] : "";
}

// Map an input extension to its entry in a target list (so we can hide "convert
// PNG -> PNG").
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

class ConversionError extends Error {
	constructor(message, status = 400, detail) {
		super(message);
		this.status = status;
		this.detail = detail;
	}
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// Which target formats can this filename become?
function targetsFor(filename) {
	const ext = fileExtension(filename);

	if (IMAGE_INPUT_EXTENSIONS.includes(ext)) {
		const current = normalizeImage(ext);
		return { kind: "image", targets: IMAGE_ORDER.filter((t) => t !== current) };
	}

	if (AUDIO_INPUT_EXTENSIONS.includes(ext)) {
		const current = normalizeAudio(ext);
		return { kind: "audio", targets: AUDIO_ORDER.filter((t) => t !== current) };
	}

	return { kind: "unsupported", targets: [] };
}

// Convert a buffer to `format`. Returns { buffer, mime, ext }.
async function convert({ buffer, filename, format }) {
	const target = String(format || "").toLowerCase();
	const inputExt = fileExtension(filename);

	if (IMAGE_TARGETS[target]) {
		return convertImage(buffer, IMAGE_TARGETS[target]);
	}

	if (AUDIO_TARGETS[target]) {
		return convertAudio(buffer, inputExt, AUDIO_TARGETS[target]);
	}

	throw new ConversionError(`Unsupported target format: ${target || "(none)"}`);
}

async function convertImage(buffer, spec) {
	try {
		await sharp(buffer).metadata();
	} catch {
		throw new ConversionError("File is not a readable image");
	}

	const out = await sharp(buffer).toFormat(spec.sharp).toBuffer();
	return { buffer: out, mime: spec.mime, ext: spec.ext };
}

async function convertAudio(buffer, inputExt, spec) {
	const id = crypto.randomUUID();
	const inPath = path.join(os.tmpdir(), `a2a-${id}.${inputExt || "bin"}`);
	const outPath = path.join(os.tmpdir(), `a2a-${id}.${spec.ext}`);

	try {
		await fs.writeFile(inPath, buffer);

		await execFileAsync(
			ffmpegPath,
			["-y", "-hide_banner", "-loglevel", "error", "-i", inPath, ...spec.args, outPath],
			{ timeout: 60_000 },
		);

		const out = await fs.readFile(outPath);
		return { buffer: out, mime: spec.mime, ext: spec.ext };
	} catch (err) {
		if (err.killed) {
			throw new ConversionError("Conversion timed out (file too large or too slow)", 504);
		}
		if (err.stderr !== undefined) {
			throw new ConversionError("Audio conversion failed", 422, String(err.stderr).slice(0, 500));
		}
		throw err;
	} finally {
		await Promise.allSettled([fs.rm(inPath, { force: true }), fs.rm(outPath, { force: true })]);
	}
}

module.exports = { targetsFor, convert, ConversionError };
