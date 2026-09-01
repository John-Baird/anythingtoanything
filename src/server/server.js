const express = require("express");
const cors = require("cors");
const path = require("path");
const multer = require("multer");
const { targetsFor, convert } = require("./converters");

const app = express();
const PORT = process.env.PORT || 3000;

// Keep uploads in memory as a Buffer (req.file.buffer) — nothing hits disk
// (audio conversion writes its own temp file). 50 MB cap, one file per request.
const upload = multer({
	storage: multer.memoryStorage(),
	limits: { fileSize: 50 * 1024 * 1024, files: 1 },
});

app.use(cors());
app.use(express.json());

// Compiled Angular app (produced by `npm run build`).
// __dirname is src/server, so ../../ is the repo root.
const browserDir = path.join(__dirname, "..", "..", "dist", "temp-angular", "browser");

app.use(express.static(browserDir));

// ---------------------------------------------------------------------------
// Conversion API
// ---------------------------------------------------------------------------

// Tell the front end which target formats a given file can convert to.
app.get("/api/formats", (req, res) => {
	res.json(targetsFor(req.query.filename || ""));
});

// Convert the uploaded file to req.body.format and stream it back as a download.
app.post("/api/convert", upload.single("file"), async (req, res, next) => {
	try {
		if (!req.file) {
			return res.status(400).json({ error: "No file received" });
		}

		const result = await convert({
			buffer: req.file.buffer,
			filename: req.file.originalname,
			format: req.body.format,
		});

		const base = req.file.originalname.replace(/\.[^.]+$/, "") || "converted";
		res.setHeader("Content-Type", result.mime);
		res.setHeader("Content-Disposition", `attachment; filename="${base}.${result.ext}"`);
		res.send(result.buffer);
	} catch (err) {
		if (err.status) {
			return res.status(err.status).json({ error: err.message, detail: err.detail });
		}
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
