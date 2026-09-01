const os = require("os");
const path = require("path");
const fs = require("fs/promises");
const zlib = require("zlib");
const { spawn } = require("child_process");
const { createReadStream, createWriteStream } = require("fs");
const { pipeline } = require("stream/promises");
const { path7za } = require("7zip-bin");
const { createExtractorFromFile } = require("node-unrar-js");

// ---------------------------------------------------------------------------
// Limits (conservative)
// ---------------------------------------------------------------------------

const MAX_TOTAL_BYTES = 500 * 1024 * 1024; // uncompressed
const MAX_ENTRIES = 5000;
const ARCHIVE_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

// What we can read. ".tar.gz" and "tgz" are both tar-then-gzip; "rar" is
// read-only (creating RAR needs a licence from RARLAB).
const ARCHIVE_INPUT_EXTENSIONS = ["zip", "7z", "rar", "tar", "gz", "tgz", "tar.gz"];

const ARCHIVE_TARGETS = {
	zip: { ext: "zip", mime: "application/zip" },
	"7z": { ext: "7z", mime: "application/x-7z-compressed" },
	tar: { ext: "tar", mime: "application/x-tar" },
	"tar.gz": { ext: "tar.gz", mime: "application/gzip" },
	gz: { ext: "gz", mime: "application/gzip" }, // single file, or falls back to tar.gz
};

const ARCHIVE_ORDER = Object.keys(ARCHIVE_TARGETS);

class ArchiveError extends Error {
	constructor(message, status = 400) {
		super(message);
		this.status = status;
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Recognise double extensions so "photos.tar.gz" reads as "tar.gz", not "gz".
function archiveExtension(name) {
	const lower = String(name).toLowerCase();
	if (lower.endsWith(".tar.gz")) return "tar.gz";
	if (lower.endsWith(".tar.bz2")) return "tar.bz2";
	if (lower.endsWith(".tar.xz")) return "tar.xz";
	const match = lower.match(/\.([^.]+)$/);
	return match ? match[1] : "";
}

// Strip a known archive extension to get the base name.
function stripArchiveExtension(name) {
	const ext = archiveExtension(name);
	if (!ext) {
		return name;
	}
	return name.slice(0, name.toLowerCase().lastIndexOf("." + ext)) || "archive";
}

function normalizeArchive(ext) {
	if (ext === "tgz") return "tar.gz";
	return ext;
}

function unsafePath(entryPath) {
	if (!entryPath) {
		return false;
	}
	const norm = entryPath.replace(/\\/g, "/");
	if (norm.startsWith("/")) return true;
	if (/^[a-zA-Z]:/.test(norm)) return true;
	return norm.split("/").some((segment) => segment === "..");
}

// ---------------------------------------------------------------------------
// 7za runner
// ---------------------------------------------------------------------------

function run7za(args, deadline, opts = {}) {
	return new Promise((resolve, reject) => {
		const timeoutMs = Math.max(1000, deadline - Date.now());
		const proc = spawn(path7za, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });

		let stdout = "";
		let stderr = "";
		let killed = false;

		const timer = setTimeout(() => {
			killed = true;
			proc.kill("SIGKILL");
		}, timeoutMs);

		proc.stdout.on("data", (d) => {
			stdout += d;
			if (stdout.length > 4_000_000) stdout = stdout.slice(-4_000_000);
		});
		proc.stderr.on("data", (d) => {
			stderr += d;
		});

		proc.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});

		proc.on("close", (code) => {
			clearTimeout(timer);
			if (killed) {
				return reject(new ArchiveError("Archive processing timed out", 504));
			}
			if (code !== 0) {
				const blob = stdout + stderr;
				if (/Wrong password|Enter password|password/i.test(blob)) {
					return reject(new ArchiveError("This archive is password-protected", 422));
				}
				return reject(new ArchiveError("Could not read the archive", 422));
			}
			resolve({ stdout, stderr });
		});
	});
}

