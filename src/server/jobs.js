const crypto = require("crypto");
const fs = require("fs/promises");

// Keep finished jobs (and their files) around this long so the client can still
// download the result and read the final status.
const JOB_TTL_MS = 10 * 60 * 1000;

// If the client stops polling for this long while still queued, the job is
// treated as abandoned and cancelled.
const ABANDON_MS = 30 * 1000;

class JobStore {
	constructor() {
		this.jobs = new Map();
	}

	create(data) {
		const id = crypto.randomUUID();
		const job = {
			id,
			status: "queued", // queued | processing | done | error | cancelled
			progress: 0,
			error: null,
			statusCode: null,
			result: null, // { outputPath, mime, downloadName }
			lastSeen: Date.now(),
			finishedAt: null,
			...data,
		};
		this.jobs.set(id, job);
		return job;
	}

	get(id) {
		return this.jobs.get(id);
	}

	all() {
		return [...this.jobs.values()];
	}

	// Record that the client is still watching this job.
	touch(id) {
		const job = this.jobs.get(id);
		if (job) {
			job.lastSeen = Date.now();
		}
	}

	update(id, patch) {
		const job = this.jobs.get(id);
		if (!job) {
			return;
		}
		Object.assign(job, patch);
		if (["done", "error", "cancelled"].includes(job.status) && !job.finishedAt) {
			job.finishedAt = Date.now();
		}
	}

	async remove(id) {
		const job = this.jobs.get(id);
		if (!job) {
			return;
		}
		this.jobs.delete(id);
		const paths = [job.inputPath, job.result && job.result.outputPath].filter(Boolean);
		await Promise.allSettled(paths.map((p) => fs.rm(p, { force: true })));
	}

	// Delete jobs whose TTL has expired. Call on an interval.
	sweepExpired() {
		const now = Date.now();
		for (const job of this.jobs.values()) {
			if (job.finishedAt && now - job.finishedAt > JOB_TTL_MS) {
				this.remove(job.id);
			}
		}
	}
}

module.exports = { JobStore, JOB_TTL_MS, ABANDON_MS };
