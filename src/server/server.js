const express = require("express");
const cors = require("cors");
const path = require("path");
const multer = require("multer");

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

app.get("/api/test", (req, res) => {
	res.json({
		message: "Backend works",
	});
});

// Accepts one file under the form field "file".
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
	next(err);
});

// SPA fallback: hand any non-API, non-file request to Angular's index.html.
// Express 5 rejects a bare "*" route, so use a final catch-all middleware.
app.use((req, res) => {
	res.sendFile(path.join(browserDir, "index.html"));
});

app.listen(PORT, () => {
	console.log(`Server running on port ${PORT}`);
});