// Inspect a `7za l -slt` listing and reject anything abusive before extracting.
function assertListingSafe(sltOutput) {
	const blocks = sltOutput.split(/\r?\n\r?\n/);
	let totalBytes = 0;
	let fileCount = 0;

	for (const block of blocks) {
		const pathMatch = block.match(/^Path = (.+)$/m);
		if (!pathMatch) continue;
		if (/^Type = /m.test(block)) continue; // archive metadata block, not an entry

		const entryPath = pathMatch[1];
		const isFolder = /^Folder = \+/m.test(block);
		const isEncrypted = /^Encrypted = \+/m.test(block);
		const sizeMatch = block.match(/^Size = (\d+)$/m);

		if (isEncrypted) {
			throw new ArchiveError("This archive is password-protected", 422);
		}
		if (unsafePath(entryPath)) {
			throw new ArchiveError("Archive contains an unsafe file path", 422);
		}
		if (!isFolder) {
			fileCount += 1;
			totalBytes += sizeMatch ? Number(sizeMatch[1]) : 0;
			if (fileCount > MAX_ENTRIES) {
				throw new ArchiveError(`Archive has too many files (limit ${MAX_ENTRIES})`, 413);
			}
			if (totalBytes > MAX_TOTAL_BYTES) {
				throw new ArchiveError("Archive is too large when uncompressed", 413);
			}
		}
	}
}

// Walk an extracted tree, drop symlinks, and re-check the real sizes.
async function assertTreeWithinLimits(dir) {
	let totalBytes = 0;
	let fileCount = 0;

	async function walk(current) {
		const entries = await fs.readdir(current, { withFileTypes: true });
		for (const entry of entries) {
			const full = path.join(current, entry.name);
			if (entry.isSymbolicLink()) {
				await fs.rm(full, { force: true });
				continue;
			}
			if (entry.isDirectory()) {
				await walk(full);
			} else if (entry.isFile()) {
				fileCount += 1;
				totalBytes += (await fs.stat(full)).size;
				if (fileCount > MAX_ENTRIES) {
					throw new ArchiveError(`Archive has too many files (limit ${MAX_ENTRIES})`, 413);
				}
				if (totalBytes > MAX_TOTAL_BYTES) {
					throw new ArchiveError("Archive is too large when uncompressed", 413);
				}
			}
		}
	}

	await walk(dir);
	if (fileCount === 0) {
		throw new ArchiveError("Archive is empty", 422);
	}
}

// ---------------------------------------------------------------------------
// Extract
// ---------------------------------------------------------------------------

async function extractTo(inputPath, inputExt, destDir, deadline) {
	if (inputExt === "rar") {
		await extractRar(inputPath, destDir);
	} else {
		await extract7z(inputPath, inputExt, destDir, deadline);
	}
}

async function extract7z(inputPath, inputExt, destDir, deadline) {
	const listing = await run7za(["l", "-slt", "-p", inputPath], deadline);
	assertListingSafe(listing.stdout);

	const xArgs = (src, out) => ["x", src, `-o${out}`, "-y", "-aoa", "-bd", "-p"];

	if (inputExt === "tar.gz" || inputExt === "tgz") {
		const midDir = await fs.mkdtemp(path.join(os.tmpdir(), "a2a-mid-"));
		try {
			await run7za(xArgs(inputPath, midDir), deadline);
			const inner = (await fs.readdir(midDir)).map((f) => path.join(midDir, f));
			const tarPath = inner.find((f) => f.toLowerCase().endsWith(".tar")) || inner[0];
			if (!tarPath) {
				throw new ArchiveError("Could not read the archive", 422);
			}
			await run7za(xArgs(tarPath, destDir), deadline);
		} finally {
			await fs.rm(midDir, { recursive: true, force: true }).catch(() => {});
		}
	} else {
		await run7za(xArgs(inputPath, destDir), deadline);
	}

	await assertTreeWithinLimits(destDir);
}

