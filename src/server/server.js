const express = require("express");
const cors = require("cors");
const path = require("path");
const multer = require("multer");
const sharp = require("sharp");

const app = express();
const PORT = process.env.PORT || 3000;

// Keep uploads in memory as a Buffer (req.file.buffer) — nothing hits disk.
// 25 MB cap, one file per request.
const upload = multer({
	storage: multer.memoryStorage(),
	limits: { fileSize: 25 * 1024 * 1024, files: 1 },
});

app.use(cors());
app.use(express.json());

// Compiled Angular app (produced by `npm run build`).
// __dirname is src/server, so ../../ is the repo root.
const browserDir = path.join(__dirname, "..", "..", "dist", "temp-angular", "browser");

app.use(express.static(browserDir));

// ---------------------------------------------------------------------------
// Image conversion (sharp)
// ---------------------------------------------------------------------------

// Extensions sharp can read.
const IMAGE_INPUT_EXTENSIONS = ["jpg", "jpeg", "png", "webp", "gif", "tiff", "tif", "avif", "svg"];

// target key -> how to emit it
const IMAGE_TARGETS = {
	png: { sharp: "png", mime: "image/png", ext: "png" },
	jpg: { sharp: "jpeg", mime: "image/jpeg", ext: "jpg" },
	jpeg: { sharp: "jpeg", mime: "image/jpeg", ext: "jpg" },
	webp: { sharp: "webp", mime: "image/webp", ext: "webp" },
	avif: { sharp: "avif", mime: "image/avif", ext: "avif" },
	gif: { sharp: "gif", mime: "image/gif", ext: "gif" },
	tiff: { sharp: "tiff", mime: "image/tiff", ext: "tiff" },
};

function fileExtension(name) {
	const match = String(name).toLowerCase().match(/\.([^.]+)$/);
	return match ? match[1] : "";
}

// Tell the front end which target formats a given file can become.
app.get("/api/formats", (req, res) => {
	const ext = fileExtension(req.query.filename || "");

	if (!IMAGE_INPUT_EXTENSIONS.includes(ext)) {
		return res.json({ kind: "unsupported", targets: [] });
	}

	const current = ext === "jpeg" ? "jpg" : ext === "tif" ? "tiff" : ext;
	const targets = ["png", "jpg", "webp", "avif", "gif", "tiff"].filter((t) => t !== current);

	res.json({ kind: "image", targets });
});

// Convert the uploaded file to req.body.format and stream it back as a download.
app.post("/api/convert", upload.single("file"), async (req, res, next) => {
	try {
		if (!req.file) {
			return res.status(400).json({ error: "No file received" });
		}

		const target = String(req.body.format || "").toLowerCase();
		const spec = IMAGE_TARGETS[target];

		if (!spec) {
			return res.status(400).json({ error: `Unsupported target format: ${target || "(none)"}` });
		}

		// Confirm sharp can actually read this file before converting.
		try {
			await sharp(req.file.buffer).metadata();
		} catch {
			return res.status(400).json({ error: "File is not a readable image" });
		}

		const output = await sharp(req.file.buffer).toFormat(spec.sharp).toBuffer();

		const base = req.file.originalname.replace(/\.[^.]+$/, "") || "converted";
		res.setHeader("Content-Type", spec.mime);
		res.setHeader("Content-Disposition", `attachment; filename="${base}.${spec.ext}"`);
		res.send(output);
	} catch (err) {
		next(err);
	}
});

// Accepts one file under the form field "file". Kept for quick manual testing.
app.post("/api/upload", upload.single("file"), (req, res) => {
	if (!req.file) {
		return res.status(400).json({ error: "No file received" });
	}

	const { originalname, mimetype, size } = req.file;
	res.json({
		message: "File received",
		file: { originalname, mimetype, size },
	});
});

// Multer errors (e.g. file too large) surface here as MulterError.
app.use((err, req, res, next) => {
	if (err instanceof multer.MulterError) {
		return res.status(400).json({ error: err.code });
	}

	console.error(err);
	res.status(500).json({ error: "Server error" });
});

// SPA fallback: hand any non-API, non-file request to Angular's index.html.
// Express 5 rejects a bare "*" route, so use a final catch-all middleware.
app.use((req, res) => {
	res.sendFile(path.join(browserDir, "index.html"));
});

app.listen(PORT, () => {
	console.log(`Server running on port ${PORT}`);
});
