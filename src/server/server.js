const os = require("os");
const path = require("path");
const crypto = require("crypto");
const nodeFs = require("fs");
const fs = require("fs/promises");
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { targetsFor, convert } = require("./converters");
const { JobQueue } = require("./queue");
const { JobStore, ABANDON_MS } = require("./jobs");

const app = express();
const PORT = process.env.PORT || 3000;

// One conversion at a time by default (strict FIFO). Override with an env var if
// the instance has CPU to spare. Only meaningful in a single process — see queue.js.
const CONCURRENCY = Number(process.env.CONVERT_CONCURRENCY || 1);

// Max upload size. Video needs headroom; keep an eye on the instance's disk.
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 200);

const queue = new JobQueue({ concurrency: CONCURRENCY });
const store = new JobStore();

// Uploads land on disk (streamed by multer), not in memory — overlapping
// uploads from different people must not pile up in RAM.
const uploadDir = path.join(os.tmpdir(), "a2a-uploads");
nodeFs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
	storage: multer.diskStorage({
		destination: uploadDir,
		filename: (req, file, cb) => cb(null, crypto.randomUUID() + path.extname(file.originalname)),
	}),
	limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 1 },
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

// Which target formats can a given filename convert to?
app.get("/api/formats", (req, res) => {
	res.json(targetsFor(req.query.filename || ""));
});

// Accept an upload, queue the conversion, and hand back a job id to poll.
app.post("/api/convert", upload.single("file"), (req, res) => {
	if (!req.file) {
		return res.status(400).json({ error: "No file received" });
	}

	const { kind } = targetsFor(req.file.originalname);
	if (kind === "unsupported") {
		fs.rm(req.file.path, { force: true }).catch(() => {});
		return res.status(400).json({ error: "Unsupported file type" });
	}

	const job = store.create({
		inputPath: req.file.path,
		filename: req.file.originalname,
		format: String(req.body.format || "").toLowerCase(),
		kind,
	});

	queue
		.add(job.id, async () => {
			store.update(job.id, { status: "processing", progress: 0 });
			const result = await convert({
				inputPath: job.inputPath,
				filename: job.filename,
				format: job.format,
				onProgress: (p) => store.update(job.id, { progress: p }),
			});
			store.update(job.id, { status: "done", progress: 1, result });
		})
		.catch((err) => {
			if (err && err.message === "cancelled") {
				store.update(job.id, { status: "cancelled" });
				return;
			}
			const statusCode = (err && err.status) || 500;
			store.update(job.id, { status: "error", error: (err && err.message) || "Server error", statusCode });
			if (statusCode >= 500) {
				console.error(err);
			}
		});

	res.status(202).json({ jobId: job.id });
});

// Poll a job's status. The client is expected to hit this ~1x/second; that
// doubles as the "still watching" heartbeat.
app.get("/api/jobs/:id", (req, res) => {
	const job = store.get(req.params.id);
	if (!job) {
		return res.status(404).json({ error: "Job not found" });
	}

	store.touch(job.id);

	let ahead = null;
	if (job.status === "queued") {
		const index = queue.positionOf(job.id);
		ahead = index < 0 ? 0 : index;
	}

	res.json({
		status: job.status,
		kind: job.kind,
		progress: Math.round((job.progress || 0) * 100),
		ahead,
		position: ahead === null ? null : ahead + 1,
		ready: job.status === "done",
		error: job.status === "error" ? job.error : null,
		downloadName: job.result ? job.result.downloadName : null,
	});
});

// Download the converted file.
app.get("/api/jobs/:id/download", (req, res) => {
	const job = store.get(req.params.id);
	if (!job || job.status !== "done" || !job.result) {
		return res.status(404).json({ error: "Not ready" });
	}

	res.setHeader("Content-Type", job.result.mime);
	res.setHeader("Content-Disposition", `attachment; filename="${job.result.downloadName}"`);
	res.sendFile(job.result.outputPath, (err) => {
		if (err && !res.headersSent) {
			res.status(500).end();
		}
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

// ---------------------------------------------------------------------------
// Housekeeping
// ---------------------------------------------------------------------------

// Drop abandoned jobs (client stopped polling) that are still waiting, so the
// people behind them move up. Jobs already converting are left to finish.
setInterval(() => {
	const now = Date.now();
	for (const job of store.all()) {
		if (job.status === "queued" && now - job.lastSeen > ABANDON_MS) {
			if (queue.cancel(job.id)) {
				store.update(job.id, { status: "cancelled" });
			}
		}
	}
	store.sweepExpired();
}, 10_000).unref();

app.listen(PORT, () => {
	console.log(`Server running on port ${PORT} (conversion concurrency: ${CONCURRENCY})`);
});