async function extractRar(inputPath, destDir) {
	let extractor;
	try {
		extractor = await createExtractorFromFile({ filepath: inputPath, targetPath: destDir });
	} catch {
		throw new ArchiveError("Could not open the RAR archive", 422);
	}

	let list;
	try {
		list = extractor.getFileList();
	} catch (err) {
		throw rarError(err);
	}

	if (list.arcHeader && list.arcHeader.flags && list.arcHeader.flags.headerEncrypted) {
		throw new ArchiveError("This archive is password-protected", 422);
	}

	let totalBytes = 0;
	let fileCount = 0;
	for (const header of list.fileHeaders) {
		if (header.flags.encrypted) {
			throw new ArchiveError("This archive is password-protected", 422);
		}
		if (unsafePath(header.name)) {
			throw new ArchiveError("Archive contains an unsafe file path", 422);
		}
		if (!header.flags.directory) {
			fileCount += 1;
			totalBytes += header.unpSize || 0;
			if (fileCount > MAX_ENTRIES) {
				throw new ArchiveError(`Archive has too many files (limit ${MAX_ENTRIES})`, 413);
			}
			if (totalBytes > MAX_TOTAL_BYTES) {
				throw new ArchiveError("Archive is too large when uncompressed", 413);
			}
		}
	}

	try {
		const { files } = extractor.extract({});
		// The generator must be consumed for files to be written to targetPath.
		for (const _entry of files) {
			void _entry;
		}
	} catch (err) {
		throw rarError(err);
	}

	await assertTreeWithinLimits(destDir);
}

function rarError(err) {
	const reason = err && err.reason;
	if (reason === "ERAR_MISSING_PASSWORD" || reason === "ERAR_BAD_PASSWORD") {
		return new ArchiveError("This archive is password-protected", 422);
	}
	if (reason === "ERAR_BAD_ARCHIVE" || reason === "ERAR_UNKNOWN_FORMAT" || reason === "ERAR_BAD_DATA") {
		return new ArchiveError("Not a valid RAR archive", 422);
	}
	return new ArchiveError("Could not extract the RAR archive", 422);
}

// ---------------------------------------------------------------------------
// Pack
// ---------------------------------------------------------------------------

function gzipFile(src, dest) {
	return pipeline(createReadStream(src), zlib.createGzip(), createWriteStream(dest));
}

async function packTarGz(workDir, outPath, deadline) {
	const tarPath = `${outPath}.tmp.tar`;
	await fs.rm(tarPath, { force: true }).catch(() => {});
	try {
		await run7za(["a", "-ttar", tarPath, "."], deadline, { cwd: workDir });
		await gzipFile(tarPath, outPath);
	} finally {
		await fs.rm(tarPath, { force: true }).catch(() => {});
	}
}

// Returns the extension actually produced (gz can fall back to tar.gz).
async function packFrom(workDir, target, outPath, deadline) {
	const entries = await fs.readdir(workDir, { withFileTypes: true });
	if (entries.length === 0) {
		throw new ArchiveError("Nothing to pack", 422);
	}

	await fs.rm(outPath, { force: true }).catch(() => {});

	if (target === "gz") {
		if (entries.length === 1 && entries[0].isFile()) {
			await gzipFile(path.join(workDir, entries[0].name), outPath);
			return "gz";
		}
		// Multiple entries can't be a single gzip stream — make a tarball first.
		await packTarGz(workDir, outPath, deadline);
		return "tar.gz";
	}

	if (target === "tar.gz") {
		await packTarGz(workDir, outPath, deadline);
		return "tar.gz";
	}

	const type = target === "7z" ? "7z" : target === "tar" ? "tar" : "zip";
	await run7za(["a", `-t${type}`, outPath, "."], deadline, { cwd: workDir });
	return type;
}

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

// Extract inputPath then repack as `target`, writing to outputPath.
async function convertArchive({ inputPath, inputExt, target, outputPath, onProgress = () => {} }) {
	if (!ARCHIVE_TARGETS[target]) {
		throw new ArchiveError(`Unsupported target format: ${target || "(none)"}`);
	}

	const deadline = Date.now() + ARCHIVE_TIMEOUT_MS;
	const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "a2a-arc-"));

	try {
		onProgress(0.05);
		await extractTo(inputPath, inputExt, workDir, deadline);
		onProgress(0.6);
		const producedExt = await packFrom(workDir, target, outputPath, deadline);
		onProgress(1);
		return { ext: producedExt };
	} finally {
		await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
	}
}

module.exports = {
	ARCHIVE_INPUT_EXTENSIONS,
	ARCHIVE_TARGETS,
	ARCHIVE_ORDER,
	ArchiveError,
	archiveExtension,
	stripArchiveExtension,
	normalizeArchive,
	convertArchive,
};
